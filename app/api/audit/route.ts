import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runAudit } from "@/lib/audit-pipeline";
import { consume, isEvalBypass } from "@/lib/rate-limit";
import { saveAudit } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_INPUT_CHARS = Number(process.env.MAX_AUDIT_INPUT_CHARS || 10000);
const BodySchema = z.object({
  input: z.string().min(20).max(MAX_INPUT_CHARS),
  // Optional and inert: the UI no longer collects a specialty. It is accepted for API
  // back-compat but does NOT affect scoring — verification (PubMed/CrossRef/RxNorm) is
  // specialty-agnostic, and specialty_match is informational only. See runAudit.
  specialty: z.string().max(60).optional(),
});

function getIp(req: NextRequest): string {
  const h = req.headers;
  // On Vercel, x-forwarded-for is the real client chain; take the first hop.
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd;
  const real = h.get("x-real-ip");
  if (real) return real;
  const fromRuntime = (req as any).ip as string | undefined;
  return fromRuntime || "anon";
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.flatten() }, { status: 400 });
  }
  const ip = getIp(req);
  // Evaluation bypass: the golden-set harness sends x-eval-token to skip the daily cap so all 50
  // cases can run. Only active when EVAL_BYPASS_TOKEN is set and the header matches exactly.
  const bypass = isEvalBypass(req.headers.get("x-eval-token"), process.env.EVAL_BYPASS_TOKEN);
  const rl = bypass
    ? { ok: true, remaining: 9999, resetAt: Date.now() + 86_400_000, limit: 9999, durable: false }
    : await consume(ip);
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited", message: "Daily free tier limit reached. Resets at " + new Date(rl.resetAt).toISOString() }, { status: 429 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "missing_anthropic_key" }, { status: 503 });
  }
  try {
    const audit = await runAudit(parsed.data.input, { specialty: parsed.data.specialty });
    // Persist for a shareable link if KV is configured (no-op otherwise).
    const shareId = await saveAudit(audit);
    return NextResponse.json({ ...audit, shareId }, {
      headers: {
        "X-RateLimit-Limit": String(rl.limit),
        "X-RateLimit-Remaining": String(rl.remaining),
        "X-RateLimit-Reset": String(rl.resetAt),
      },
    });
  } catch (e: any) {
    console.error("[audit] error:", e);
    return NextResponse.json({ error: "audit_failed", message: e?.message || "Unknown" }, { status: 500 });
  }
}
