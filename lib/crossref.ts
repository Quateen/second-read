// lib/crossref.ts — deterministic CrossRef DOI verification
import { isStrongCitationMatch } from "./citation-match";
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
      volume?: string;
      firstPage?: string;
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
  const volume = w.volume ? String(w.volume) : undefined;
  const firstPage = w.page ? String(w.page).split(/[-–]/)[0].trim() : undefined;
  return { status: "found", doi: w.DOI, title, authors, journal, year, type: w.type, volume, firstPage };
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

/** Search CrossRef by citation fields, then confirm a candidate actually matches. */
export async function verifyByQuery(c: {
  author: string;
  year: number;
  title?: string;
  journal?: string;
  volume?: string;
  firstPage?: string;
}): Promise<CrossRefResult> {
  const params = new URLSearchParams({
    "query.author": c.author,
    "query.bibliographic": [c.title, c.journal].filter(Boolean).join(" "),
    // +/-1 year window to match isStrongCitationMatch's tolerance.
    filter: `from-pub-date:${c.year - 1}-01-01,until-pub-date:${c.year + 1}-12-31`,
    rows: "8",
  });
  const r = await crFetch(`${BASE}/works?${params}`);
  if (r?.error) return r.error;
  const items: any[] = r?.message?.items ?? [];
  if (!items.length) return { status: "not_found" };
  // CrossRef returns a best-relevance hit for almost any author/year query, so the top item is
  // NOT proof. Accept the first candidate whose volume+page, journal, or title actually concords
  // with the citation; if none do, the citation is unverified (fabricated-citation defense).
  for (const item of items.slice(0, 8)) {
    const norm = normalizeWork(item);
    if (norm && isStrongCitationMatch(
      { author: c.author, year: c.year, journal: c.journal, title: c.title, volume: c.volume, firstPage: c.firstPage },
      { authors: norm.authors, year: norm.year, journal: norm.journal, title: norm.title, volume: norm.volume, firstPage: norm.firstPage }
    )) {
      return norm;
    }
  }
  return { status: "not_found" };
}
