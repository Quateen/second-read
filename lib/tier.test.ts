// Unit tests for normalizeSynthTier (lib/tier.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSynthTier } from "./tier";

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
