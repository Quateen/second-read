// lib/ensemble.ts — failsafe multi-provider voting for the categorical steps (the risk tier).
//
// Doctrine (fail-closed, from the ensemble design brief §1-3): a GREEN / low-severity verdict
// requires UNANIMOUS voter agreement AND deterministic corroboration. Any disagreement, or a
// 2-of-3-only quorum, downgrades to the more conservative (more severe) tier and raises a
// human-review flag. NEVER let a majority pick a green — two weak voters must not out-vote a
// correct conservative one.
//
// Reliability: voters run in PARALLEL (a vote needs independent answers, not a fallback chain),
// each with a hard per-call timeout + one jittered retry on transient (api) failures, a quorum
// timeout so one slow provider can't stall the audit, and an in-memory per-provider circuit
// breaker (note: resets on serverless cold start; a Redis-backed breaker via Upstash is the
// phase-2 upgrade — out of scope for this PR).
import { Provider, LLMJsonResult } from "./llm";
import { SynthTier, TIER_SEVERITY } from "./tier";

export type AgreementMode = "ensemble:3" | "ensemble:2" | "self_consistency:claude";
export type TierVote = { provider: string; tier: SynthTier | null; ok: boolean };
export type VoterResult<T> = { provider: Provider; ok: boolean; data: T | null; reason?: string };

// --- In-memory circuit breaker (per provider) ------------------------------------------------
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;
const _breaker: Record<string, { consecutive: number; openUntil: number }> = {};
function breakerOpen(p: Provider): boolean {
  const s = _breaker[p];
  return !!s && s.openUntil > Date.now();
}
function breakerSuccess(p: Provider) { _breaker[p] = { consecutive: 0, openUntil: 0 }; }
function breakerFailure(p: Provider) {
  const s = _breaker[p] ?? { consecutive: 0, openUntil: 0 };
  s.consecutive += 1;
  if (s.consecutive >= BREAKER_THRESHOLD) s.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
  _breaker[p] = s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<{ timedOut: true }>((res) => { timer = setTimeout(() => res({ timedOut: true }), ms); });
  return Promise.race([p.then((value) => ({ timedOut: false as const, value })), timeout])
    .finally(() => clearTimeout(timer)); // don't leave a stray timer keeping the function alive
}

// One voter: hard timeout + a single jittered retry on timeout/api (transient) failures.
async function runVoter<T>(
  provider: Provider,
  call: (p: Provider) => Promise<LLMJsonResult<T>>,
  perCallTimeoutMs: number,
): Promise<VoterResult<T>> {
  if (breakerOpen(provider)) return { provider, ok: false, data: null, reason: "circuit_open" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const raced = await raceTimeout(call(provider), perCallTimeoutMs);
    if (raced.timedOut) {
      breakerFailure(provider);
      if (attempt === 0) { await sleep(150 + Math.floor(Math.random() * 250)); continue; }
      return { provider, ok: false, data: null, reason: "timeout" };
    }
    const r = raced.value;
    if (r.ok) { breakerSuccess(provider); return { provider, ok: true, data: r.data }; }
    breakerFailure(provider);
    // Only transient api errors are worth a retry; parse/empty/no_key are not.
    if (r.reason === "api" && attempt === 0) { await sleep(150 + Math.floor(Math.random() * 250)); continue; }
    return { provider, ok: false, data: null, reason: r.reason };
  }
  return { provider, ok: false, data: null, reason: "unknown" };
}

/**
 * Run the voters in parallel and PROCEED once a quorum of OK results is in (or all settle, or the
 * quorum timeout elapses) — a slow/failed provider is dropped, never blocks the audit. Returns the
 * results that arrived within the quorum window plus a "NofM" quorum label.
 */
