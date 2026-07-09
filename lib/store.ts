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

// --- Per-audit feedback ----------------------------------------------------
// A feedback row stores ONLY the rating, the reason chips, an optional free-text comment, and a
// HASHED ip — never the audited clinical input, and never anything patient-identifying. Feedback
// rows expire after this many seconds (default 180 days — they are longer-lived than a share link
// because they are training signal, not a transient artifact).
const FEEDBACK_TTL_SECONDS = Number(process.env.FEEDBACK_TTL_SECONDS || 180 * 24 * 60 * 60);

export type FeedbackRow = {
  id: string;
  audit_id: string | null;
  rating: "up" | "down";
  reasons: string[];
  comment?: string;
  created_at: string; // ISO 8601
  ip_hash: string;
};

// Best-effort in-memory fallback when KV is not configured (per serverless instance). It is also
// what the unit test reads back to prove a row was persisted without needing a live KV.
const feedbackMemory = new Map<string, FeedbackRow>();

export function newFeedbackId(): string {
  return shortId();
}

function reasonSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "other";
}

/**
 * Persist one feedback row and bump aggregate counters. Stores metadata + rating + reasons ONLY —
 * NEVER the raw clinical input (that text never reaches this function).
 *
 * FUTURE (do NOT build here): these rows are the intended untrusted-exemplar corpus for a later RAG
 * layer — a physician marking "missed a real problem" or "false alarm" is a labeled failure case
 * the auditor can learn from. This function only durably records the signal; no retrieval,
 * embedding, or prompt-injection of these exemplars is done anywhere in this codebase yet.
 */
export async function saveFeedback(row: FeedbackRow): Promise<{ ok: boolean; durable: boolean }> {
  if (!persistenceEnabled) {
    feedbackMemory.set(row.id, row);
    return { ok: true, durable: false };
  }
  try {
    await kv(["SET", `feedback:doc:${row.id}`, JSON.stringify(row), "EX", FEEDBACK_TTL_SECONDS]);
    await kv(["INCR", `feedback:count:${row.rating}`]);
    for (const r of row.reasons.slice(0, 12)) await kv(["INCR", `feedback:reason:${reasonSlug(r)}`]);
    return { ok: true, durable: true };
  } catch {
    feedbackMemory.set(row.id, row); // don't lose the signal on a transient KV error
    return { ok: false, durable: false };
  }
}

/** Load a feedback row by id (used by tests + potential future admin views). */
export async function loadFeedback(id: string): Promise<FeedbackRow | null> {
  if (!persistenceEnabled) return feedbackMemory.get(id) ?? null;
  try {
    const raw = await kv(["GET", `feedback:doc:${id}`]);
    return raw ? (JSON.parse(raw) as FeedbackRow) : null;
  } catch {
    return feedbackMemory.get(id) ?? null;
  }
}
