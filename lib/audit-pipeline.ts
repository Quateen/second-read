import { callClaudeJSON } from "./anthropic";
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

function ensembleAgreement(passA: any, passB: any): { score: number; notes: string[] } {
  const notes: string[] = [];
  if (!passA || !passB) {
    return { score: 0, notes: ["One or both self-consistency passes failed to parse."] };
  }
  const a = claimCategorySet(passA);
  const b = claimCategorySet(passB);
  const setA = new Set(a);
  const setB = new Set(b);
  const inter = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size || 1;
  const jaccard = inter / union;
  const countDelta = Math.abs(a.length - b.length);
  const corpusA = !!passA?.specialty_match?.in_corpus;
  const corpusB = !!passB?.specialty_match?.in_corpus;
  const corpusMatch = corpusA === corpusB;
  notes.push(`Claim count: pass A ${a.length}, pass B ${b.length} (\u0394 ${countDelta}).`);
  notes.push(`Category overlap (Jaccard): ${(jaccard * 100).toFixed(0)}%.`);
  notes.push(corpusMatch ? "Both passes agree on corpus fit." : "Passes DISAGREE on corpus fit.");
  // Weighted: 70% category overlap, 30% corpus-verdict agreement, small penalty for count drift.
  let score = jaccard * 70 + (corpusMatch ? 30 : 0);
  score -= Math.min(countDelta, 5) * 2;
  return { score: Math.max(0, Math.min(100, Math.round(score))), notes };
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

  // claimB is a second, independent claim-extraction pass at a higher temperature.
  // Together with `claim` (low temp) it forms a real self-consistency ensemble.
  const [claim, claimB, citationLLM, missing, citationVerifs, drugVerifs] = await Promise.all([
    callClaudeJSON<any>(CLAIM_EXTRACTION_PROMPT(safe), { temperature: 0.2, maxTokens: 1800 }),
    callClaudeJSON<any>(CLAIM_EXTRACTION_PROMPT(safe), { temperature: 0.7, maxTokens: 1800 }),
    callClaudeJSON<any>(CITATION_EXTRACTION_PROMPT(safe), { temperature: 0.2, maxTokens: 1200 }),
    callClaudeJSON<any>(MISSING_DATA_PROMPT(safe), { temperature: 0.2, maxTokens: 1200 }),
    Promise.all(preCitations.map(verifyOneCitation)),
    verifyDrugs(safe),
  ]);
  for (const r of [claim, claimB, citationLLM, missing]) if (r.ok) accum(r.usage);

  const passA = claim.ok ? claim.data : null;
  const passB = claimB.ok ? claimB.data : null;
  const agreement = ensembleAgreement(passA, passB);

  // Evidence relevance: score verified abstracts against the highest-stakes claim.
  const evidence = await scoreEvidence(passA, citationVerifs, accum);

  const specialtyMatch = claim.ok && (claim.data as any)?.specialty_match
    ? (claim.data as any).specialty_match
    : { in_corpus: opts.specialty !== "other", confidence_0_100: opts.specialty === "other" ? 30 : 75 };

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
      pass_b: passB,
      citations: citationVerifs.map((c) => ({ raw: c.raw, pubmed: c.pubmed?.status, crossref: c.crossref?.status })),
      evidence,
      specialty_match: specialtyMatch,
    }), { temperature: 0.1, maxTokens: 800 }),
  ]);
  if (synth.ok) accum(synth.usage);
  if (rewrite.ok) accum(rewrite.usage);
  if (conf.ok) accum(conf.usage);

  return compose({
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
  synth: any; synthOk: boolean; conf: any; rewrite: any; rewriteOk: boolean;
  citationVerifs: Awaited<ReturnType<typeof verifyOneCitation>>[];
  missing: any; drugVerifs: { name: string; r: RxNormResult }[];
  claim: any; specialtyMatch: { in_corpus: boolean; confidence_0_100: number };
  agreement: { score: number; notes: string[] };
  evidence: EvidenceVerdict[];
  durationMs: number; tokensIn: number; tokensOut: number;
}): AuditEnvelope {
  let tier: "critical_issues" | "significant_concerns" | "minor_concerns" | "no_issues_detected" =
    a.synth?.tier ?? "critical_issues";
  const overrides: string[] = [];
  if (!a.synthOk) { tier = "critical_issues"; overrides.push("Risk-synthesis step failed; treat as unaudited."); }
  if (!a.specialtyMatch.in_corpus && (tier === "no_issues_detected" || tier === "minor_concerns")) {
    tier = "significant_concerns"; overrides.push("Content is outside v1 neuro/spine corpus.");
  }
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
    overrides.push("The two self-consistency passes disagreed substantially.");
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
      id: "ensemble", label: "Model agreement (self-consistency)",
      pill: a.agreement.score >= 70 ? "ok" : a.agreement.score >= 40 ? "warn" : "crit",
      pillText: a.agreement.score + "% AGREEMENT",
      summary: "Two independent claim-extraction passes (temp 0.2 vs 0.7) compared for self-consistency.",
      findings: a.agreement.notes.map((n, i) => ({
        lbl: "PASS COMPARISON",
        title: n,
        src: i === 0 ? "A larger gap suggests the source content is ambiguous or unstable." : "",
        sev: a.agreement.score < 40 ? "important" as const : "contextual" as const,
      })),
    },
  ];

  const factors = a.conf?.factors ?? {};
  const fScore = (k: string): number | string => factors?.[k]?.score ?? factors?.[k] ?? "n/a";
  const confidence: number = a.conf?.overall_confidence_0_100 ?? 60;
  const drivers: string[] = [
    "Specialty match: " + fScore("specialty_match"),
    "Evidence coverage: " + fScore("evidence_coverage"),
    "Citation verifiability: " + fScore("citation_verifiability"),
    "Ensemble agreement: " + a.agreement.score + "%",
  ];
  if (contradicted.length) drivers.push(contradicted.length + " cited abstract(s) contradict their claim.");
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
    },
    mode: "live",
  };
}
