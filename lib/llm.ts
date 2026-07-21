// Unified multi-provider LLM layer for the Second Read ensemble.
// Supports Anthropic (Claude), OpenAI (GPT), and Google (Gemini) behind one
// JSON-returning interface. Each provider is optional: if its API key is not
// set, isProviderAvailable() returns false and the ensemble simply uses the
// providers that ARE configured. Claude remains the primary/required provider.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { SYSTEM_PROMPT } from "./prompts";
import { extractJSON, parseJSONLoose } from "./json";

export type Provider = "claude" | "gpt" | "gemini";

export type LLMJsonResult<T> =
  | { ok: true; provider: Provider; data: T; usage: { input_tokens: number; output_tokens: number } }
  | { ok: false; provider: Provider; reason: "parse" | "api" | "empty" | "no_key"; detail?: string };

// Gemini's key is read from GOOGLE_API_KEY (the name set in Vercel) with GEMINI_API_KEY as a
// backward-compatible fallback — otherwise the provider stays dormant and the ensemble silently
// runs at 2 models instead of 3.
const GOOGLE_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

const MODELS: Record<Provider, string> = {
  claude: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
  // Fast/cheap voter. gpt-4o-mini occasionally over-votes benign content, but the bounded
  // lone-outlier cap in decideFinalTier (ensemble.ts) neutralizes that without the latency/cost of a
  // bigger model. Override via OPENAI_MODEL if desired.
  gpt: process.env.OPENAI_MODEL || "gpt-4o-mini",
  gemini: process.env.GEMINI_MODEL || process.env.GOOGLE_MODEL || "gemini-1.5-flash",
};

export function isProviderAvailable(p: Provider): boolean {
  if (p === "claude") return !!process.env.ANTHROPIC_API_KEY;
  if (p === "gpt") return !!process.env.OPENAI_API_KEY;
  if (p === "gemini") return !!GOOGLE_KEY;
  return false;
}

/** List of providers that are configured, Claude always first. */
export function availableProviders(): Provider[] {
  return (["claude", "gpt", "gemini"] as Provider[]).filter(isProviderAvailable);
}

// --- Lazy singletons -------------------------------------------------------
let _anthropic: Anthropic | null = null;
let _openai: OpenAI | null = null;
let _gemini: GoogleGenerativeAI | null = null;

function anthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  return _anthropic;
}
function openai(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  return _openai;
}
function gemini(): GoogleGenerativeAI {
  if (!_gemini) _gemini = new GoogleGenerativeAI(GOOGLE_KEY!);
  return _gemini;
}

// Gemini's safety filters otherwise block legitimate CLINICAL content (drug names, doses,
// procedures) under HARM_CATEGORY_DANGEROUS_CONTENT — silently dropping Gemini's vote so the
// ensemble runs at 2 models. This is an education-only clinical-AI auditor that MUST be able to read
// medical text, so the categories are set to BLOCK_NONE. (Fail-closed lives downstream in the tier
// vote, not here — Gemini refusing to read a drug name is a reliability bug, not a safety feature.)
const GEMINI_SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// Extract text from a Gemini response WITHOUT throwing. The SDK's response.text() throws a
// GoogleGenerativeAIResponseError when the candidate was blocked / finished on SAFETY / has no text
// part — which previously surfaced as an "api" error and dropped Gemini's vote. Read it defensively:
// try text(), then fall back to joining candidate parts, then return "" (-> a retryable "empty").
function geminiText(res: any): string {
  try {
    const t = res?.response?.text?.();
    if (typeof t === "string" && t.trim()) return t;
  } catch { /* blocked / no-text candidate — fall through to manual extraction */ }
  const parts = res?.response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const joined = parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
    if (joined.trim()) return joined;
  }
  return "";
}

type CallOpts = {
  temperature?: number;
  maxTokens?: number;
  system?: string;
  timeoutMs?: number;
  retryOnParse?: boolean;
};

