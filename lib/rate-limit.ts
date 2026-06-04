// lib/rate-limit.ts — daily audit cap per IP.
//
// Durable mode: if Upstash/Vercel KV REST credentials are present
// (KV_REST_API_URL + KV_REST_API_TOKEN), the counter lives in Redis and is
// shared across all serverless instances and cold starts.
//
// Fallback mode: if KV is not configured, it degrades to an in-memory Map
// (best-effort, per-instance) so the app still runs with zero setup.

const LIMIT = Number(process.env.DAILY_AUDIT_LIMIT_PER_IP || 5);
const DAY_SECONDS = 24 * 60 * 60;

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
export const isDurable = !!(KV_URL && KV_TOKEN);

export type RateResult = { ok: boolean; remaining: number; resetAt: number; limit: number; durable: boolean };

// --- In-memory fallback ----------------------------------------------------
const buckets = new Map<string, { count: number; resetAt: number }>();
function consumeMemory(ip: string): RateResult {
  const now = Date.now();
  const dayMs = DAY_SECONDS * 1000;
  const b = buckets.get(ip);
  if (!b || b.resetAt < now) {
    const fresh = { count: 1, resetAt: now + dayMs };
    buckets.set(ip, fresh);
    return { ok: true, remaining: LIMIT - 1, resetAt: fresh.resetAt, limit: LIMIT, durable: false };
  }
  if (b.count >= LIMIT) return { ok: false, remaining: 0, resetAt: b.resetAt, limit: LIMIT, durable: false };
  b.count += 1;
  return { ok: true, remaining: LIMIT - b.count, resetAt: b.resetAt, limit: LIMIT, durable: false };
}

// --- Durable (Upstash/Vercel KV) -------------------------------------------
async function kv(cmd: (string | number)[]): Promise<any> {
  const res = await fetch(KV_URL!, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`KV ${res.status}`);
  const json = await res.json();
  return json.result;
}

async function consumeDurable(ip: string): Promise<RateResult> {
  // Day-bucketed key so it naturally resets and TTL cleans it up.
  const day = Math.floor(Date.now() / 1000 / DAY_SECONDS);
  const key = `audit:rl:${day}:${ip}`;
  const count = Number(await kv(["INCR", key]));
  if (count === 1) await kv(["EXPIRE", key, DAY_SECONDS]);
  const ttl = Number(await kv(["TTL", key]));
  const resetAt = Date.now() + (ttl > 0 ? ttl : DAY_SECONDS) * 1000;
  if (count > LIMIT) return { ok: false, remaining: 0, resetAt, limit: LIMIT, durable: true };
  return { ok: true, remaining: Math.max(0, LIMIT - count), resetAt, limit: LIMIT, durable: true };
}

export async function consume(ip: string): Promise<RateResult> {
  if (!isDurable) return consumeMemory(ip);
  try {
    return await consumeDurable(ip);
  } catch {
    // If KV is briefly unreachable, fail open to in-memory rather than blocking audits.
    return consumeMemory(ip);
  }
}
