// lib/tier.ts — normalize the risk-synthesis tier onto the canonical enum.
//
// The synth LLM is instructed to return one of the four exact strings below, but Haiku
// occasionally returns a recognizable variant (different case/spacing, a short form like
// "critical", or an alternate field name). A strict equality check treats those as a failed
// step and forces AUDIT_INCOMPLETE on every audit — so read the tier tolerantly, but return
// null (-> honest AUDIT_INCOMPLETE) when NO clinical tier is recognizable, and only map to the
// greenest tier on an explicit "no issues / no concern / no critical" signal so a malformed
// synth can never read as approval.
export type SynthTier =
  | "critical_issues"
  | "significant_concerns"
  | "minor_concerns"
  | "no_issues_detected";

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
