import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runAudit } from "@/lib/audit-pipeline";
import { consume } from "@/lib/rate-limit";
import { saveAudit } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_INPUT_CHARS = Number(process.env.MAX_AUDIT_INPUT_CHARS || 10000);
const BodySchema = z.object({
  input: z.string().min(20).max(MAX_INPUT_CHARS),
  specialty: z.enum(["neuro", "other"]).default("neuro"),
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
  const rl = await consume(ip);
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
