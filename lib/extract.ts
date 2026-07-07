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
// Vancouver-style bibliographic form: "Surname AB, Surname CD. Journal Name. YEAR;vol:pages".
// PARENS_RE only fires when the year sits immediately before ')', so it misses this
// extremely common citation shape (e.g. the FAB-01 test case). Catch it deterministically
// so PubMed/CrossRef verification runs on it even when the LLM extractor returns nothing.
// The first author's initials are REQUIRED (real Vancouver refs always have them) — this
// rejects ordinary "Capword. Capword. YEAR;n" prose. The author-list repeat is bounded to
// keep matching linear regardless of the (operator-configurable) input length.
const VANCOUVER_RE =
  /\b([A-Z][A-Za-z'’-]+)\s+[A-Z]{1,3}\.?(?:\s*,\s*[A-Z][A-Za-z'’-]+(?:\s+[A-Z]{1,3}\.?)?|\s*,?\s*et al\.?){0,20}\.\s+([A-Z][A-Za-z0-9 .,&:'’/()-]{3,90}?)\.\s+((?:19|20)\d{2})\s*;\s*\d/g;

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
  VANCOUVER_RE.lastIndex = 0;
  while ((m = VANCOUVER_RE.exec(text)) !== null) {
    const author = m[1].trim();
    const journal = m[2].trim();
    const year = Number(m[3]);
    // Share the parenthetical namespace so the same citation isn't double-counted.
    const key = "parens:" + author.toLowerCase() + "|" + year + "|" + journal.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: m[0].trim(), author, year, journal });
  }
  return out.slice(0, 30);
}

const DRUG_RE = /\b([A-Z][a-zA-Z0-9-]{4,}|[a-z][a-zA-Z0-9-]{5,})\b(?=[^\n]{0,15}\b(mg|mcg|g\/dL|mg\/kg|mg\/m2|units|U\/kg|mL\/kg|mL\/hr)\b)/g;
const DRUG_STOPWORDS = new Set<string>([
  // dosing / administration nouns
  "patient","given","initial","initiate","initiated","starting","started","including","include",
  "followed","infusion","bolus","tablet","tablets","capsule","capsules","oral","intravenous",
  "subcutaneous","intramuscular","every","daily","dosing","dose","doses","dosage","regimen",
  "therapy","treatment","weight","kilogram","kilograms","approximately","around",
  // clinical ACTION VERBS that commonly precede a dose (the 'titrate' class of false positives)
  "titrate","titrated","titrating","administer","administered","administering","increase",
  "increased","increasing","decrease","decreased","decreasing","reduce","reduced","reducing",
  "target","targeted","targeting","maintain","maintained","maintaining","adjust","adjusted",
  "escalate","escalated","escalating","taper","tapered","tapering","continue","continued",
  "repeat","repeated","consider","prescribe","prescribed","recommend","recommended","receive",
  "received","receiving","deliver","delivered","exceed","exceeding","maximum","minimum",
  // misc clinical context words near units
  "baseline","interval","between","within","additional","further","second","third","another",
]);

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
