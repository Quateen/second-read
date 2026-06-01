// lib/crossref.ts — deterministic CrossRef DOI verification
const UA = "SecondRead/1.0 (https://secondread.health; mailto:ahmed@nucleusdigitalis.com)";
const BASE = "https://api.crossref.org";

export type CrossRefResult =
  | {
      status: "found";
      doi: string;
      title?: string;
      authors?: string[];
      journal?: string;
      year?: number;
      type?: string;
    }
  | { status: "not_found" }
  | { status: "error"; reason: "rate_limit" | "server" | "malformed" | "timeout" | "network"; detail?: string };

async function crFetch(url: string, timeoutMs = 8000): Promise<any | { error: CrossRefResult }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (res.status === 404) return { error: { status: "not_found" } };
    if (res.status === 429) return { error: { status: "error", reason: "rate_limit" } };
    if (res.status >= 500) return { error: { status: "error", reason: "server", detail: `HTTP ${res.status}` } };
    if (!res.ok) return { error: { status: "error", reason: "server", detail: `HTTP ${res.status}` } };
    try {
      return await res.json();
    } catch {
      return { error: { status: "error", reason: "malformed" } };
    }
  } catch (e: any) {
    if (e?.name === "AbortError") return { error: { status: "error", reason: "timeout" } };
    return { error: { status: "error", reason: "network", detail: String(e?.message ?? e) } };
  } finally {
    clearTimeout(t);
  }
}

function normalizeWork(w: any): Extract<CrossRefResult, { status: "found" }> | null {
  if (!w?.DOI) return null;
  const title = Array.isArray(w.title) ? w.title[0] : undefined;
  const authors = Array.isArray(w.author)
    ? w.author.map((a: any) => [a.given, a.family].filter(Boolean).join(" ").trim() || a.name).filter(Boolean)
    : undefined;
  const journal = Array.isArray(w["container-title"]) ? w["container-title"][0] : undefined;
  const dateParts =
    w.issued?.["date-parts"]?.[0] ||
    w["published-print"]?.["date-parts"]?.[0] ||
    w["published-online"]?.["date-parts"]?.[0];
  const year = Array.isArray(dateParts) && dateParts[0] ? Number(dateParts[0]) : undefined;
  return { status: "found", doi: w.DOI, title, authors, journal, year, type: w.type };
}

/** Verify a work by DOI via CrossRef. */
export async function verifyByDoi(doi: string): Promise<CrossRefResult> {
  const cleaned = doi.trim().replace(/^doi:\s*/i, "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  if (!cleaned) return { status: "not_found" };
  const r = await crFetch(`${BASE}/works/${encodeURIComponent(cleaned)}`);
  if (r?.error) return r.error;
  const work = r?.message;
  const norm = normalizeWork(work);
  return norm ?? { status: "not_found" };
}

/** Search CrossRef by author/year/title/journal; returns top match. */
export async function verifyByQuery(c: {
  author: string;
  year: number;
  title?: string;
  journal?: string;
}): Promise<CrossRefResult> {
  const params = new URLSearchParams({
    "query.author": c.author,
    "query.bibliographic": [c.title, c.journal].filter(Boolean).join(" "),
    filter: `from-pub-date:${c.year}-01-01,until-pub-date:${c.year}-12-31`,
    rows: "5",
  });
  const r = await crFetch(`${BASE}/works?${params}`);
  if (r?.error) return r.error;
  const items: any[] = r?.message?.items ?? [];
  if (!items.length) return { status: "not_found" };
  const norm = normalizeWork(items[0]);
  return norm ?? { status: "not_found" };
}
