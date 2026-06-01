import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runAudit } from "@/lib/audit-pipeline";
import { consume } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_INPUT_CHARS = Number(process.env.MAX_AUDIT_INPUT_CHARS || 10000);
const BodySchema = z.object({
  input: z.string().min(20).max(MAX_INPUT_CHARS),
  specialty: z.enum(["neuro", "other"]).default("neuro"),
});

function getIp(req: NextRequest): string {
  const fromRuntime = (req as any).ip as string | undefined;
  if (fromRuntime) return fromRuntime;
  if (process.env.VERCEL) return "vercel-no-ip";
  const h = req.headers;
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "anon";
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
  const rl = consume(ip);
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited", message: "Daily free tier limit reached. Resets at " + new Date(rl.resetAt).toISOString() }, { status: 429 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "missing_anthropic_key" }, { status: 503 });
  }
  try {
    const audit = await runAudit(parsed.data.input, { specialty: parsed.data.specialty });
    return NextResponse.json(audit, {
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
