export type ExtractedCitation = {
  raw: string;
  pmid?: string;
  doi?: string;
  author?: string;
  year?: number;
  journal?: string;
  title?: string;
};

const DOI_RE = /\b10\.\d{4,9}\/[\w.\-;()/:]+/gi;
const DOI_TRIM = /[.,;)\]]+$/;
const PMID_RE = /\bPMID:?\s*(\d{4,9})\b/gi;
const PARENS_RE = /\(([A-Z][a-zA-Z'-]+(?:\s+(?:et al\.?|and\s+[A-Z][a-zA-Z'-]+))?)[,;]?\s*([^,)]+?)?[,;]?\s*(19|20)(\d{2})\)/g;

export function extractCitations(text: string): ExtractedCitation[] {
  const out: ExtractedCitation[] = [];
  const seen = new Set<string>();
  const dois = text.match(DOI_RE) || [];
  for (const raw of dois) {
    const d = raw.replace(DOI_TRIM, "");
    const key = "doi:" + d.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, doi: d });
  }
  let m: RegExpExecArray | null;
  PMID_RE.lastIndex = 0;
  while ((m = PMID_RE.exec(text)) !== null) {
    const pmid = m[1];
    const key = "pmid:" + pmid;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: m[0], pmid });
  }
  PARENS_RE.lastIndex = 0;
  while ((m = PARENS_RE.exec(text)) !== null) {
    const author = m[1].replace(/\s+et al\.?$/, "").split(/\s+and\s+/)[0].trim();
    const journal = m[2]?.trim();
    const year = Number(m[3] + m[4]);
    const key = "parens:" + author.toLowerCase() + "|" + year + "|" + (journal || "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: m[0], author, year, journal });
  }
  return out.slice(0, 30);
}

const DRUG_RE = /\b([A-Z][a-zA-Z0-9-]{4,}|[a-z][a-zA-Z0-9-]{5,})\b(?=[^\n]{0,15}\b(mg|mcg|g\/dL|mg\/kg|mg\/m2|units|U\/kg|mL\/kg|mL\/hr)\b)/g;
const DRUG_STOPWORDS = new Set<string>(["patient","given","initial","initiate","initiated","starting","started","including","include","followed","infusion","bolus","tablet","tablets","oral","intravenous","subcutaneous","every","daily","dosing","regimen","therapy","treatment","weight","kilogram","kilograms","approximately","around"]);

export function extractDrugCandidates(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  DRUG_RE.lastIndex = 0;
  while ((m = DRUG_RE.exec(text)) !== null) {
    const w = m[1];
    if (DRUG_STOPWORDS.has(w.toLowerCase())) continue;
    out.add(w);
  }
  return Array.from(out).slice(0, 15);
}
