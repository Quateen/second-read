// Unit tests for the fail-closed tier decision + truthful agreement mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFinalTier, agreementMode, runQuorum, TierVote } from "./ensemble";

const v = (provider: string, tier: any): TierVote => ({ provider, tier, ok: tier !== null });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const voter = (tier: string, delay: number) => async () => { await sleep(delay); return { ok: true as const, provider: "claude" as const, data: { tier }, usage: { input_tokens: 0, output_tokens: 0 } }; };

test("unanimous green + deterministic corroboration + full quorum -> green, no flag", () => {
  const d = decideFinalTier([v("claude", "no_issues_detected"), v("gpt", "no_issues_detected"), v("gemini", "no_issues_detected")], true, 3);
  assert.equal(d.tier, "no_issues_detected");
  assert.equal(d.humanReviewFlag, false);
  assert.equal(d.disagreement, false);
});

test("unanimous green but NOT corroborated -> downgraded to minor + flag", () => {
  const d = decideFinalTier([v("claude", "no_issues_detected"), v("gpt", "no_issues_detected"), v("gemini", "no_issues_detected")], false, 3);
  assert.equal(d.tier, "minor_concerns");
  assert.equal(d.humanReviewFlag, true);
});

test("disagreement on a green -> most-conservative wins + flag (never a majority green)", () => {
  const d = decideFinalTier([v("claude", "no_issues_detected"), v("gpt", "no_issues_detected"), v("gemini", "minor_concerns")], true, 3);
  assert.equal(d.tier, "minor_concerns");
  assert.equal(d.disagreement, true);
  assert.equal(d.humanReviewFlag, true);
});

test("disagreement among non-green tiers -> MOST SEVERE vote wins + flag", () => {
  const d = decideFinalTier([v("claude", "significant_concerns"), v("gpt", "critical_issues"), v("gemini", "significant_concerns")], true, 3);
  assert.equal(d.tier, "critical_issues");
  assert.equal(d.humanReviewFlag, true);
});

test("unanimous critical -> critical, no flag", () => {
  const d = decideFinalTier([v("claude", "critical_issues"), v("gpt", "critical_issues"), v("gemini", "critical_issues")], true, 3);
  assert.equal(d.tier, "critical_issues");
  assert.equal(d.disagreement, false);
  assert.equal(d.humanReviewFlag, false);
});

test("2-of-3 quorum (a voter dropped) unanimous green -> downgrade + flag", () => {
  const d = decideFinalTier([v("claude", "no_issues_detected"), v("gpt", "no_issues_detected")], true, 3);
  assert.equal(d.tier, "minor_concerns");
  assert.equal(d.humanReviewFlag, true);
});

test("no usable votes -> null (AUDIT_INCOMPLETE) + flag", () => {
  const d = decideFinalTier([v("claude", null), v("gpt", null), v("gemini", null)], true, 3);
  assert.equal(d.tier, null);
  assert.equal(d.humanReviewFlag, true);
});

test("single-provider self-consistency green + corroborated -> green (no incomplete-quorum penalty)", () => {
  const d = decideFinalTier([v("claude", "no_issues_detected")], true, 1);
  assert.equal(d.tier, "no_issues_detected");
  assert.equal(d.humanReviewFlag, false);
});

test("runQuorum waits for ALL voters within the window — a slower SEVERE vote is not dropped", async () => {
  const calls: Record<string, () => Promise<any>> = {
    claude: voter("no_issues_detected", 10),
    gpt: voter("no_issues_detected", 20),
    gemini: voter("critical_issues", 120), // slower, but within the quorum window
  };
  const { results, quorum } = await runQuorum(["claude", "gpt", "gemini"] as any, (p) => calls[p](), { perCallTimeoutMs: 2000, quorumTimeoutMs: 600 });
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(quorum, "3of3");
  assert.ok(results.some((r) => (r.data as any)?.tier === "critical_issues"));
});

test("runQuorum drops a voter slower than the quorum timeout (real 2-of-3)", async () => {
  const calls: Record<string, () => Promise<any>> = {
    claude: voter("no_issues_detected", 10),
    gpt: voter("no_issues_detected", 20),
    gemini: voter("critical_issues", 900), // exceeds the 250ms quorum timeout
  };
  const { results, quorum } = await runQuorum(["claude", "gpt", "gemini"] as any, (p) => calls[p](), { perCallTimeoutMs: 2000, quorumTimeoutMs: 250 });
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.equal(quorum, "2of3");
});

// --- Option B: bounded lone-outlier cap -------------------------------------------------------
test("Option B: a LONE severe vote with a majority-low and NO driver -> capped to minor + flag", () => {
  const d = decideFinalTier([v("gpt", "critical_issues"), v("claude", "minor_concerns"), v("gemini", "minor_concerns")], true, 3, false);
  assert.equal(d.tier, "minor_concerns");
  assert.equal(d.humanReviewFlag, true);
});

test("Option B: a LONE significant vote over a majority-low, NO driver -> capped to minor", () => {
  const d = decideFinalTier([v("gpt", "significant_concerns"), v("claude", "no_issues_detected"), v("gemini", "minor_concerns")], true, 3, false);
  assert.equal(d.tier, "minor_concerns");
});

test("Option B: a lone severe vote WITH a deterministic driver is NOT capped (safety preserved)", () => {
  const d = decideFinalTier([v("gpt", "critical_issues"), v("claude", "minor_concerns"), v("gemini", "minor_concerns")], true, 3, true);
  assert.equal(d.tier, "critical_issues");
});

test("Option B: TWO severe votes (not a lone outlier) are NEVER capped", () => {
  const d = decideFinalTier([v("gpt", "critical_issues"), v("claude", "critical_issues"), v("gemini", "minor_concerns")], true, 3, false);
  assert.equal(d.tier, "critical_issues");
});

test("Option B: a lone severe vote in a 2-vote quorum (no majority-low) is NOT capped", () => {
  const d = decideFinalTier([v("gpt", "critical_issues"), v("claude", "minor_concerns")], true, 3, false);
  assert.equal(d.tier, "critical_issues");
});

test("agreement mode is truthful — never '3-model' unless 3 returned", () => {
  assert.equal(agreementMode(3, true), "ensemble:3");
  assert.equal(agreementMode(2, true), "ensemble:2");
  assert.equal(agreementMode(1, true), "self_consistency:claude");
  assert.equal(agreementMode(1, false), "self_consistency:claude");
});
