// lib/rate-limit.ts — in-memory daily cap per IP. Best-effort, per Vercel instance.
const buckets = new Map<string, { count: number; resetAt: number }>();

const LIMIT = Number(process.env.DAILY_AUDIT_LIMIT_PER_IP || 5);

export function consume(ip: string): { ok: boolean; remaining: number; resetAt: number; limit: number } {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const b = buckets.get(ip);
  if (!b || b.resetAt < now) {
    const fresh = { count: 1, resetAt: now + dayMs };
    buckets.set(ip, fresh);
    return { ok: true, remaining: LIMIT - 1, resetAt: fresh.resetAt, limit: LIMIT };
  }
  if (b.count >= LIMIT) return { ok: false, remaining: 0, resetAt: b.resetAt, limit: LIMIT };
  b.count += 1;
  return { ok: true, remaining: LIMIT - b.count, resetAt: b.resetAt, limit: LIMIT };
}
