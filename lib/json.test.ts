// Unit tests for extractJSON (lib/json.ts).
// Runner: the repo has no configured test framework, so these use Node's built-in
// test runner + assertions (no new dependency). Run with:
//   node --test lib/json.test.ts        (Node >= 22.6 with type stripping; 23+/24 by default)
// or, once a runner is added, adapt the imports accordingly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJSON } from "./json";

const parse = (s: string): unknown => JSON.parse(extractJSON(s));

test("already-clean JSON passes through unchanged", () => {
  assert.deepEqual(parse('{"tier":"no_issues_detected","n":1}'), { tier: "no_issues_detected", n: 1 });
});

test("fenced ```json with a closing fence", () => {
  const input = "```json\n{\"a\": 1, \"b\": [2, 3]}\n```";
  assert.deepEqual(parse(input), { a: 1, b: [2, 3] });
});

test("fenced WITHOUT a closing fence (truncated fence, complete object) — the bug", () => {
  // Reproduces the live failure: `risk_synthesis: parse — Unexpected token '`', "`json {..."`.
  const input = "```json\n{\"tier\": \"critical_issues\", \"ok\": true}";
  assert.deepEqual(parse(input), { tier: "critical_issues", ok: true });
});

test("plain fence without a language tag", () => {
  const input = "```\n{\"x\": \"y\"}\n```";
  assert.deepEqual(parse(input), { x: "y" });
});

test("leading prose before the JSON object", () => {
  const input = "Here is the strict JSON you asked for:\n{\"verdict\": \"minor\", \"score\": 42}";
  assert.deepEqual(parse(input), { verdict: "minor", score: 42 });
});

test("a bare top-level array", () => {
  const input = "```json\n[{\"id\": \"c1\"}, {\"id\": \"c2\"}]\n```";
  assert.deepEqual(parse(input), [{ id: "c1" }, { id: "c2" }]);
});

test("braces inside string literals do not fool the balanced scan", () => {
  const input = "prose {\"note\": \"a } b { c\", \"ok\": true} trailing";
  assert.deepEqual(parse(input), { note: "a } b { c", ok: true });
});

test("escaped quotes inside strings are handled", () => {
  const input = "```json\n{\"q\": \"she said \\\"hi\\\" }\", \"n\": 2}\n```";
  assert.deepEqual(parse(input), { q: 'she said "hi" }', n: 2 });
});

test("a ``` inside a string value does not truncate a complete payload (no closing fence)", () => {
  // Old lastIndexOf('```') would chop this mid-value; the end-anchored strip must not.
  const input = "```json\n{\"rewrite\": \"use ```code``` inline\", \"ok\": true}";
  assert.deepEqual(parse(input), { rewrite: "use ```code``` inline", ok: true });
});

test("a non-parsing bracket token in the preamble is skipped for the real object", () => {
  const input = "see notes {draft} then\n{\"tier\": \"minor_concerns\"}";
  assert.deepEqual(parse(input), { tier: "minor_concerns" });
});

test("a PARSEABLE array token in the preamble does not win over the real object", () => {
  // Guards the object-returning LLM steps: "[3,1,0]" parses but the object is the payload.
  const input = "Based on claims [3, 1, 0]:\n{\"tier\": \"critical_issues\", \"ok\": true}";
  assert.deepEqual(parse(input), { tier: "critical_issues", ok: true });
});

test("a stray unclosed bracket before a valid object still recovers the object", () => {
  const input = "[ {\"tier\": \"no_issues_detected\"}";
  assert.deepEqual(parse(input), { tier: "no_issues_detected" });
});

test("a bare array with a prose preamble (no object) is still recovered", () => {
  const input = "results:\n[1, 2, 3]";
  assert.deepEqual(parse(input), [1, 2, 3]);
});
