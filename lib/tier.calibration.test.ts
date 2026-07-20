// P2 calibration — golden-set-style invariants for the deterministic tier resolver (escalateTier).
//
// These lock the "benign, uncited, guideline-concordant claim -> MINOR (not SIGNIFICANT/CRITICAL)"
// fix while proving the real risk drivers (fabricated / contradicted citation, drug-safety, critical
// missing-data) still reach SIGNIFICANT/CRITICAL and fail-closed stays intact (a high-stakes claim
// can never end GREEN). The LLM's own vote is not unit-testable; here we simulate the vote it would
// return and assert the deterministic escalation math around it.
//
// Run: npx tsx --test lib/tier.calibration.test.ts   (tier.ts is SDK-free, so `node --test` also works)
import { test } from "node:test";
import assert from "node:assert/strict";
import { escalateTier } from "./tier";

// Neutral baseline: a single high-stakes claim, no citations, models agree, nothing else wrong.
const base = {
  votedTier: "no_issues_detected" as const,
  disagreement: false,
  hasHighStakes: true,
  verifiedCount: 0,
  citationCount: 0,
  contradictedCount: 0,
  unsupportedCount: 0,
  agreementScore: 90,
  multiModel: true,
};

test("ASPIRIN (benign, uncited, high-stakes): a green vote floors at MINOR, never SIGNIFICANT/CRITICAL", () => {
  // "Aspirin 81 mg once daily is commonly used for secondary prevention after ischemic stroke."
  // No citation, guideline-concordant. Fail-closed forbids green; the correct floor is MINOR.
  const { tier } = escalateTier({ ...base, votedTier: "no_issues_detected", citationCount: 0 });
  assert.equal(tier, "minor_concerns");
});

test("ASPIRIN: when the model already votes MINOR, it stays MINOR (no over-escalation)", () => {
  const { tier } = escalateTier({ ...base, votedTier: "minor_concerns", citationCount: 0 });
  assert.equal(tier, "minor_concerns");
});

test("Fail-closed: a benign uncited high-stakes claim is NEVER left GREEN", () => {
  const { tier } = escalateTier({ ...base, votedTier: "no_issues_detected", citationCount: 0 });
  assert.notEqual(tier, "no_issues_detected");
});

test("Missing citation alone must not reach SIGNIFICANT or CRITICAL", () => {
  const { tier } = escalateTier({ ...base, votedTier: "no_issues_detected", citationCount: 0 });
  assert.ok(tier !== "significant_concerns" && tier !== "critical_issues");
});

test("FAB-01 (fabricated citation) as the model votes it -> CRITICAL is preserved", () => {
  // A fabricated citation tied to a therapy/dose -> the synth prompt votes critical_issues.
  const { tier } = escalateTier({ ...base, votedTier: "critical_issues", citationCount: 1, verifiedCount: 0 });
  assert.equal(tier, "critical_issues");
});

test("A citation PRESENT but unverifiable (green vote) is a real driver -> SIGNIFICANT (not minor)", () => {
  // Distinct from the aspirin case: here a citation WAS provided and none verified. That is a risk
  // driver, so the deterministic floor is SIGNIFICANT even if a model under-votes it green.
  const { tier } = escalateTier({ ...base, votedTier: "no_issues_detected", citationCount: 1, verifiedCount: 0 });
  assert.equal(tier, "significant_concerns");
});

test("A contradicted cited abstract deterministically forces CRITICAL, even over a green vote", () => {
  const { tier } = escalateTier({ ...base, votedTier: "no_issues_detected", citationCount: 1, verifiedCount: 1, contradictedCount: 1 });
  assert.equal(tier, "critical_issues");
});

test("An unsupported cited source escalates a green/minor vote to SIGNIFICANT", () => {
  const { tier } = escalateTier({ ...base, votedTier: "minor_concerns", citationCount: 1, verifiedCount: 1, unsupportedCount: 1 });
  assert.equal(tier, "significant_concerns");
});

test("DRUG-01 (drug-safety) as the model votes it -> CRITICAL is preserved", () => {
  const { tier } = escalateTier({ ...base, votedTier: "critical_issues" });
  assert.equal(tier, "critical_issues");
});

test("AUDIT_INCOMPLETE (null vote) stays incomplete — partial signals never flip it to a colored tier", () => {
  const { tier } = escalateTier({ ...base, votedTier: null, contradictedCount: 1, citationCount: 1 });
  assert.equal(tier, "audit_incomplete");
});

test("Escalation never LOWERS severity: a critical vote survives a low-agreement signal", () => {
  const { tier } = escalateTier({ ...base, votedTier: "critical_issues", agreementScore: 10 });
  assert.equal(tier, "critical_issues");
});

// --- Deterministic-clean floor (Step 1: deterministic layer dominates where definitive) -----------
test("Deterministic-clean (verified+supported, no driver): a significant over-vote is capped to MINOR", () => {
  const { tier } = escalateTier({ ...base, votedTier: "significant_concerns", verifiedCount: 1, citationCount: 1, deterministicallyClean: true });
  assert.equal(tier, "minor_concerns");
});

test("Deterministic-clean: even a lone/majority CRITICAL over-vote is capped to MINOR (never green)", () => {
  const { tier } = escalateTier({ ...base, votedTier: "critical_issues", verifiedCount: 1, citationCount: 1, deterministicallyClean: true });
  assert.equal(tier, "minor_concerns");
});

test("NOT deterministically-clean: a significant vote is NOT capped", () => {
  const { tier } = escalateTier({ ...base, votedTier: "significant_concerns", verifiedCount: 1, citationCount: 1, deterministicallyClean: false });
  assert.equal(tier, "significant_concerns");
});

test("Deterministic-clean flag NEVER suppresses a real driver: contradicted still forces CRITICAL", () => {
  // Defensive: even if a caller wrongly set the flag, a contradicted signal wins.
  const { tier } = escalateTier({ ...base, votedTier: "no_issues_detected", verifiedCount: 1, citationCount: 1, contradictedCount: 1, deterministicallyClean: true });
  assert.equal(tier, "critical_issues");
});
