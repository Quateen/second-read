// lib/tier.ts — normalize the risk-synthesis tier onto the canonical enum + severity helpers.
//
// The synth LLM is instructed to return one of the four exact strings below, but the models
// occasionally return a recognizable variant (different case/spacing, a short form like
// "critical", or an alternate/nested field name). A strict equality check treats those as a failed
// step and forces AUDIT_INCOMPLETE — so read the tier tolerantly, but return null (-> honest
// AUDIT_INCOMPLETE) when NO clinical tier is recognizable, and only map to the greenest tier on an
// explicit "no issues / no concern / no critical" signal so a malformed synth can't read as approval.
export type SynthTier =
  | "critical_issues"
  | "significant_concerns"
  | "minor_concerns"
  | "no_issues_detected";

// Higher = more severe / more conservative for a safety auditor (used by the fail-closed vote).
export const TIER_SEVERITY: Record<SynthTier, number> = {
  no_issues_detected: 0,
  minor_concerns: 1,
  significant_concerns: 2,
  critical_issues: 3,
};

export function normalizeSynthTier(raw: unknown): SynthTier | null {
  if (typeof raw !== "string") return null;
  const s = raw.toLowerCase().replace(/[\s-]+/g, "_");
  // Check the greenest signal FIRST: the product's own best-case verdict is phrased "no critical
  // issues detected on these specific checks" — which contains "critical" and must NOT read as
  // critical_issues. (This is why "no_critical" is tested before the bare "critical" check.)
  if (s.includes("no_issue") || s.includes("no_critical") || s.includes("no_concern")) return "no_issues_detected";
  if (s.includes("critical")) return "critical_issues";
  if (s.includes("significant")) return "significant_concerns";
  if (s.includes("minor")) return "minor_concerns";
  return null;
}

// Pull the tier out of whatever shape a model used: a direct field, an alternate name, or a
// string/object nested under verdict/risk/etc. Returns the RAW value (string or undefined) for
// normalizeSynthTier to map. Shared by the risk-synthesis composer and the ensemble tier vote.
const TIER_KEY = /(tier|verdict|risk_?level|classification|rating|overall_?risk)/i;

export function pickTierRaw(d: any): unknown {
  if (!d || typeof d !== "object") return undefined;
  const direct = d.tier ?? d.risk_tier ?? d.risk_level ?? d.overall_tier ?? d.verdict_tier;
  if (typeof direct === "string") return direct;
  for (const k of ["verdict", "risk", "risk_synthesis", "synthesis", "assessment", "summary", "result", "output"]) {
    const v = d[k];
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = v.tier ?? v.risk_tier ?? v.level ?? v.rating ?? v.verdict;
      if (typeof nested === "string") return nested;
    }
  }
  // Fallback: any TIER-LIKE key (top level, or one object-nest deep) whose string value maps to a
  // known tier — robust to a model naming the field differently. Deliberately does NOT scan array
  // items (a single finding's `severity` is not the overall verdict tier).
  const scan = (obj: any): string | undefined => {
    for (const [k, val] of Object.entries(obj)) {
      if (typeof val === "string" && TIER_KEY.test(k) && normalizeSynthTier(val)) return val;
    }
    return undefined;
  };
  const top = scan(d);
  if (top) return top;
  for (const val of Object.values(d)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = scan(val);
      if (nested) return nested;
    }
  }
  return direct;
}

export function tierFromSynth(data: any): SynthTier | null {
  return normalizeSynthTier(pickTierRaw(data));
}

// The composer's tier universe adds AUDIT_INCOMPLETE (no usable vote) to the four synth tiers.
export type ComposeTier = SynthTier | "audit_incomplete";

// Pure tier resolution: the cross-model vote (votedTier) + the deterministic signals -> the final
// tier and its human-readable override reasons. Kept here (SDK-free) so the calibration is
// unit-testable WITHOUT invoking any LLM. Escalations can only RAISE severity, never lower it, and
// never turn an incomplete audit into a colored tier. Fail-closed is preserved: an unverifiable
// high-stakes claim can never stay green — but a plain MISSING citation floors at MINOR, not
// SIGNIFICANT (P2 calibration: absence of a citation is not, by itself, a significant problem;
// a real risk driver — fabricated/contradicted citation, drug-safety, critical missing-data — is).
export function escalateTier(sig: {
  votedTier: SynthTier | null;
  disagreement: boolean;
  hasHighStakes: boolean;
  verifiedCount: number;      // citations positively FOUND in PubMed/CrossRef
  citationCount: number;      // total citations that were submitted for verification
  contradictedCount: number;  // cited abstracts that contradict the claim they support
  unsupportedCount: number;   // cited sources that do not support their claim
  agreementScore: number;     // 0-100 ensemble / self-consistency agreement
  multiModel: boolean;
}): { tier: ComposeTier; overrides: string[] } {
  const overrides: string[] = [];
  const auditIncomplete = sig.votedTier === null;
  let tier: ComposeTier = sig.votedTier !== null ? sig.votedTier : "audit_incomplete";
  if (auditIncomplete) {
    overrides.push("Risk synthesis did not produce a usable verdict, so none is shown. Absence of a verdict is not approval.");
  } else if (sig.disagreement) {
    overrides.push("Voters disagreed on the tier — took the more conservative tier and flagged for human review.");
  }
  if (!auditIncomplete) {
    // A high-stakes claim that voted GREEN but has no positively-verified citation. Two DISTINCT
    // cases — do not conflate them (this was the aspirin over-flag):
    //   • no citation was provided at all -> the claim is merely UNVERIFIED, not wrong. Fail-closed
    //     forbids green, but the correct floor is MINOR ("unverified — no citation"), not significant.
    //   • citations WERE provided but none verified (not_found / fabricated) -> a real risk driver
    //     -> significant.
    if (sig.hasHighStakes && sig.verifiedCount === 0 && tier === "no_issues_detected") {
      if (sig.citationCount === 0) {
        tier = "minor_concerns";
        overrides.push("High-stakes claim provided without any citation — unverifiable, not a detected error.");
      } else {
        tier = "significant_concerns";
        overrides.push("High-stakes claims with citations that could not be verified.");
      }
    }
    // Evidence-relevance escalation: a contradicted citation is a critical signal.
    if (sig.contradictedCount > 0 && tier !== "critical_issues") {
      tier = "critical_issues";
      overrides.push("A cited abstract contradicts the claim it was used to support.");
    } else if (sig.unsupportedCount > 0 && (tier === "no_issues_detected" || tier === "minor_concerns")) {
      tier = "significant_concerns";
      overrides.push("A cited source does not actually support its claim.");
    }
    // Low ensemble agreement is a self-consistency red flag.
    if (sig.agreementScore < 40 && tier === "no_issues_detected") {
      tier = "minor_concerns";
      overrides.push(sig.multiModel ? "The ensemble models disagreed substantially." : "The two self-consistency passes disagreed substantially.");
    }
  }
  return { tier, overrides };
}
