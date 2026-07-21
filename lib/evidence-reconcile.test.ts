// Unit tests for reconcileEvidenceVerdict — the CLEAN-04 fix.
// The reconciliation downgrades a self-inconsistent "unsupported" gestalt (population match, no
// intervention/outcome mismatch) to non-escalating "insufficient_evidence". These tests lock in that
// it NEVER reconciles away a genuine mischaracterization signal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileEvidenceVerdict, EvidenceVerdict } from "./audit-pipeline";

const base: EvidenceVerdict = {
  claim_id: "c1", citation_raw: "Nogueira, DAWN, NEJM 2018", verdict: "unsupported",
  alignment_0_100: 40, rationale: "x",
};

// --- CLEAN-04 shape: the fix fires ---------------------------------------------------------------
test("CLEAN-04 shape: unsupported + population match + no int/outcome mismatch -> insufficient_evidence", () => {
  const r = reconcileEvidenceVerdict({ ...base, population_match: "match", intervention_match: "match", outcome_match: "match" });
  assert.equal(r.verdict, "insufficient_evidence");
});

test("Reconciliation tolerates adjacent/unknown intervention & outcome as long as population is a strict match", () => {
  const r = reconcileEvidenceVerdict({ ...base, population_match: "match", intervention_match: "adjacent", outcome_match: "unknown" });
  assert.equal(r.verdict, "insufficient_evidence");
});

// --- MIS safety: the fix must NOT fire -----------------------------------------------------------
test("MIS-04/06 shape (wrong population): unsupported + population MISMATCH stays unsupported", () => {
  const r = reconcileEvidenceVerdict({ ...base, population_match: "mismatch", intervention_match: "match", outcome_match: "match" });
  assert.equal(r.verdict, "unsupported");
});

test("Over-generalization (population 'adjacent') is NOT reconciled — stays unsupported", () => {
  const r = reconcileEvidenceVerdict({ ...base, population_match: "adjacent", intervention_match: "match", outcome_match: "match" });
  assert.equal(r.verdict, "unsupported");
});

test("A real intervention mismatch is NOT reconciled — stays unsupported", () => {
  const r = reconcileEvidenceVerdict({ ...base, population_match: "match", intervention_match: "mismatch", outcome_match: "match" });
  assert.equal(r.verdict, "unsupported");
});

test("An outcome mismatch (opposite finding) is NOT reconciled — stays unsupported", () => {
  const r = reconcileEvidenceVerdict({ ...base, population_match: "match", intervention_match: "match", outcome_match: "mismatch" });
  assert.equal(r.verdict, "unsupported");
});

test("CONTRADICTED (opposite finding) is NEVER touched, even with population match", () => {
  const r = reconcileEvidenceVerdict({ ...base, verdict: "contradicted", population_match: "match", intervention_match: "match", outcome_match: "match" });
  assert.equal(r.verdict, "contradicted");
});

test("Missing structured fields: an unsupported with no PICO self-report is left as unsupported (no false reconcile)", () => {
  const r = reconcileEvidenceVerdict({ ...base });
  assert.equal(r.verdict, "unsupported");
});

test("supported / partially_supported / insufficient are passed through unchanged", () => {
  for (const v of ["supported", "partially_supported", "insufficient_evidence"]) {
    const r = reconcileEvidenceVerdict({ ...base, verdict: v, population_match: "match", intervention_match: "match", outcome_match: "match" });
    assert.equal(r.verdict, v);
  }
});
