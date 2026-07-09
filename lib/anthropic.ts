import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompts";
import { extractJSON } from "./json";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  _client = new Anthropic({ apiKey: key });
  return _client;
}

export type ClaudeJsonResult<T> =
  | { ok: true; data: T; usage: { input_tokens: number; output_tokens: number } }
  | { ok: false; reason: "parse" | "api" | "empty"; detail?: string };

export async function callClaudeJSON<T = unknown>(
  userPrompt: string,
  opts: { temperature?: number; maxTokens?: number; system?: string; timeoutMs?: number; retryOnParse?: boolean } = {}
): Promise<ClaudeJsonResult<T>> {
  const temperature = opts.temperature ?? 0.2;
  const max_tokens = opts.maxTokens ?? 2000;
  const system = opts.system ?? SYSTEM_PROMPT;
  // Per-call timeout so a single slow Anthropic response can't stall the whole audit.
  const timeoutMs = opts.timeoutMs ?? 22000;
  const retryOnParse = opts.retryOnParse ?? true;
  const attempt = async (extraNudge?: string): Promise<ClaudeJsonResult<T>> => {
    try {
      const res = await client().messages.create(
        {
          model: MODEL,
          max_tokens,
          temperature,
          system,
          messages: [{ role: "user", content: extraNudge ? userPrompt + "\n\n" + extraNudge : userPrompt }],
        },
        { timeout: timeoutMs }
      );
      const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      if (!text.trim()) return { ok: false, reason: "empty" };
      const jsonStr = extractJSON(text);
      try {
        return {
          ok: true,
          data: JSON.parse(jsonStr) as T,
          usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
        };
      } catch (e: any) {
        return { ok: false, reason: "parse", detail: String(e?.message ?? e) };
      }
    } catch (e: any) {
      return { ok: false, reason: "api", detail: String(e?.message ?? e) };
    }
  };
  const first = await attempt();
  if (first.ok || first.reason !== "parse" || !retryOnParse) return first;
  return attempt("Your previous response failed to parse as JSON. Return STRICT valid JSON only.");
}
