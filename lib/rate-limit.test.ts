// Unit tests for the eval-bypass gate (lib/rate-limit.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isEvalBypass } from "./rate-limit";

test("eval bypass requires a set env token AND an exact header match", () => {
  assert.equal(isEvalBypass("secret123", "secret123"), true);
  assert.equal(isEvalBypass("wrong", "secret123"), false);
  assert.equal(isEvalBypass(null, "secret123"), false);
  assert.equal(isEvalBypass(undefined, "secret123"), false);
});

test("no bypass when the env token is unset/empty — normal users are never affected", () => {
  assert.equal(isEvalBypass("anything", undefined), false);
  assert.equal(isEvalBypass("", ""), false);
  assert.equal(isEvalBypass(null, undefined), false);
});
