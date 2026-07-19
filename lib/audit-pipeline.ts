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
import { extractCitations, extractDrugCandidates, ExtractedCitation } from "./extract";
import { verifyByPmid as pubmedByPmid, verifyByCitation as pubmedByCit, PubMedResult } from "./pubmed";
import { verifyByDoi as crByDoi, verifyByQuery as crByQuery, CrossRefResult } from "./crossref";
import { verifyDrugName, RxNormResult } from "./rxnorm";
import { tierFromSynth, escalateTier, SynthTier } from "./tier";
import { runQuorum, decideFinalTier, agreementMode, TierVote, AgreementMode } from "./ensemble";

// High-stakes claim categories: acting on one without support/verification is a safety concern.
// Shared by evidence scoring and the zero-citation escalation so the two lists never drift.
const HIGH_STAKES_CATEGORIES = ["therapeutic", "pharmacological", "procedural", "diagnostic"] as const;

export type AuditDomain = {
  id: "citations" | "missing" | "drugs" | "risk" | "rewrite" | "evidence" | "ensemble";
  label: string;
  pill: "ok" | "warn" | "crit" | "neut";
  pillText: string;
  summary: string;
  findings: Array<{ lbl: string; title: string; src: string; sev: "critical" | "important" | "contextual" }>;
};

// One event in the "orchestration theater" stream — every event reflects a REAL pipeline action.
export type AuditEvent = {
  ts: number;                       // ms since audit start
  kind: "step" | "voter" | "verifier" | "finding" | "verdict";
  actor: string;                    // orchestrator | claude | gpt | gemini | pubmed | crossref | rxnorm | ...
  status: string;                   // start | ok | fail | flag | cleared | noted | vote:<tier>
  detail: string;
  findingId?: string;
};

export type AuditEnvelope = {
  verdictTier: "no-issues" | "minor" | "significant" | "critical" | "incomplete";
  verdictTitle: string;
  verdictBadge: string;
  reason: string;
  metaConfidence: number;
  metaLabel: "Low" | "Moderate" | "High";
  metaDrivers: string[];
  // Ensemble disclosure (truthful): the real mode + per-provider tier votes + fail-closed flags.
  agreementMode: AgreementMode;
  disagreement: boolean;
  humanReviewFlag: boolean;
  tierVotes: TierVote[];
  events: AuditEvent[];
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
  const none = undefined as PubMedResult | undefined;
  const noneCr = undefined as CrossRefResult | undefined;
  if (c.pmid) {
    const pm = await pubmedByPmid(c.pmid);
    return { raw: c.raw, pubmed: pm as PubMedResult, crossref: noneCr, unverifiable: false };
  }
  if (c.doi) {
    const cr = await crByDoi(c.doi);
    return { raw: c.raw, pubmed: none, crossref: cr, unverifiable: false };
  }
  if (c.author && c.year) {
    // Without a journal, title, or volume there is nothing specific enough to CONFIRM or DENY the
    // citation (author+year alone matches many papers). Mark it UNVERIFIABLE rather than search and
    // report a false "NOT FOUND" — fabrication can only be asserted when we could actually look.
    if (!c.journal && !c.title && !c.volume) {
      return { raw: c.raw, pubmed: none, crossref: noneCr, unverifiable: true };
    }
    const q = { author: c.author, year: c.year, journal: c.journal, title: c.title, volume: c.volume, firstPage: c.firstPage };
    const [pm, cr] = await Promise.all([pubmedByCit(q), crByQuery(q)]);
    return { raw: c.raw, pubmed: pm, crossref: cr, unverifiable: false };
  }
  return { raw: c.raw, pubmed: none, crossref: noneCr, unverifiable: true };
}

async function verifyDrugs(text: string) {
  const candidates = extractDrugCandidates(text);
  if (!candidates.length) return [];
  return Promise.all(candidates.map(async (n) => ({ name: n, r: await verifyDrugName(n) })));
}

