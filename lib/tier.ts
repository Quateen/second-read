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
