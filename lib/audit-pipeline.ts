import { callClaudeJSON, ClaudeJsonResult } from "./anthropic";
import { callLLMJSON, availableProviders, Provider } from "./llm";
import {
  CLAIM_EXTRACTION_PROMPT,
  CITATION_EXTRACTION_PROMPT,
  MISSING_DATA_PROMPT,
  RISK_SYNTHESIS_PROMPT,
  SAFE_REWRITE_PROMPT,
  CONFIDENCE_FACTORS_PROMPT,
  EVIDENCE_RELEVANCE_PROMPT,
} from "./prompts";
import { extractCitations, extractDrugCandidates } from "./extract";
import { verifyByPmid as pubmedByPmid, verifyByCitation as pubmedByCit, PubMedResult } from "./pubmed";
import { verifyByDoi as crByDoi, verifyByQuery as crByQuery, CrossRefResult } from "./crossref";
import { verifyDrugName, RxNormResult } from "./rxnorm";

export type AuditDomain = {
  id: "citations" | "missing" | "drugs" | "risk" | "rewrite" | "evidence" | "ensemble";
  label: string;
  pill: "ok" | "warn" | "crit" | "neut";
  pillText: string;
  summary: string;
  findings: Array<{ lbl: string; title: string; src: string; sev: "critical" | "important" | "contextual" }>;
};

export type AuditEnvelope = {
  verdictTier: "no-issues" | "minor" | "significant" | "critical";
  verdictTitle: string;
  verdictBadge: string;
  reason: string;
  metaConfidence: number;
  metaLabel: "Low" | "Moderate" | "High";
  metaDrivers: string[];
  domains: AuditDomain[];
  rewrite: string;
  diagnostics: {
    durationMs: number;
    tokensIn: number;
    tokensOut: number;
    costEstimateUsd: number;
    citationsChecked: number;
    citationsVerified: number;
    citationsNotFound: number;
    drugsChecked: number;
    drugsVerified: number;
    llmFailures: string[];
  };
  mode: "live" | "demo";
};

function cost(inTok: number, outTok: number): number {
  return (inTok / 1_000_000) * 1.0 + (outTok / 1_000_000) * 5.0;
}