// --- Citation union (Fix 4) ------------------------------------------------
// Convert the LLM citation-extraction output into the same ExtractedCitation
// shape the deterministic regex produces, so both sources can be verified by
// the identical PubMed/CrossRef path.
function citationsFromLLM(llm: any): ExtractedCitation[] {
  const arr = Array.isArray(llm?.citations) ? llm.citations : [];
  const out: ExtractedCitation[] = [];
  for (const c of arr) {
    const comp = c?.components ?? {};
    const doi = typeof comp.doi === "string" && comp.doi.trim() ? comp.doi.trim() : undefined;
    const pmidRaw = comp.pmid != null ? String(comp.pmid).trim() : "";
    const pmid = /^\d{4,9}$/.test(pmidRaw) ? pmidRaw : undefined;
    const yearNum = comp.year != null ? Number(comp.year) : NaN;
    const year = Number.isFinite(yearNum) && yearNum > 1800 && yearNum < 2100 ? yearNum : undefined;
    // authors may arrive as a string OR (a common LLM deviation) an array — coerce both.
    const authorsStr = Array.isArray(comp.authors)
      ? comp.authors.filter((x: any) => typeof x === "string").join(", ")
      : typeof comp.authors === "string" ? comp.authors : "";
    const author = authorsStr.trim() ? authorsStr.split(/[,;]| and /i)[0].trim() : undefined;
    const journal = typeof comp.journal === "string" && comp.journal.trim() ? comp.journal.trim() : undefined;
    const title = typeof comp.title === "string" && comp.title.trim() ? comp.title.trim() : undefined;
    const raw = typeof c?.raw_text === "string" && c.raw_text.trim()
      ? c.raw_text.trim()
      : (doi || pmid || [author, year].filter(Boolean).join(" ")).trim();
    if (!raw) continue;
    if (doi) out.push({ raw, doi });
    else if (pmid) out.push({ raw, pmid });
    else if (author && year) out.push({ raw, author, year, journal, title });
  }
  return out;
}

function citationKey(c: ExtractedCitation): string {
  if (c.doi) return "doi:" + c.doi.toLowerCase();
  if (c.pmid) return "pmid:" + c.pmid;
  // Key on the first author's SURNAME only (first whitespace token) so the deterministic
  // extractor's "Kaplan" and the LLM extractor's "Kaplan RJ" dedupe to the same citation.
  const surname = (c.author ?? "").toLowerCase().split(/\s+/)[0];
  return "auth:" + surname + "|" + (c.year ?? "") + "|" + (c.journal ?? "").toLowerCase();
}

