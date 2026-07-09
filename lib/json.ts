// lib/json.ts — tolerant extraction of a JSON payload from an LLM response.
//
// Root cause this fixes: Claude Haiku sometimes wraps its JSON in a Markdown
// code fence. The previous helper only stripped the fence when a CLOSING ```
// was present; on truncated / no-closing-fence output it returned the fenced
// text (leading backticks and all) and JSON.parse threw
// ("Unexpected token '`', "`json {...")". That single failure cascaded through
// the whole audit (risk_synthesis parse error -> mislabeled verdict, citation
// extraction returning nothing, propped-up confidence).
//
// Design:
//  1. Strip a LEADING code fence, tolerant of a missing closing fence.
//  2. Only strip a closing fence anchored at the END of the output, so a ```
//     that legitimately appears INSIDE a JSON string value cannot truncate an
//     otherwise-complete payload.
//  3. If the result parses, return it. Otherwise salvage the intended block:
//     prefer the first balanced OBJECT that parses (every LLM step in this app
//     returns a top-level object), fall back to the first parseable ARRAY, then
//     to any balanced block — so a stray "[1, 2]" token in a prose preamble is
//     not returned ahead of the real object.
export function extractJSON(text: string): string {
  let t = text.trim();
  // 1) Strip a leading Markdown code fence, tolerant of a MISSING closing fence (the bug).
  const open = t.match(/^```[a-zA-Z0-9]*\s*\n?/);
  if (open) {
    t = t.slice(open[0].length);
    // 2) Only strip an END-anchored closing fence. Using lastIndexOf("```") here
    //    would chop a complete payload whose string value contains ```.
    t = t.replace(/\s*```\s*$/, "").trim();
  }
  // 3a) If it now parses, done.
  try { JSON.parse(t); return t; } catch {}
  // 3b) Salvage a balanced block; string/escape aware.
  let firstBlock: string | null = null;
  let firstArray: string | null = null;
  let i = t.search(/[{[]/);
  while (i >= 0 && i < t.length) {
    const openCh = t[i];
    const closeCh = openCh === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < t.length; j++) {
      const c = t[j];
      if (inStr) {
        if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === openCh) depth++;
      else if (c === closeCh) { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end !== -1) {
      const block = t.slice(i, end + 1);
      if (firstBlock === null) firstBlock = block;
      let ok = false;
      try { JSON.parse(block); ok = true; } catch { /* not valid JSON */ }
      if (ok) {
        if (openCh === "{") return block;            // an object is the intended payload
        if (firstArray === null) firstArray = block; // remember array, keep looking for an object
      }
    }
    // Advance to the next candidate bracket. When this opener never closed (a stray or
    // truncated bracket), a LATER block — possibly of the other type — can still be the payload.
    const from = end !== -1 ? end + 1 : i + 1;
    const next = t.slice(from).search(/[{[]/);
    if (next < 0) break;
    i = from + next;
  }
  // Prefer a parseable array over an unparseable best-effort block; else hand back a block so
  // the caller's one-retry nudge still fires.
  return firstArray ?? firstBlock ?? t;
}

// Parse LLM-produced JSON, repairing the most common models' errors on a strict-parse failure.
// (Gemini in particular occasionally emits a trailing comma before } or ] -> "Expected
// double-quoted property name".) Only kicks in when strict JSON.parse fails; throws if still
// invalid so the caller's parse/retry path is preserved.
export function parseJSONLoose(s: string): any {
  try { return JSON.parse(s); } catch {}
  const repaired = s.replace(/,(\s*[}\]])/g, "$1"); // trailing comma before a closing brace/bracket
  return JSON.parse(repaired);
}
