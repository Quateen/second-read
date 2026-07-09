// P7 — per-audit feedback: validation invariants + persistence (metadata only).
// Run: npx tsx --test lib/feedback.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FeedbackSchema } from "./feedback";
import { saveFeedback, loadFeedback, newFeedbackId, type FeedbackRow } from "./store";

test("missing rating is rejected (the route returns 400 for this)", () => {
  const r = FeedbackSchema.safeParse({ reasons: ["Missed a real problem"] });
  assert.equal(r.success, false);
});

test("thumbs-down with at least one reason is valid", () => {
  const r = FeedbackSchema.safeParse({ rating: "down", reasons: ["Citation result wrong"] });
  assert.equal(r.success, true);
});

test("thumbs-down with a comment but no chips is valid", () => {
  const r = FeedbackSchema.safeParse({ rating: "down", comment: "The dose looked off." });
  assert.equal(r.success, true);
});

test("thumbs-down with NO reason and NO comment is rejected", () => {
  const r = FeedbackSchema.safeParse({ rating: "down", reasons: [] });
  assert.equal(r.success, false);
});

test("thumbs-up needs no reasons", () => {
  const r = FeedbackSchema.safeParse({ rating: "up" });
  assert.equal(r.success, true);
});

test("a valid thumbs-down with reasons persists (metadata + rating + reasons, no clinical input)", async () => {
  const parsed = FeedbackSchema.safeParse({
    rating: "down",
    reasons: ["Missed a real problem", "Citation result wrong"],
    comment: "Second citation looked fabricated.",
    audit_id: "abc123",
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;

  const row: FeedbackRow = {
    id: newFeedbackId(),
    audit_id: parsed.data.audit_id ?? null,
    rating: parsed.data.rating,
    reasons: parsed.data.reasons,
    comment: parsed.data.comment,
    created_at: "2026-07-10T00:00:00.000Z",
    ip_hash: "deadbeefdeadbeef",
  };

  const res = await saveFeedback(row);
  assert.equal(res.ok, true);

  const back = await loadFeedback(row.id);
  assert.ok(back, "row should be retrievable");
  assert.equal(back!.rating, "down");
  assert.deepEqual(back!.reasons, ["Missed a real problem", "Citation result wrong"]);
  assert.equal(back!.audit_id, "abc123");
  // The stored shape carries no field that could hold the audited clinical input.
  assert.deepEqual(
    Object.keys(back!).sort(),
    ["audit_id", "comment", "created_at", "id", "ip_hash", "rating", "reasons"]
  );
});