// Union the deterministic and LLM-surfaced citations (dedupe), capped, base first.
function mergeCitations(base: ExtractedCitation[], extra: ExtractedCitation[]): ExtractedCitation[] {
  const seen = new Set(base.map(citationKey));
  const merged = [...base];
  for (const c of extra) {
    const k = citationKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(c);
  }
  return merged.slice(0, 30);
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
    (HIGH_STAKES_CATEGORIES as readonly string[]).includes(c?.category)
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

// `opts.specialty` is accepted for API back-compat but is INERT — it does not affect scoring,
// confidence, or the tier. Verification is specialty-agnostic and specialty_match is informational.
export async function runAudit(input: string, opts: { specialty?: string } = {}): Promise<AuditEnvelope> {
  const t0 = Date.now();
  let tokensIn = 0;
  let tokensOut = 0;
  const accum = (u: { input_tokens: number; output_tokens: number }) => { tokensIn += u.input_tokens; tokensOut += u.output_tokens; };

  // Orchestration-theater event stream (Part B). Every event reflects a REAL pipeline action;
  // the client replays them. Nothing here is decorative — a problem never "animates away".
  const events: AuditEvent[] = [];
  const emit = (kind: AuditEvent["kind"], actor: string, status: string, detail: string, findingId?: string) =>
    events.push({ ts: Date.now() - t0, kind, actor, status, detail, findingId });
  emit("step", "orchestrator", "start", "Audit started");

  const safe = sanitizeForPrompt(input);
  const safeShort = safe.slice(0, 8000);
  // Bound the regex citation pass to a fixed slice so it stays linear regardless of the
  // operator-configurable MAX_AUDIT_INPUT_CHARS (VANCOUVER_RE backtracking is polynomial).
  const preCitations = extractCitations(safeShort);

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

  // A step is only usable if it parsed to the OBJECT shape its prompt specifies. The tolerant
  // extractJSON can salvage a stray array/fragment from noncompliant output; such a payload must
  // count as a FAILED step (cap confidence, don't silently disable a downstream safety check),
  // never be trusted just because JSON.parse succeeded.
  // A step is usable if it parsed to an OBJECT (arrays/primitives are mis-parses, still rejected by
  // isObj). The specific list fields (claims / citations / missing_items) are read leniently
  // downstream via `?? []`, so a normal payload isn't rejected just because a list is named/typed
  // differently — this is the same lenient shape-guard applied to synth/confidence (A5).
  const isObj = (x: any): boolean => x != null && typeof x === "object" && !Array.isArray(x);
  const claimUsable = claim.ok && isObj(claim.data);
  const citationLLMUsable = citationLLM.ok && isObj(citationLLM.data);
  const missingUsable = missing.ok && isObj(missing.data);

  const passA = claimUsable ? claim.data : null;

  // Fix 4 (union): verify any citations the LLM extractor surfaced that the
  // deterministic regex missed. The deterministic pass (citationVerifs) always
  // runs regardless of the LLM step, so verification survives an LLM failure;
  // this only ADDS net-new citations, then verifies the full union.
  const llmExtraCitations = citationLLMUsable ? citationsFromLLM(citationLLM.data) : [];
  const mergedCitations = mergeCitations(preCitations, llmExtraCitations);
  const netNewCitations = mergedCitations.slice(preCitations.length);
  const extraVerifs = netNewCitations.length
    ? await Promise.all(netNewCitations.map(verifyOneCitation))
    : [];
  const allVerifs = [...citationVerifs, ...extraVerifs];

  // Emit REAL deterministic-verification events for the theater. These reflect the actual
  // PubMed/CrossRef/RxNorm outcomes — a flagged finding is never later "cleared" (honesty guard).
  allVerifs.forEach((v, i) => {
    const fid = "cit:" + i;
    const found = v.pubmed?.status === "found" || v.crossref?.status === "found";
    emit("finding", "orchestrator", "checking", v.raw.slice(0, 90), fid);
    if (v.pubmed?.status) emit("verifier", "pubmed", v.pubmed.status === "found" ? "ok" : "fail", v.raw.slice(0, 60), fid);
    if (v.crossref?.status) emit("verifier", "crossref", v.crossref.status === "found" ? "ok" : "fail", v.raw.slice(0, 60), fid);
    // "flag" only on a genuine not_found from a reachable DB; a transient error is "noted", not fabrication.
    const hasNotFound = v.pubmed?.status === "not_found" || v.crossref?.status === "not_found";
    emit("finding", "orchestrator", found ? "cleared" : v.unverifiable ? "noted" : hasNotFound ? "flag" : "noted", v.raw.slice(0, 90), fid);
  });
  drugVerifs.forEach((d) => {
    const fid = "drug:" + d.name;
    emit("finding", "orchestrator", "checking", d.name, fid);
    emit("verifier", "rxnorm", d.r.status === "found" ? "ok" : "fail",
      d.name + (d.r.status === "found" ? " → rxcui " + (d.r as any).rxcui : ""), fid);
    emit("finding", "orchestrator", d.r.status === "found" ? "cleared" : d.r.status === "not_found" ? "flag" : "noted", d.name, fid);
  });

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
  const evidence = await scoreEvidence(passA, allVerifs, accum);

  // specialty_match is informational only and must not depress confidence, so the fallback
  // confidence is neutral (75) regardless of in/out of corpus. With the UI selector gone,
  // opts.specialty is normally undefined -> in_corpus defaults to true (neutral); it never
  // affects scoring or the tier.
  const specialtyMatch = claim.ok && (claim.data as any)?.specialty_match
    ? { ...(claim.data as any).specialty_match, confidence_0_100: 75 }
    : { in_corpus: opts.specialty !== "other", confidence_0_100: 75 };

  const synthPrompt = RISK_SYNTHESIS_PROMPT({
    input: safeShort.slice(0, 4000),
    claims: claimUsable ? claim.data : null,
    citations: {
      llm: citationLLMUsable ? citationLLM.data : null,
      verification: allVerifs.map((c) => ({ raw: c.raw, pubmed: c.pubmed?.status, crossref: c.crossref?.status })),
    },
    evidence,
    missing_data: missingUsable ? missing.data : null,
    specialty_match: specialtyMatch,
  });
  // A2/A3: the risk TIER is a categorical vote across every configured provider (Claude + GPT +
  // Gemini when their keys are set), run failsafe — parallel, per-call timeout + retry, quorum
  // timeout, circuit breaker. Rewrite + confidence stay single-voice Claude calls, in parallel.
  emit("voter", "orchestrator", "start", `risk-tier vote across ${providers.join("+")}`);
  const [synthQuorum, rewrite, conf] = await Promise.all([
    runQuorum<any>(providers, (p) => {
      emit("voter", p, "start", "risk_synthesis");
      // Headroom: Claude has no strict JSON mode and can be verbose, so 2200 could truncate its
      // synth object into a fragment with no top-level tier (-> a null vote). 3500 avoids that.
      // (retryOnParse/empty defaults on; callLLMJSON runs extractJSON + parseJSONLoose for every
      // provider, so a slightly-off Claude payload is still recovered.)
      return callLLMJSON<any>(p, synthPrompt, { temperature: 0.2, maxTokens: 3500 });
      // C1: the old 14s quorum cap STRUCTURALLY dropped Claude — Haiku generating up to 3500 synth
      // tokens takes ~18-25s, so the primary voter was cut off before returning on ~half of audits,
      // which (given fail-closed needs a COMPLETE quorum for a low tier) manufactured over-flagging.
      // maxDuration is 60s and pre-synth work is ~6-12s, so widen the window to let Claude's
      // complete vote land; still degrade honestly to 2-of-3 on a genuine >32s stall.
    }, { perCallTimeoutMs: 38000, quorumTimeoutMs: 36000 }),
    callClaudeJSON<any>(SAFE_REWRITE_PROMPT({
      input: safeShort,
      findings: null,
      citations: allVerifs.map((c) => ({ raw: c.raw, pubmed: c.pubmed?.status, crossref: c.crossref?.status })),
      specialty_match: { in_corpus: specialtyMatch.in_corpus },
    }), { temperature: 0.2, maxTokens: 1500 }),
    callClaudeJSON<any>(CONFIDENCE_FACTORS_PROMPT({
      pass_a: passA,
      pass_b: altRaw,
      citations: allVerifs.map((c) => ({ raw: c.raw, pubmed: c.pubmed?.status, crossref: c.crossref?.status })),
      evidence,
      specialty_match: specialtyMatch,
      // The confidence schema is the largest (5 nested factor objects + drivers); 800 tokens can
      // truncate it into invalid JSON, so give it room.
    }), { temperature: 0.1, maxTokens: 1500 }),
  ]);
  if (rewrite.ok) accum(rewrite.usage);
  if (conf.ok) accum(conf.usage);

  // Primary synth (rationale/findings) = Claude's vote, else the first provider that returned.
  const synthResults = synthQuorum.results;
  const primarySynthData = synthResults.find((r) => r.provider === "claude" && r.ok && isObj(r.data))?.data
    ?? synthResults.find((r) => r.ok && isObj(r.data))?.data ?? null;
  const synth: { ok: boolean; data: any; reason?: string } = primarySynthData
    ? { ok: true, data: primarySynthData }
    : { ok: false, data: null, reason: synthResults.find((r) => !r.ok)?.reason ?? "empty" };
  // Per-provider tier votes (normalized) + the truthful agreement mode + fail-closed decision.
  const tierVotes: TierVote[] = synthResults.map((r) => {
    const tier = r.ok ? tierFromSynth(r.data) : null;
    // TEMP (P1 — remove once a 5-run preview smoke test confirms Gemini stays in the 3-model vote):
    // log Gemini's raw reason/shape so an intermittent "no vote" is diagnosable in Vercel logs
    // (safety block, empty candidate, parse, timeout) rather than guessed at.
    if (r.provider === "gemini" && (!r.ok || !tier)) {
      console.log("[gemini-raw]", r.ok ? "ok:" + (tier ?? "no-tier") : "fail:" + (r.reason ?? "?"),
        r.data != null ? JSON.stringify(r.data).slice(0, 400) : "");
    }
    // Honest fallback for a usable-response-but-no-tier case, surfaced in the theater without log access.
    const detail = r.ok ? (tier ? "" : "no tier") : (r.reason ?? "");
    emit("voter", r.provider, r.ok ? (tier ? `vote:${tier}` : "flag") : "fail", tier ?? detail);
    return { provider: r.provider, ok: r.ok, tier };
  });
  const synthOkCount = synthResults.filter((r) => r.ok).length;
  const ensembleMode: AgreementMode = agreementMode(synthOkCount, useMultiModel);
  // Green needs POSITIVE deterministic corroboration: every citation with content to check must be
  // FOUND (an ERRORED or not_found check does NOT corroborate — a transient PubMed/CrossRef outage
  // must not let a green through), and every drug candidate must resolve in RxNorm.
  const anyUnresolvedCitation = allVerifs.some((v) =>
    !v.unverifiable && !(v.pubmed?.status === "found" || v.crossref?.status === "found"));
  const anyDrugUnresolved = drugVerifs.some((d) => d.r.status !== "found");
  const tierDecision = decideFinalTier(tierVotes, !anyUnresolvedCitation && !anyDrugUnresolved, providers.length);

  // A step is USABLE if it parsed to an object (arrays/primitives are mis-parses). Field-level
  // shape is read leniently downstream \u2014 never reject a whole step for a missing optional field
  // or a renamed key. (Previously confidence required a numeric `overall_confidence_0_100`, which
  // rejected valid confidence payloads whose field was named/typed differently.)
  const synthUsable = synth.ok && isObj(synth.data);
  const confUsable = conf.ok && isObj(conf.data);

  // Diagnostics: capture WHY any step is unusable. For synth/confidence, describe the PARSED shape
  // (keys + raw tier value) too, so a "parsed-but-rejected" case is visible in the audit output \u2014
  // not only genuine parse/api/empty failures.
  const diag = (name: string, r: { ok: boolean; reason?: string; detail?: string } | null): string | null =>
    !r || r.ok ? null : `${name}: ${r.reason}${r.detail ? " \u2014 " + r.detail.slice(0, 140) : ""}`;
  const describe = (name: string, r: any): string => {
    if (!r || !r.ok) return `${name}: ${(r && r.reason) || "missing"}${r && r.detail ? " \u2014 " + String(r.detail).slice(0, 120) : ""}`;
    const d = r.data;
    const shape = Array.isArray(d) ? "array" : d === null ? "null" : typeof d;
    const keys = isObj(d) ? " keys=[" + Object.keys(d).slice(0, 14).join(",") + "]" : "";
    const t = isObj(d) ? (d.tier ?? d.risk_tier ?? d.verdict ?? d.risk_level ?? d.overall_tier) : undefined;
    return `${name}: parsed ${shape}${keys}${t !== undefined ? " tier=" + JSON.stringify(t) : ""}`;
  };
  const diagnostics = [
    diag("claim_primary(claude)", claim),
    ...(useMultiModel
      ? extraProviders.map((p, i) => diag(`claim_ensemble(${p})`, extraPasses[i] as any))
      : [diag("claim_selfconsistency(claude-hot)", claimHot as any)]),
    diag("citations", citationLLM),
    diag("missing_data", missing),
    synthUsable ? null : describe("risk_synthesis", synth),
    diag("safe_rewrite", rewrite),
    confUsable ? null : describe("confidence", conf),
  ].filter((x): x is string => x !== null);

  // Fix 2/3: steps whose failure must NOT read as a CRITICAL verdict and must collapse confidence.
  const coreStepFailures: string[] = [];
  if (!claimUsable) coreStepFailures.push("claims");
  if (!citationLLMUsable) coreStepFailures.push("citations");
  if (!missingUsable) coreStepFailures.push("missing_data");
  if (!synthUsable) coreStepFailures.push("risk_synthesis");
  if (!confUsable) coreStepFailures.push("confidence");

  const env = compose({
    diagnostics,
    coreStepFailures,
    multiModel: useMultiModel,
    synth: synthUsable ? synth.data : null,
    synthOk: synthUsable,
    conf: confUsable ? conf.data : null,
    rewrite: rewrite.ok ? rewrite.data : null,
    rewriteOk: rewrite.ok,
    citationVerifs: allVerifs,
    missing: missingUsable ? missing.data : null,
    drugVerifs,
    claim: claimUsable ? claim.data : null,
    specialtyMatch,
    agreement,
    evidence,
    votedTier: tierDecision.tier,
    disagreement: tierDecision.disagreement,
    humanReviewFlag: tierDecision.humanReviewFlag,
    agreementMode: ensembleMode,
    tierVotes,
    events,
    durationMs: Date.now() - t0,
    tokensIn,
    tokensOut,
  });
  emit("verdict", "orchestrator", env.verdictTier, env.verdictBadge);
  return env;
}

function compose(a: {
  diagnostics: string[];
  coreStepFailures: string[];
  multiModel: boolean;
  synth: any; synthOk: boolean; conf: any; rewrite: any; rewriteOk: boolean;
  citationVerifs: Awaited<ReturnType<typeof verifyOneCitation>>[];
  missing: any; drugVerifs: { name: string; r: RxNormResult }[];
  claim: any; specialtyMatch: { in_corpus: boolean; confidence_0_100: number };
  agreement: { score: number; notes: string[]; passes: EnsemblePass[] };
  evidence: EvidenceVerdict[];
  votedTier: SynthTier | null;
  disagreement: boolean;
  humanReviewFlag: boolean;
  agreementMode: AgreementMode;
  tierVotes: TierVote[];
  events: AuditEvent[];
  durationMs: number; tokensIn: number; tokensOut: number;
}): AuditEnvelope {
  // A2/A3 (fail-closed ensemble): the tier is a CROSS-MODEL VOTE decided in runAudit — GREEN
  // requires unanimity + deterministic corroboration; any disagreement or a 2-of-3-only quorum
  // downgrades to the more conservative tier and flags for human review. A null vote means no model
  // produced a usable tier -> AUDIT_INCOMPLETE (never the greenest tier, never a tierMap miss;
  // absence of a verdict is neither CRITICAL nor approval). Deterministic escalations only raise
  // severity further — the whole arithmetic lives in escalateTier (pure + unit-tested).
  const auditIncomplete = a.votedTier === null;
  // Steps that invalidate trust in this run (for the confidence cap + drivers). When synthesis
  // produced no usable tier but did not hard-fail, its failure is not in coreStepFailures — add it.
  const failedSteps = [...a.coreStepFailures];
  if (auditIncomplete && !failedSteps.includes("risk_synthesis")) failedSteps.push("risk_synthesis");
  // NOTE: out-of-corpus content no longer escalates the risk tier. Verification
  // (PubMed/CrossRef/RxNorm + LLM) works the same across specialties, so domain
  // alone is not a safety concern. We surface it as an informational note only.
  const isFound = (v: typeof a.citationVerifs[number]) => v.pubmed?.status === "found" || v.crossref?.status === "found";
  const verified = a.citationVerifs.filter(isFound);
  // UNVERIFIABLE (author+year only): could not be confirmed OR denied — NOT a fabrication signal.
  const unverifiableCites = a.citationVerifs.filter((v) => v.unverifiable && !isFound(v));
  // NOT FOUND: we had enough to search (journal / title / volume) and no record matched.
  const notFound = a.citationVerifs.filter((v) =>
    !v.unverifiable && !isFound(v) &&
    (v.pubmed?.status === "not_found" || !v.pubmed) && (v.crossref?.status === "not_found" || !v.crossref)
  );
  const hasHighStakes = Array.isArray(a.claim?.claims) && a.claim.claims.some((c: any) => (HIGH_STAKES_CATEGORIES as readonly string[]).includes(c.category));
  const contradicted = a.evidence.filter((e) => e.verdict === "contradicted");
  const unsupported = a.evidence.filter((e) => e.verdict === "unsupported");
  // Final tier = cross-model vote + deterministic escalations (pure, unit-tested in escalateTier).
  const { tier, overrides } = escalateTier({
    votedTier: a.votedTier,
    disagreement: a.disagreement,
    hasHighStakes,
    verifiedCount: verified.length,
    citationCount: a.citationVerifs.length,
    contradictedCount: contradicted.length,
    unsupportedCount: unsupported.length,
    agreementScore: a.agreement.score,
    multiModel: a.multiModel,
  });

  const tierMap = {
    critical_issues: { v: "critical" as const, b: "CRITICAL ISSUES", t: "Critical issues" },
    significant_concerns: { v: "significant" as const, b: "SIGNIFICANT CONCERNS", t: "Significant concerns" },
    minor_concerns: { v: "minor" as const, b: "MINOR CONCERNS", t: "Minor concerns" },
    no_issues_detected: { v: "no-issues" as const, b: "NO ISSUES DETECTED", t: "No critical issues detected on these specific checks" },
    audit_incomplete: { v: "incomplete" as const, b: "AUDIT INCOMPLETE", t: "Audit incomplete" },
  };
  const tt = tierMap[tier];

  const citationFindings: AuditDomain["findings"] = [
    ...notFound.map((v) => ({ lbl: "NOT FOUND", title: v.raw, src: "No record matched in PubMed or CrossRef.", sev: "critical" as const })),
    ...unverifiableCites.map((v) => ({ lbl: "UNVERIFIABLE", title: v.raw, src: "Author + year only — not specific enough to confirm or deny. Add a journal, DOI, or PMID to verify.", sev: "contextual" as const })),
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
      pillText: notFound.length ? notFound.length + " NOT FOUND" : verified.length ? verified.length + " VERIFIED" : unverifiableCites.length ? unverifiableCites.length + " UNVERIFIABLE" : "NONE",
      summary: verified.length + " of " + a.citationVerifs.length + " citations verified against PubMed/CrossRef"
        + (unverifiableCites.length ? "; " + unverifiableCites.length + " unverifiable (author/year only)" : "") + ".",
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
      pill: tier === "critical_issues" ? "crit" : tier === "significant_concerns" ? "warn" : tier === "minor_concerns" ? "warn" : tier === "audit_incomplete" ? "neut" : "ok",
      pillText: tt.b,
      summary: a.synth?.tier_rationale || (auditIncomplete ? "Risk synthesis did not complete, so no tier was produced." : "Tier driven by citation, missing-data, and drug findings."),
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
  // Read the overall confidence leniently — accept a number or numeric string under any of a few
  // plausible field names; fall back to a neutral 60 only when none is present.
  const confRaw = a.conf && typeof a.conf === "object"
    ? (a.conf.overall_confidence_0_100 ?? a.conf.overall_confidence ?? a.conf.confidence_0_100 ?? a.conf.confidence)
    : undefined;
  const confNum = typeof confRaw === "number" ? confRaw : typeof confRaw === "string" ? Number(confRaw) : NaN;
  let confidence: number = Number.isFinite(confNum) ? Math.max(0, Math.min(100, confNum)) : 60;
  // Fix 3: a failed (or unusable) core step means the audit-of-audit confidence cannot be
  // trusted. Force it Low (<=25) regardless of how well the steps that DID run agreed — a high
  // ensemble agreement on claim extraction must not prop up confidence when synthesis, citation,
  // missing-data, claim, or the confidence computation itself failed.
  if (failedSteps.length > 0) {
    confidence = Math.min(confidence, 25);
  }
  const modeLabel = a.agreementMode === "ensemble:3" ? "3-model ensemble"
    : a.agreementMode === "ensemble:2" ? "2-model ensemble" : "Claude self-consistency";
  const drivers: string[] = [
    "Evidence coverage: " + fScore("evidence_coverage"),
    "Citation verifiability: " + fScore("citation_verifiability"),
    "Model agreement: " + modeLabel + " (" + a.agreement.score + "%)",
  ];
  // A3/A4: surface the fail-closed human-review flag and any voter disagreement prominently.
  if (a.humanReviewFlag) drivers.unshift("Human review recommended — voter disagreement or an incomplete (2-of-3) quorum.");
  // P3: the "outside neuro/spine corpus" note is intentionally NOT surfaced — specialty is inert
  // and showing it implied a scope the tool no longer scores by.
  if (contradicted.length) drivers.push(contradicted.length + " cited abstract(s) contradict their claim.");
  // If LLM-judgment calls failed, say so plainly in the drivers — this is why
  // factors read "n/a" and the rewrite/agreement are absent.
  if (a.diagnostics.length) {
    drivers.push(a.diagnostics.length + " model call(s) failed: " + a.diagnostics.join("; "));
  }
  if (a.conf?.abstain_recommended && a.conf?.abstention_message) drivers.push("Abstain advised: " + a.conf.abstention_message);
  // Fix 3: name the failed core step(s) as an explicit confidence limitation.
  if (failedSteps.length > 0) {
    drivers.unshift("Confidence capped Low: core step(s) failed — " + failedSteps.join(", ") + ".");
  }
  overrides.forEach((o) => drivers.unshift("Composer override: " + o));

  const metaLabel: "Low" | "Moderate" | "High" = confidence >= 75 ? "High" : confidence >= 50 ? "Moderate" : "Low";
  const reason = auditIncomplete
    ? "This audit could not be completed — a required step failed or did not return a usable verdict. No verdict was produced; absence of a verdict is not approval."
    : (a.synth?.tier_rationale || (notFound.length + " unverifiable citation(s), " + missingCrit + " critical missing-data item(s)."));

  // TEMP (C4-diag — remove before the PR): surface a build marker + the RAW evidence verdicts so we
  // can distinguish a stale deploy from an ineffective prompt. Rides the existing string[] field.
  a.diagnostics.push("BUILD=C4-diag2");
  a.diagnostics.push("EVID=" + JSON.stringify(a.evidence.map((e) => ({ v: e.verdict, al: e.alignment_0_100, c: String(e.claim_id).slice(0, 22) }))));

  return {
    verdictTier: tt.v,
    verdictTitle: tt.t,
    verdictBadge: tt.b,
    reason,
    metaConfidence: confidence,
    metaLabel,
    metaDrivers: drivers.slice(0, 6),
    agreementMode: a.agreementMode,
    disagreement: a.disagreement,
    humanReviewFlag: a.humanReviewFlag,
    tierVotes: a.tierVotes,
    events: a.events,
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
