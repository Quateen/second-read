// Unified multi-provider LLM layer for the Second Read ensemble.
// Supports Anthropic (Claude), OpenAI (GPT), and Google (Gemini) behind one
// JSON-returning interface. Each provider is optional: if its API key is not
// set, isProviderAvailable() returns false and the ensemble simply uses the
// providers that ARE configured. Claude remains the primary/required provider.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
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
      generationConfig: { temperature, maxOutputTokens: maxTokens, responseMimeType: "application/json" },
    });
    const res = await withTimeout(model.generateContent(prompt), timeoutMs);
    const text = res.response.text();
    const um = res.response.usageMetadata;
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
  if (first.ok || first.reason !== "parse" || !retryOnParse) return first;
  return attempt("Your previous response failed to parse as JSON. Return STRICT valid JSON only.");
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