export async function callLLMJSON<T = unknown>(
  provider: Provider,
  userPrompt: string,
  opts: CallOpts = {}
): Promise<LLMJsonResult<T>> {
  if (!isProviderAvailable(provider)) return { ok: false, provider, reason: "no_key" };
  const temperature = opts.temperature ?? 0.2;
  const maxTokens = opts.maxTokens ?? 2000;
  const system = opts.system ?? SYSTEM_PROMPT;
  const timeoutMs = opts.timeoutMs ?? 22000;
  const retryOnParse = opts.retryOnParse ?? true;

  const runRaw = async (extraNudge?: string): Promise<{ text: string; usage: { input_tokens: number; output_tokens: number } }> => {
    const prompt = extraNudge ? userPrompt + "\n\n" + extraNudge : userPrompt;
    if (provider === "claude") {
      const res = await anthropic().messages.create(
        { model: MODELS.claude, max_tokens: maxTokens, temperature, system, messages: [{ role: "user", content: prompt }] },
        { timeout: timeoutMs }
      );
      const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      return { text, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens } };
    }
    if (provider === "gpt") {
      const res = await openai().chat.completions.create(
        {
          model: MODELS.gpt,
          temperature,
          // Fixed seed -> reproducible categorical votes across runs (Step 1 determinism). OpenAI is
          // the only provider with a seed param; Claude/Gemini rely on temperature 0. Best-effort:
          // the API does not guarantee identical output, but it substantially reduces sampling drift.
          seed: 1729,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        },
        { timeout: timeoutMs }
      );
      const text = res.choices[0]?.message?.content ?? "";
      return {
        text,
        usage: { input_tokens: res.usage?.prompt_tokens ?? 0, output_tokens: res.usage?.completion_tokens ?? 0 },
      };
    }
    // gemini
    const model = gemini().getGenerativeModel({
      model: MODELS.gemini,
      systemInstruction: system,
      safetySettings: GEMINI_SAFETY,
      // maxOutputTokens tracks the caller's maxTokens (the synth vote passes 3500, matching Claude's
      // synth cap) so a long tier rationale is not truncated mid-JSON. responseMimeType forces the
      // decoder into JSON mode; extractJSON + parseJSONLoose + the retry below still guard the parse.
      generationConfig: { temperature, maxOutputTokens: maxTokens, responseMimeType: "application/json" },
    });
    const res = await withTimeout(model.generateContent(prompt), timeoutMs);
    const text = geminiText(res);
    const um = res.response?.usageMetadata;
    return { text, usage: { input_tokens: um?.promptTokenCount ?? 0, output_tokens: um?.candidatesTokenCount ?? 0 } };
  };

  const attempt = async (extraNudge?: string): Promise<LLMJsonResult<T>> => {
    try {
      const { text, usage } = await runRaw(extraNudge);
      if (!text.trim()) return { ok: false, provider, reason: "empty" };
      const jsonStr = extractJSON(text);
      try {
        return { ok: true, provider, data: parseJSONLoose(jsonStr) as T, usage };
      } catch (e: any) {
        return { ok: false, provider, reason: "parse", detail: String(e?.message ?? e) };
      }
    } catch (e: any) {
      return { ok: false, provider, reason: "api", detail: String(e?.message ?? e) };
    }
  };

  const first = await attempt();
  // Retry once on a parse failure, an empty/blocked response, OR a transient api error. All three are
  // commonly transient (a truncated JSON, a momentary empty Gemini candidate, a 429/5xx or brief
  // timeout). Retrying "api" is what keeps a fast provider (Gemini-flash) IN the quorum: a dropped
  // Gemini vote lowers lowCount below the lone-outlier cap's threshold, so an isolated gpt over-vote
  // on CLEAN content stands as SIGNIFICANT — the dominant reproducibility failure. The retry is still
  // bounded by the caller's quorum window (runQuorum's quorumTimeoutMs), so a genuine outage or a
  // slow provider that cannot fit a second attempt is simply dropped as before — no latency regression.
  const retryable = !first.ok && (first.reason === "parse" || first.reason === "empty" || first.reason === "api");
  if (first.ok || !retryable || !retryOnParse) return first;
  const nudge = first.reason === "empty"
    ? "Your previous response was empty. Return the requested STRICT valid JSON now, with no preamble."
    : first.reason === "parse"
    ? "Your previous response failed to parse as JSON. Return STRICT valid JSON only."
    : undefined; // transient api error — retry the same call, no nudge
  return attempt(nudge);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`provider timeout after ${ms}ms`)), ms)),
  ]);
}

// Re-exported from ./json (single source of truth) so existing importers of
// `extractJSON` from this module keep working.
export { extractJSON };
