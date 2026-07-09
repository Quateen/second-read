import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { saveFeedback, newFeedbackId, type FeedbackRow } from "@/lib/store";
import { consumeFeedback } from "@/lib/rate-limit";
import { FeedbackSchema } from "@/lib/feedback";

export const runtime = "nodejs";

function getIp(req: NextRequest): string {
  const h = req.headers;
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd;
  return h.get("x-real-ip") || ((req as any).ip as string | undefined) || "anon";
}

// One-way hash so a row can be de-duplicated / rate-reasoned without ever storing a real IP.
function hashIp(ip: string): string {
  const salt = process.env.FEEDBACK_IP_SALT || "second-read-feedback";
  return createHash("sha256").update(salt + ":" + ip).digest("hex").slice(0, 16);
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = FeedbackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.flatten() }, { status: 400 });
  }

  const ip = getIp(req);
  if (!consumeFeedback(ip).ok) {
    return NextResponse.json({ error: "rate_limited", message: "Too much feedback from this address today." }, { status: 429 });
  }

  const row: FeedbackRow = {
    id: newFeedbackId(),
    audit_id: parsed.data.audit_id ?? null,
    rating: parsed.data.rating,
    reasons: parsed.data.reasons,
    comment: parsed.data.comment?.trim() || undefined,
    created_at: new Date().toISOString(),
    ip_hash: hashIp(ip),
  };

  const result = await saveFeedback(row);
  // 200 even when KV is off: the user's feedback is acknowledged (best-effort, per-instance). We
  // return `durable` so the client/telemetry can tell whether it was persisted.
  return NextResponse.json({ ok: true, id: row.id, durable: result.durable });
}
