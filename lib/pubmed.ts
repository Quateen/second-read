// lib/pubmed.ts — deterministic PubMed E-utilities verification
import { isStrongCitationMatch } from "./citation-match";
const UA = "SecondRead/1.0 (https://secondread.health; mailto:ahmed@nucleusdigitalis.com)";
const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const API_KEY = process.env.NCBI_API_KEY;

export type PubMedResult =
  | {
      status: "found";
      pmid: string;
      title?: string;
      authors?: string[];
      journal?: string;
      year?: number;
      abstract?: string;
      doi?: string;
      volume?: string;
      firstPage?: string;
      mismatchFields?: string[];
    }
  | { status: "not_found" }
  | { status: "error"; reason: "rate_limit" | "server" | "malformed" | "timeout" | "network"; detail?: string };

let lastCallAt = 0;
const minGapMs = () => (API_KEY ? 100 : 334); // 10/s with key, 3/s without

async function throttle() {
  const now = Date.now();
  const wait = lastCallAt + minGapMs() - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function eutilsFetch(
  path: string,
  params: Record<string, string>,
  timeoutMs = 8000
): Promise<Response | { error: PubMedResult }> {
  await throttle();
  const qs = new URLSearchParams({ ...params, ...(API_KEY ? { api_key: API_KEY } : {}) });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/${path}?${qs}`, {
      headers: { "User-Agent": UA, Accept: params.retmode === "xml" ? "application/xml" : "application/json" },
      signal: ctrl.signal,
    });
    if (res.status === 429) return { error: { status: "error", reason: "rate_limit" } };
    if (res.status >= 500) return { error: { status: "error", reason: "server", detail: `HTTP ${res.status}` } };
    return res;
  } catch (e: any) {
    if (e?.name === "AbortError") return { error: { status: "error", reason: "timeout" } };
    return { error: { status: "error", reason: "network", detail: String(e?.message ?? e) } };
  } finally {
    clearTimeout(t);
  }
}

function extractTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : undefined;
}

async function fetchAbstractAndDoi(pmid: string): Promise<{ abstract?: string; doi?: string }> {
  const r = await eutilsFetch("efetch.fcgi", { db: "pubmed", id: pmid, rettype: "abstract", retmode: "xml" });
  if ("error" in r) return {};
  try {
    const xml = await r.text();
    const abstract = extractTag(xml, "AbstractText");
    const doiMatch = xml.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/);
    return { abstract, doi: doiMatch?.[1] };
  } catch {
    return {};
  }
}

/** Verify a PubMed record by PMID; returns metadata + abstract. */
export async function verifyByPmid(pmid: string): Promise<PubMedResult> {
  const cleaned = pmid.trim().replace(/^PMID:?\s*/i, "");
  if (!/^\d+$/.test(cleaned)) return { status: "not_found" };
  const r = await eutilsFetch("esummary.fcgi", { db: "pubmed", id: cleaned, retmode: "json" });
  if ("error" in r) return r.error;
  let json: any;
  try {
    json = await r.json();
  } catch {
    return { status: "error", reason: "malformed" };
  }
  const rec = json?.result?.[cleaned];
  if (!rec || rec.error) return { status: "not_found" };
  const year = rec.pubdate ? parseInt(String(rec.pubdate).slice(0, 4), 10) || undefined : undefined;
  const authors = Array.isArray(rec.authors)
    ? rec.authors.map((a: any) => a?.name).filter(Boolean)
    : undefined;
  const extra = await fetchAbstractAndDoi(cleaned);
  return {
    status: "found",
    pmid: cleaned,
    title: rec.title,
    authors,
    journal: rec.fulljournalname || rec.source,
    year,
    abstract: extra.abstract,
    doi: extra.doi || rec.elocationid?.replace(/^doi:\s*/i, ""),
    volume: rec.volume ? String(rec.volume) : undefined,
    firstPage: rec.pages ? String(rec.pages).split(/[-–]/)[0].trim() : undefined,
  };
}

/** Find a PubMed record by citation fields, then confirm it actually matches the citation. */
export async function verifyByCitation(c: {
  author: string;
  year: number;
  title?: string;
  journal?: string;
  volume?: string;
  firstPage?: string;
}): Promise<PubMedResult> {
  // Anchor on volume + first page when available — they pin the exact paper regardless of how
  // the journal name is written. A hard "Full Journal Name"[Journal] filter returns 0 for names
  // PubMed indexes by NLM abbreviation (e.g. "New England Journal of Medicine"), so do NOT use it;
  // journal concordance is validated post-hoc by isStrongCitationMatch instead.
  const parts = [`${c.author}[Author]`, `${c.year}[PDAT]`];
  if (c.volume) parts.push(`${c.volume}[Volume]`);
  if (c.firstPage) parts.push(`${c.firstPage.replace(/^0+/, "")}[Page]`);
  if (!c.volume && c.title) parts.push(`${c.title.split(/\s+/).slice(0, 6).join(" ")}[Title]`);
  const term = parts.join(" AND ");
  const r = await eutilsFetch("esearch.fcgi", { db: "pubmed", term, retmode: "json", retmax: "5", sort: "relevance" });
  if ("error" in r) return r.error;
  let json: any;
  try {
    json = await r.json();
  } catch {
    return { status: "error", reason: "malformed" };
  }
  const ids: string[] = json?.esearchresult?.idlist ?? [];
  if (!ids.length) return { status: "not_found" };
  // Validate the top candidates; accept the first that actually concords with the citation.
  for (const id of ids.slice(0, 3)) {
    const top = await verifyByPmid(id);
    if (top.status === "error") return top;
    if (top.status !== "found") continue;
    if (!isStrongCitationMatch(
      { author: c.author, year: c.year, journal: c.journal, title: c.title, volume: c.volume, firstPage: c.firstPage },
      { authors: top.authors, year: top.year, journal: top.journal, title: top.title, volume: top.volume, firstPage: top.firstPage }
    )) continue;
    const mismatch: string[] = [];
    if (top.year && Math.abs(top.year - c.year) > 1) mismatch.push("year");
    if (c.journal && top.journal && !top.journal.toLowerCase().includes(c.journal.toLowerCase().split(/\s+/)[0])) mismatch.push("journal");
    return { ...top, mismatchFields: mismatch.length ? mismatch : undefined };
  }
  return { status: "not_found" };
}