function sanitizeForPrompt(s: string): string {
  return s
    .replace(/"""/g, "' ' '")
    .replace(/```/g, "` ` `")
    .replace(/[\u200B-\u200F\u202A-\u202E]/g, "");
}

async function verifyOneCitation(c: ReturnType<typeof extractCitations>[number]) {
  if (c.pmid) {
    const pm = await pubmedByPmid(c.pmid);
    return { raw: c.raw, pubmed: pm as PubMedResult, crossref: undefined as CrossRefResult | undefined };
  }
  if (c.doi) {
    const cr = await crByDoi(c.doi);
    return { raw: c.raw, pubmed: undefined as PubMedResult | undefined, crossref: cr };
  }
  if (c.author && c.year) {
    const [pm, cr] = await Promise.all([
      pubmedByCit({ author: c.author, year: c.year, journal: c.journal, title: c.title }),
      crByQuery({ author: c.author, year: c.year, journal: c.journal, title: c.title }),
    ]);
    return { raw: c.raw, pubmed: pm, crossref: cr };
  }
  return { raw: c.raw, pubmed: undefined as PubMedResult | undefined, crossref: undefined as CrossRefResult | undefined };
}

async function verifyDrugs(text: string) {
  const candidates = extractDrugCandidates(text);
  if (!candidates.length) return [];
  return Promise.all(candidates.map(async (n) => ({ name: n, r: await verifyDrugName(n) })));
}

// --- Self-consistency ensemble proxy ---------------------------------------
// Two real, independent claim-extraction passes at different temperatures.
// We compare the set of claim categories and the in_corpus verdict to produce
// a concrete agreement score (Jaccard on category multiset + verdict match).
function claimCategorySet(data: any): string[] {
  const claims = Array.isArray(data?.claims) ? data.claims : [];
  return claims.map((c: any) => String(c?.category ?? "")).filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a), setB = new Set(b);
  const inter = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size || 1;
  return inter / union;
}

export type EnsemblePass = { provider: Provider | "claude-hot"; label: string; categories: string[]; corpus: boolean; ok: boolean };

// Real multi-model ensemble agreement. Given 2+ passes (from different models,
// or temperature-varied Claude passes as a fallback), compute mean pairwise
// category overlap + corpus-verdict consensus into a single 0-100 score.
function ensembleAgreement(passes: EnsemblePass[]): { score: number; notes: string[]; passes: EnsemblePass[] } {
  const ok = passes.filter((p) => p.ok);
  const notes: string[] = [];
  if (ok.length < 2) {
    return { score: 0, notes: ["Fewer than two model passes succeeded; agreement cannot be computed."], passes };
  }
  // Mean pairwise Jaccard on claim categories.
  let sum = 0, pairs = 0;
  for (let i = 0; i < ok.length; i++)
    for (let j = i + 1; j < ok.length; j++) { sum += jaccard(ok[i].categories, ok[j].categories); pairs++; }
  const meanJaccard = pairs ? sum / pairs : 0;
  // Corpus-verdict consensus: fraction agreeing with the majority verdict.
  const corpusVotes = ok.filter((p) => p.corpus).length;
  const corpusConsensus = Math.max(corpusVotes, ok.length - corpusVotes) / ok.length;
  const score = Math.max(0, Math.min(100, Math.round(meanJaccard * 70 + corpusConsensus * 30)));
  notes.push(`Models compared: ${ok.map((p) => p.label).join(", ")}.`);
  notes.push(`Mean claim-category overlap: ${(meanJaccard * 100).toFixed(0)}%.`);
  notes.push(
    corpusConsensus === 1
      ? "All models agree on corpus fit."
      : `Corpus-fit consensus: ${(corpusConsensus * 100).toFixed(0)}% (models disagree).`
  );
  for (const p of ok) notes.push(`${p.label}: ${p.categories.length} claim categories.`);
  return { score, notes, passes };
}

function toPass(provider: Provider | "claude-hot", label: string, r: { ok: boolean; data?: any } | null): EnsemblePass {
  const ok = !!r?.ok && !!r?.data;
  return {
    provider,
    label,
    ok,
    categories: ok ? claimCategorySet(r!.data) : [],
    corpus: ok ? !!r!.data?.specialty_match?.in_corpus : false,
  };
}

// --- Evidence relevance ----------------------------------------------------
// For citations that verified against PubMed WITH an abstract, score whether
// the abstract actually supports the most relevant high-stakes claim.
type EvidenceVerdict = {
  claim_id: string;
  citation_raw: string;
  verdict: string;
  alignment_0_100: number;
  rationale: string;
};

async function scoreEvidence(
  claim: any,
  citationVerifs: Awaited<ReturnType<typeof verifyOneCitation>>[],
  accum: (u: { input_tokens: number; output_tokens: number }) => void
): Promise<EvidenceVerdict[]> {
  const claims: any[] = Array.isArray(claim?.claims) ? claim.claims : [];
  if (!claims.length) return [];
  const highStakes = claims.filter((c) =>
    ["therapeutic", "pharmacological", "procedural", "diagnostic"].includes(c?.category)
  );
  const pool = (highStakes.length ? highStakes : claims).slice(0, 6);
  // Only citations with a real PubMed abstract are worth scoring.
  const withAbstract = citationVerifs
    .filter((v) => v.pubmed?.status === "found" && (v.pubmed as any)?.abstract)
    .slice(0, 4);
  if (!withAbstract.length) return [];
  const tasks: Promise<EvidenceVerdict | null>[] = [];
  for (const v of withAbstract) {
    const pm = v.pubmed as Extract<PubMedResult, { status: "found" }>;
    // Pair each abstract with the single most relevant claim (first in priority pool).
    const target = pool[0];
    tasks.push(
      (async () => {
        const res = await callClaudeJSON<any>(
          EVIDENCE_RELEVANCE_PROMPT(
            { id: target.id, text: target.text, category: target.category },
            { id: v.raw, raw_text: v.raw, abstract: pm.abstract ?? null, title: pm.title ?? null }
          ),
          { temperature: 0.1, maxTokens: 700 }
        );
        if (!res.ok) return null;
        accum(res.usage);
        const d: any = res.data;
        return {
          claim_id: target.id,
          citation_raw: v.raw,
          verdict: String(d?.verdict ?? "insufficient_evidence"),
          alignment_0_100: Number(d?.alignment_0_100 ?? 0),
          rationale: String(d?.rationale ?? ""),
        } as EvidenceVerdict;
      })()
    );
  }
  const settled = await Promise.all(tasks);
  return settled.filter((x): x is EvidenceVerdict => x !== null);
}

export async function runAudit(input: string, opts: { specialty?: "neuro" | "other" } = {}): Promise<AuditEnvelope> {
  const t0 = Date.now();
  let tokensIn = 0;
  let tokensOut = 0;
  const accum = (u: { input_tokens: number; output_tokens: number }) => { tokensIn += u.input_tokens; tokensOut += u.output_tokens; };

  const safe = sanitizeForPrompt(input);
  const safeShort = safe.slice(0, 8000);
  const preCitations = extractCitations(safe);

  // Decide the ensemble composition. Claude is always the primary auditor.
  // If OpenAI/Gemini keys are configured, they run real independent claim passes
  // (a true 3-model ensemble). If not, we fall back to a second temperature-varied
  // Claude pass so self-consistency still works on a single key.
  const providers = availableProviders();
  const extraProviders = providers.filter((p) => p !== "claude"); // gpt, gemini if present
  const useMultiModel = extraProviders.length > 0;

  const claimPrompt = CLAIM_EXTRACTION_PROMPT(safe);
  const [claim, claimHot, citationLLM, missing, citationVerifs, drugVerifs, ...extraPasses] = await Promise.all([
    callClaudeJSON<any>(claimPrompt, { temperature: 0.2, maxTokens: 1800 }),
    // Hot Claude pass: used for self-consistency when no other model is available.
    useMultiModel
      ? Promise.resolve({ ok: false, reason: "empty" as const })
      : callClaudeJSON<any>(claimPrompt, { temperature: 0.7, maxTokens: 1100, retryOnParse: false }),
    callClaudeJSON<any>(CITATION_EXTRACTION_PROMPT(safe), { temperature: 0.2, maxTokens: 1200 }),
    callClaudeJSON<any>(MISSING_DATA_PROMPT(safe), { temperature: 0.2, maxTokens: 1200 }),
    Promise.all(preCitations.map(verifyOneCitation)),
    verifyDrugs(safe),
    // Independent passes from the other providers (parallel, lighter, no parse-retry).
    ...extraProviders.map((p) => callLLMJSON<any>(p, claimPrompt, { temperature: 0.2, maxTokens: 1100, retryOnParse: false })),
  ]);
  for (const r of [claim, claimHot, citationLLM, missing]) if (r.ok && "usage" in r) accum(r.usage);
  for (const r of extraPasses) if (r.ok && "usage" in r) accum(r.usage);

  const passA = claim.ok ? claim.data : null;

  // Build the ensemble pass list.
  const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", gpt: "GPT-4o-mini", gemini: "Gemini", "claude-hot": "Claude (temp 0.7)" };
  const passes: EnsemblePass[] = [toPass("claude", PROVIDER_LABEL.claude, claim)];
  if (useMultiModel) {
    extraProviders.forEach((p, i) => passes.push(toPass(p, PROVIDER_LABEL[p] ?? p, extraPasses[i])));
  } else {
    passes.push(toPass("claude-hot", PROVIDER_LABEL["claude-hot"], claimHot));
  }
  const agreement = ensembleAgreement(passes);
  // Second claim output for the confidence prompt's pass-comparison: prefer the
  // first successful alternate-model pass, else the hot Claude pass.
  const altRaw = useMultiModel
    ? (extraPasses.find((r) => r.ok) as any)?.data ?? null
    : (claimHot.ok ? (claimHot as any).data : null);

  // Evidence relevance: score verified abstracts against the highest-stakes claim.
  const evidence = await scoreEvidence(passA, citationVerifs, accum);

  // specialty_match is informational only and must not depress confidence, so the
  // fallback confidence is neutral (75) regardless of in/out of corpus.
  const specialtyMatch = claim.ok && (claim.data as any)?.specialty_match
    ? { ...(claim.data as any).specialty_match, confidence_0_100: 75 }
    : { in_corpus: opts.specialty !== "other", confidence_0_100: 75 };

  const [synth, rewrite, conf] = await Promise.all([
    callClaudeJSON<any>(RISK_SYNTHESIS_PROMPT({
      input: safeShort.slice(0, 4000),
      claims: claim.ok ? claim.data : null,
      citations: {
        llm: citationLLM.ok ? citationLLM.data : null,
        verification: citationVerifs.map((c) => ({
          raw: c.raw,
          pubmed: c.pubmed?.status,
          crossref: c.crossref?.status,
        })),
      },
      evidence,
      missing_data: missing.ok ? missing.data : null,
      specialty_match: specialtyMatch,
    }), { temperature: 0.2, maxTokens: 1200 }),
    callClaudeJSON<any>(SAFE_REWRITE_PROMPT({
      input: safeShort,
      findings: null,
      citations: citationVerifs.map((c) => ({ raw: c.raw, pubmed: c.pubmed?.status, crossref: c.crossref?.status })),
      specialty_match: { in_corpus: specialtyMatch.in_corpus },
    }), { temperature: 0.2, maxTokens: 1500 }),
    callClaudeJSON<any>(CONFIDENCE_FACTORS_PROMPT({
      pass_a: passA,
      pass_b: altRaw,
      citations: citationVerifs.map((c) => ({ raw: c.raw, pubmed: c.pubmed?.status, crossref: c.crossref?.status })),
      evidence,
      specialty_match: specialtyMatch,
    }), { temperature: 0.1, maxTokens: 800 }),
  ]);
  if (synth.ok) accum(synth.usage);
  if (rewrite.ok) accum(rewrite.usage);
  if (conf.ok) accum(conf.usage);

  // Diagnostics: capture WHY any LLM call failed so failures are visible in the
  // UI instead of silently collapsing to safe defaults (api / parse / empty).
  const diag = (name: string, r: { ok: boolean; reason?: string; detail?: string } | null): string | null =>
    !r || r.ok ? null : `${name}: ${r.reason}${r.detail ? " \u2014 " + r.detail.slice(0, 140) : ""}`;
  const diagnostics = [
    diag("claim_primary(claude)", claim),
    ...(useMultiModel
      ? extraProviders.map((p, i) => diag(`claim_ensemble(${p})`, extraPasses[i] as any))
      : [diag("claim_selfconsistency(claude-hot)", claimHot as any)]),
    diag("citations", citationLLM),
    diag("missing_data", missing),
    diag("risk_synthesis", synth),
    diag("safe_rewrite", rewrite),
    diag("confidence", conf),
  ].filter((x): x is string => x !== null);

  return compose({
    diagnostics,
    multiModel: useMultiModel,
    synth: synth.ok ? synth.data : null,
    synthOk: synth.ok,
    conf: conf.ok ? conf.data : null,
    rewrite: rewrite.ok ? rewrite.data : null,
    rewriteOk: rewrite.ok,
    citationVerifs,
    missing: missing.ok ? missing.data : null,
    drugVerifs,
    claim: claim.ok ? claim.data : null,
    specialtyMatch,
    agreement,
    evidence,
    durationMs: Date.now() - t0,
    tokensIn,
    tokensOut,
  });
}

function compose(a: {
  diagnostics: string[];
  multiModel: boolean;
  synth: any; synthOk: boolean; conf: any; rewrite: any; rewriteOk: boolean;
  citationVerifs: Awaited<ReturnType<typeof verifyOneCitation>>[];
  missing: any; drugVerifs: { name: string; r: RxNormResult }[];
  claim: any; specialtyMatch: { in_corpus: boolean; confidence_0_100: number };
  agreement: { score: number; notes: string[]; passes: EnsemblePass[] };
  evidence: EvidenceVerdict[];
  durationMs: number; tokensIn: number; tokensOut: number;
}): AuditEnvelope {
  let tier: "critical_issues" | "significant_concerns" | "minor_concerns" | "no_issues_detected" =
    a.synth?.tier ?? "critical_issues";
  const overrides: string[] = [];
  if (!a.synthOk) { tier = "critical_issues"; overrides.push("Risk-synthesis step failed; treat as unaudited."); }
  // NOTE: out-of-corpus content no longer escalates the risk tier. Verification
  // (PubMed/CrossRef/RxNorm + LLM) works the same across specialties, so domain
  // alone is not a safety concern. We surface it as an informational note only.
  const verified = a.citationVerifs.filter((v) => v.pubmed?.status === "found" || v.crossref?.status === "found");
  const notFound = a.citationVerifs.filter((v) => (v.pubmed?.status === "not_found" || !v.pubmed) && (v.crossref?.status === "not_found" || !v.crossref));
  const hasHighStakes = Array.isArray(a.claim?.claims) && a.claim.claims.some((c: any) => ["therapeutic","pharmacological","procedural"].includes(c.category));
  if (hasHighStakes && verified.length === 0 && tier === "no_issues_detected") {
    tier = "significant_concerns"; overrides.push("High-stakes claims with zero verifiable citations.");
  }
  // Evidence-relevance escalation: a contradicted citation is a critical signal.
  const contradicted = a.evidence.filter((e) => e.verdict === "contradicted");
  const unsupported = a.evidence.filter((e) => e.verdict === "unsupported");
  if (contradicted.length > 0 && tier !== "critical_issues") {
    tier = "critical_issues";
    overrides.push("A cited abstract contradicts the claim it was used to support.");
  } else if (unsupported.length > 0 && (tier === "no_issues_detected" || tier === "minor_concerns")) {
    tier = "significant_concerns";
    overrides.push("A cited source does not actually support its claim.");
  }
  // Low ensemble agreement is a self-consistency red flag.
  if (a.agreement.score < 40 && (tier === "no_issues_detected")) {
    tier = "minor_concerns";
    overrides.push(a.multiModel ? "The ensemble models disagreed substantially." : "The two self-consistency passes disagreed substantially.");
  }

  const tierMap = {
    critical_issues: { v: "critical" as const, b: "CRITICAL ISSUES", t: "Critical issues" },
    significant_concerns: { v: "significant" as const, b: "SIGNIFICANT CONCERNS", t: "Significant concerns" },
    minor_concerns: { v: "minor" as const, b: "MINOR CONCERNS", t: "Minor concerns" },
    no_issues_detected: { v: "no-issues" as const, b: "NO ISSUES DETECTED", t: "No critical issues detected on these specific checks" },
  };
  const tt = tierMap[tier];

  const citationFindings: AuditDomain["findings"] = [
    ...notFound.map((v) => ({ lbl: "NOT FOUND", title: v.raw, src: "No record matched in PubMed or CrossRef.", sev: "critical" as const })),
    ...verified.map((v) => {
      const pm = v.pubmed?.status === "found" ? v.pubmed : undefined;
      const cr = v.crossref?.status === "found" ? v.crossref : undefined;
      const title = pm?.title || cr?.title || v.raw;
      const meta = pm ? "Verified via PubMed (PMID " + pm.pmid + ", " + pm.journal + ", " + pm.year + ")."
        : cr ? "Verified via CrossRef (DOI " + cr.doi + ", " + cr.journal + ", " + cr.year + ")." : "Verified.";
      return { lbl: "VERIFIED", title, src: meta, sev: "contextual" as const };
    }),
  ];

  const missingItems: any[] = a.missing?.missing_items ?? [];
  const missingFindings: AuditDomain["findings"] = missingItems.map((m) => ({
    lbl: String(m.severity || "contextual").toUpperCase(),
    title: m.item || (m.category ? String(m.category).replace(/_/g, " ") : "Missing data item"),
    src: m.why_it_matters || "",
    sev: m.severity || "contextual",
  }));
  const missingCrit = missingItems.filter((m) => m.severity === "critical").length;

  const drugFindings: AuditDomain["findings"] = a.drugVerifs.map((d) => ({
    lbl: d.r.status === "found" ? "RESOLVED" : d.r.status === "not_found" ? "NOT IN RXNORM" : "ERROR",
    title: d.name,
    src: d.r.status === "found" ? "Match: " + d.r.name + " (RxCUI " + d.r.rxcui + ")"
      : d.r.status === "not_found" ? "Not in RxNorm. May be a non-medication token in medication context."
      : "RxNorm lookup failed.",
    sev: d.r.status === "not_found" ? "important" : "contextual",
  }));

  const citationsPill: AuditDomain["pill"] = notFound.length > 0 ? "crit" : verified.length > 0 ? "ok" : "neut";
  const drugCrit = a.drugVerifs.filter((d) => d.r.status === "not_found").length;
  const drugsPill: AuditDomain["pill"] = drugCrit > 0 ? "warn" : a.drugVerifs.length > 0 ? "ok" : "neut";
  const missingPill: AuditDomain["pill"] = missingCrit > 0 ? "crit" : missingItems.length > 0 ? "warn" : "neut";

  const domains: AuditDomain[] = [
    {
      id: "citations", label: "Citations", pill: citationsPill,
      pillText: notFound.length ? notFound.length + " NOT FOUND" : verified.length ? verified.length + " VERIFIED" : "NONE FOUND",
      summary: verified.length + " of " + a.citationVerifs.length + " citations verified deterministically against PubMed/CrossRef.",
      findings: citationFindings,
    },
    {
      id: "missing", label: "Missing data", pill: missingPill,
      pillText: missingCrit > 0 ? missingCrit + " CRITICAL" : missingItems.length ? "REVIEW" : "NONE FLAGGED",
      summary: missingItems.length ? missingItems.length + " categories of patient data flagged." : "No critical patient-data gaps surfaced.",
      findings: missingFindings,
    },
    {
      id: "drugs", label: "Drug name verification", pill: drugsPill,
      pillText: drugCrit > 0 ? drugCrit + " UNRESOLVED" : a.drugVerifs.length > 0 ? "VERIFIED" : "NONE FOUND",
      summary: a.drugVerifs.length ? a.drugVerifs.length + " medication candidates resolved against RxNorm." : "No medication tokens detected.",
      findings: drugFindings,
    },
    {
      id: "risk", label: "Risk synthesis",
      pill: tier === "critical_issues" ? "crit" : tier === "significant_concerns" ? "warn" : tier === "minor_concerns" ? "warn" : "ok",
      pillText: tt.b,
      summary: a.synth?.tier_rationale || "Tier driven by citation, missing-data, and drug findings.",
      findings: (a.synth?.top_findings || []).slice(0, 6).map((f: any) => ({
        lbl: String(f.category || "FINDING").replace(/_/g, " ").toUpperCase(),
        title: f.summary || "Finding",
        src: f.linked_claim_ids?.length ? "Linked claims: " + f.linked_claim_ids.join(", ") : "",
        sev: f.severity === "significant" ? "important" : (f.severity || "important"),
      })),
    },
    {
      id: "evidence", label: "Evidence relevance",
      pill: contradicted.length ? "crit" : unsupported.length ? "warn" : a.evidence.length ? "ok" : "neut",
      pillText: contradicted.length ? contradicted.length + " CONTRADICTED"
        : unsupported.length ? unsupported.length + " UNSUPPORTED"
        : a.evidence.length ? a.evidence.length + " CHECKED" : "NO ABSTRACTS",
      summary: a.evidence.length
        ? a.evidence.length + " verified abstract(s) scored against the claim they support."
        : "No verified citations had retrievable abstracts to score.",
      findings: a.evidence.map((e) => ({
        lbl: e.verdict.replace(/_/g, " ").toUpperCase(),
        title: e.citation_raw,
        src: (e.rationale || "") + "  (alignment " + e.alignment_0_100 + "/100, claim " + e.claim_id + ")",
        sev: e.verdict === "contradicted" ? "critical" as const
          : e.verdict === "unsupported" || e.verdict === "partially_supported" ? "important" as const
          : "contextual" as const,
      })),
    },
    {
      id: "ensemble",
      label: a.multiModel ? "Model agreement (multi-model ensemble)" : "Model agreement (self-consistency)",
      pill: a.agreement.score >= 70 ? "ok" : a.agreement.score >= 40 ? "warn" : "crit",
      pillText: a.agreement.score + "% AGREEMENT",
      summary: a.multiModel
        ? `Independent claim extraction across ${a.agreement.passes.filter((p) => p.ok).length} models, compared for consensus.`
        : "Two independent Claude passes (temp 0.2 vs 0.7) compared for self-consistency.",
      findings: a.agreement.notes.map((n, i) => ({
        lbl: i === 0 ? "MODELS" : "COMPARISON",
        title: n,
        src: i === 0 ? "Lower agreement suggests the source content is ambiguous or that models genuinely diverge." : "",
        sev: a.agreement.score < 40 ? "important" as const : "contextual" as const,
      })),
    },
  ];

  const factors = a.conf?.factors ?? {};
  const fScore = (k: string): number | string => factors?.[k]?.score ?? factors?.[k] ?? "n/a";
  const confidence: number = a.conf?.overall_confidence_0_100 ?? 60;
  const drivers: string[] = [
    "Evidence coverage: " + fScore("evidence_coverage"),
    "Citation verifiability: " + fScore("citation_verifiability"),
    "Ensemble agreement: " + a.agreement.score + "%",
  ];
  // Specialty is shown as a neutral context note, never as a confidence penalty.
  if (!a.specialtyMatch.in_corpus) drivers.push("Specialty: outside neuro/spine corpus (informational; does not lower confidence).");
  if (contradicted.length) drivers.push(contradicted.length + " cited abstract(s) contradict their claim.");
  // If LLM-judgment calls failed, say so plainly in the drivers — this is why
  // factors read "n/a" and the rewrite/agreement are absent.
  if (a.diagnostics.length) {
    drivers.push(a.diagnostics.length + " model call(s) failed: " + a.diagnostics.join("; "));
  }
  if (a.conf?.abstain_recommended && a.conf?.abstention_message) drivers.push("Abstain advised: " + a.conf.abstention_message);
  overrides.forEach((o) => drivers.unshift("Composer override: " + o));

  const metaLabel: "Low" | "Moderate" | "High" = confidence >= 75 ? "High" : confidence >= 50 ? "Moderate" : "Low";
  const reason = a.synth?.tier_rationale || (notFound.length + " unverifiable citation(s), " + missingCrit + " critical missing-data item(s).");

  return {
    verdictTier: tt.v,
    verdictTitle: tt.t,
    verdictBadge: tt.b,
    reason,
    metaConfidence: confidence,
    metaLabel,
    metaDrivers: drivers.slice(0, 6),
    domains,
    rewrite: a.rewriteOk && a.rewrite?.rewritten_text
      ? a.rewrite.rewritten_text
      : "[Safe rewrite could not be generated. The original input is not shown here intentionally; absence of a rewrite is not approval.]",
    diagnostics: {
      durationMs: a.durationMs,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      costEstimateUsd: Number(cost(a.tokensIn, a.tokensOut).toFixed(4)),
      citationsChecked: a.citationVerifs.length,
      citationsVerified: verified.length,
      citationsNotFound: notFound.length,
      drugsChecked: a.drugVerifs.length,
      drugsVerified: a.drugVerifs.filter((d) => d.r.status === "found").length,
      llmFailures: a.diagnostics,
    },
    mode: "live",
  };
}
