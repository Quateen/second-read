// Unit tests for normalizeSynthTier + tierFromSynth (lib/tier.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSynthTier, tierFromSynth } from "./tier";

test("exact canonical tiers pass through", () => {
  assert.equal(normalizeSynthTier("critical_issues"), "critical_issues");
  assert.equal(normalizeSynthTier("significant_concerns"), "significant_concerns");
  assert.equal(normalizeSynthTier("minor_concerns"), "minor_concerns");
  assert.equal(normalizeSynthTier("no_issues_detected"), "no_issues_detected");
});

test("recognizable variants normalize (case / spacing / short form)", () => {
  assert.equal(normalizeSynthTier("CRITICAL"), "critical_issues");
  assert.equal(normalizeSynthTier("Critical Issues"), "critical_issues");
  assert.equal(normalizeSynthTier("no-issues"), "no_issues_detected");
  assert.equal(normalizeSynthTier("No Issues Detected"), "no_issues_detected");
  assert.equal(normalizeSynthTier("no concerns"), "no_issues_detected");
  assert.equal(normalizeSynthTier("Minor"), "minor_concerns");
  // The product's OWN greenest phrasing contains "critical" — must NOT read as critical_issues.
  assert.equal(normalizeSynthTier("No critical issues detected on these specific checks"), "no_issues_detected");
  assert.equal(normalizeSynthTier("no critical issues"), "no_issues_detected");
});

test("unrecognizable or non-string returns null (-> honest AUDIT_INCOMPLETE)", () => {
  assert.equal(normalizeSynthTier("banana"), null);
  assert.equal(normalizeSynthTier(""), null);
  assert.equal(normalizeSynthTier(undefined), null);
  assert.equal(normalizeSynthTier(null), null);
  assert.equal(normalizeSynthTier(3), null);
  assert.equal(normalizeSynthTier({ tier: "critical" }), null);
});

test("does not map bare ambiguous values to the greenest tier", () => {
  assert.equal(normalizeSynthTier("none"), null);
  assert.equal(normalizeSynthTier("ok"), null);
  assert.equal(normalizeSynthTier("pass"), null);
});

// B1: a model's tier must be recovered from whatever shape it used (a vote must never be "flag"
// just because the tier field was named/nested differently).
test("tierFromSynth reads the standard shape", () => {
  assert.equal(tierFromSynth({ tier: "critical_issues", tier_rationale: "x" }), "critical_issues");
  assert.equal(tierFromSynth({ tier: "CRITICAL" }), "critical_issues");
});

test("tierFromSynth recovers a renamed or nested tier", () => {
  assert.equal(tierFromSynth({ risk_level: "significant concerns" }), "significant_concerns");
  assert.equal(tierFromSynth({ verdict: { tier: "no_issues_detected" } }), "no_issues_detected");
  assert.equal(tierFromSynth({ risk_synthesis: { tier: "minor_concerns" } }), "minor_concerns");
  assert.equal(tierFromSynth({ overall_risk_rating: "Critical Issues" }), "critical_issues");
});

test("tierFromSynth returns null for a tier-less fragment (does not misread a finding's severity)", () => {
  assert.equal(tierFromSynth({ id: "f1", severity: "critical", category: "x", summary: "y" }), null);
  assert.equal(tierFromSynth({ top_findings: [{ severity: "critical" }] }), null);
});