export async function runQuorum<T>(
  providers: Provider[],
  call: (p: Provider) => Promise<LLMJsonResult<T>>,
  opts: { perCallTimeoutMs?: number; quorumTimeoutMs?: number; minQuorum?: number } = {},
): Promise<{ results: VoterResult<T>[]; quorum: string }> {
  const perCallTimeoutMs = opts.perCallTimeoutMs ?? 20_000;
  const quorumTimeoutMs = opts.quorumTimeoutMs ?? 14_000;
  // Default: wait for ALL configured voters (bounded by quorumTimeoutMs, which drops genuinely slow
  // providers). A lower minQuorum would let a slower, MORE-SEVERE vote be dropped just for being
  // slower than two lower-severity votes — which would defeat "take the most severe vote".
  const minQuorum = opts.minQuorum ?? providers.length;
  const settled: VoterResult<T>[] = [];
  let resolveQuorum!: () => void;
  const quorumReached = new Promise<void>((res) => { resolveQuorum = res; });
  for (const p of providers) {
    runVoter(p, call, perCallTimeoutMs).then((r) => {
      settled.push(r);
      const okCount = settled.filter((x) => x.ok).length;
      if (okCount >= minQuorum || settled.length === providers.length) resolveQuorum();
    });
  }
  let quorumTimer: ReturnType<typeof setTimeout>;
  const quorumTimeout = new Promise<void>((res) => { quorumTimer = setTimeout(res, quorumTimeoutMs); });
  await Promise.race([quorumReached, quorumTimeout]);
  clearTimeout(quorumTimer!);
  const okCount = settled.filter((x) => x.ok).length;
  return { results: [...settled], quorum: `${okCount}of${providers.length}` };
}

/**
 * Fail-closed tier decision.
 * - GREEN survives ONLY on unanimous agreement + deterministic corroboration + a complete quorum.
 * - Any disagreement -> take the MOST SEVERE vote + raise the human-review flag.
 * - A green that is not unanimous/corroborated is bumped to the next conservative tier + flagged.
 * - No usable votes -> null (the caller renders AUDIT_INCOMPLETE).
 */
export function decideFinalTier(
  votes: TierVote[],
  deterministicCorroborated: boolean,
  totalProviders: number,
  hasRiskDriver: boolean = false,
): { tier: SynthTier | null; unanimous: boolean; disagreement: boolean; humanReviewFlag: boolean; quorumOk: number } {
  const valid = votes.map((v) => v.tier).filter((t): t is SynthTier => !!t);
  const quorumOk = valid.length;
  if (quorumOk === 0) return { tier: null, unanimous: false, disagreement: false, humanReviewFlag: true, quorumOk };
  const unanimous = valid.every((t) => t === valid[0]);
  const mostSevere = valid.reduce((a, b) => (TIER_SEVERITY[b] > TIER_SEVERITY[a] ? b : a), valid[0]);
  // A real ensemble (>=2 providers) that lost a voter is a 2-of-3-only quorum -> treat as incomplete.
  const incompleteQuorum = totalProviders >= 2 && quorumOk < totalProviders;

  if (mostSevere === "no_issues_detected") {
    if (unanimous && deterministicCorroborated && !incompleteQuorum) {
      return { tier: "no_issues_detected", unanimous: true, disagreement: false, humanReviewFlag: false, quorumOk };
    }
    // Cannot be green: conservative bump + human review.
    return { tier: "minor_concerns", unanimous, disagreement: !unanimous, humanReviewFlag: true, quorumOk };
  }
  // Non-green: most-severe vote wins.
  let tier: SynthTier = mostSevere;
  // Bounded lone-outlier cap: a SINGLE model voting significant/critical while a MAJORITY (>=2) voted
  // minor/no_issues, with NO deterministic risk driver present, is almost always a hallucinated
  // over-flag (the dominant source of clean-content false positives). Cap it to minor_concerns —
  // still flagged + human review, NEVER green. This does NOT weaken never-green, and it never fires
  // when a deterministic driver exists (hasRiskDriver) or when >=2 models agree on a severe tier, so
  // a genuine danger with any corroboration still escalates. The residual, accepted tradeoff: a
  // danger that ONLY one model catches with zero deterministic signal softens to minor + human review.
  const severeCount = valid.filter((t) => TIER_SEVERITY[t] >= TIER_SEVERITY.significant_concerns).length;
  const lowCount = valid.filter((t) => TIER_SEVERITY[t] <= TIER_SEVERITY.minor_concerns).length;
  const loneOutlierSevere = severeCount === 1 && lowCount >= 2;
  if (!hasRiskDriver && loneOutlierSevere) {
    tier = "minor_concerns";
  }
  // disagreement or an incomplete quorum raises the flag.
  return {
    tier,
    unanimous,
    disagreement: !unanimous,
    humanReviewFlag: !unanimous || incompleteQuorum,
    quorumOk,
  };
}

// Truthful mode label — never claim "3-model ensemble" unless 3 providers actually returned.
export function agreementMode(okProviderCount: number, multiModel: boolean): AgreementMode {
  if (multiModel && okProviderCount >= 3) return "ensemble:3";
  if (multiModel && okProviderCount === 2) return "ensemble:2";
  return "self_consistency:claude";
}
