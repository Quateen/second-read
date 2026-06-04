// lib/store.ts — optional audit persistence + shareable links.
//
// If Upstash/Vercel KV REST credentials are present (KV_REST_API_URL +
// KV_REST_API_TOKEN), completed audits are saved under a short random id and
// can be retrieved later at /a/<id>. Without KV, persistence is disabled and
// saveAudit() returns null (the app still works, just no shareable link).

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
export const persistenceEnabled = !!(KV_URL && KV_TOKEN);

// Saved audits expire after this many seconds (default 30 days).
const TTL_SECONDS = Number(process.env.AUDIT_SHARE_TTL_SECONDS || 30 * 24 * 60 * 60);

async function kv(cmd: (string | number)[]): Promise<any> {
  const res = await fetch(KV_URL!, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`KV ${res.status}`);
  return (await res.json()).result;
}

function shortId(): string {
  // URL-safe 10-char id.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

/** Save an audit envelope; returns its share id, or null if persistence is off. */
export async function saveAudit(envelope: unknown): Promise<string | null> {
  if (!persistenceEnabled) return null;
  try {
    const id = shortId();
    await kv(["SET", `audit:doc:${id}`, JSON.stringify(envelope), "EX", TTL_SECONDS]);
    return id;
  } catch {
    return null;
  }
}

/** Load a saved audit by id, or null if not found / persistence off. */
export async function loadAudit(id: string): Promise<any | null> {
  if (!persistenceEnabled) return null;
  if (!/^[a-z0-9]{1,16}$/i.test(id)) return null;
  try {
    const raw = await kv(["GET", `audit:doc:${id}`]);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
