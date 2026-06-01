import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const BodySchema = z.object({
  email: z.string().email(),
  role: z.string().max(120).optional(),
  specialty: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
  source: z.string().max(80).default("landing"),
  website: z.string().max(0).optional().default(""),
});

const leadBuckets = new Map<string, { count: number; resetAt: number }>();
function leadAllowed(ip: string) {
  const now = Date.now();
  const b = leadBuckets.get(ip);
  if (!b || b.resetAt < now) { leadBuckets.set(ip, { count: 1, resetAt: now + 3600000 }); return true; }
  if (b.count >= 5) return false;
  b.count++; return true;
}

export async function POST(req: NextRequest) {
  const ip = ((req as any).ip as string | undefined) ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon";
  if (!leadAllowed(ip)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.website) return NextResponse.json({ ok: true });
  const lead = { ...parsed.data, capturedAt: new Date().toISOString() };
  const resendKey = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_NOTIFICATION_EMAIL;
  if (resendKey && to) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(resendKey);
      await resend.emails.send({
        from: "Second Read <leads@secondread.health>",
        to,
        subject: "New lead - " + lead.email + " (" + lead.source + ")",
        text: JSON.stringify(lead, null, 2),
      });
    } catch (e: any) {
      console.error("[lead] resend failure:", e?.message ?? e);
    }
  } else {
    console.log("[lead] new lead:", JSON.stringify(lead));
  }
  return NextResponse.json({ ok: true });
}
