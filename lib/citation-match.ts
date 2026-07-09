// lib/citation-match.ts — decide whether a retrieved PubMed/CrossRef record actually
// corresponds to the CITED work. Author+year alone is NOT enough: a fabricated citation can
// share an author and year with a real paper, and CrossRef returns a best-relevance hit for
// almost any author query. Require year concordance plus a strong journal OR title match, using
// abbreviation-aware token overlap so "J Neurosurg Spine" still matches "Journal of
// Neurosurgery: Spine", but a fabricated "Journal of Spinal Neurotrauma" does NOT match the real
// "Journal of Neurotrauma".

export type CitedRef = { author?: string; year?: number; journal?: string; title?: string; volume?: string; firstPage?: string };
export type FoundRef = { authors?: string[]; year?: number; journal?: string; title?: string; volume?: string; firstPage?: string };

function samePage(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return a.replace(/^0+/, "").toLowerCase() === b.replace(/^0+/, "").toLowerCase();
}

const STOPWORDS = new Set([
  "the", "of", "and", "for", "an", "in", "on", "to", "journal", "journals",
  "review", "reviews", "annals", "proceedings", "official", "international",
  "american", "european", "british", "society", "association",
]);

// Fold diacritics so "Müller"/"Muller" and accented journal words compare equal.
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function tokens(s?: string): string[] {
  if (!s) return [];
  return fold(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Exact equality OR abbreviation prefix (>= 3 chars) so the 3-letter stem "med" matches
// "medicine" (N Engl J Med, Crit Care Med) and "neurosurg" matches "neurosurgery", but
// "spinal" does NOT match "neurotrauma".
function tokenMatches(c: string, f: string): boolean {
  if (c === f) return true;
  return c.length >= 3 && f.length >= 3 && (f.startsWith(c) || c.startsWith(f));
}

function overlapRatio(cited: string[], found: string[]): number {
  if (!cited.length) return 0;
  let hit = 0;
  for (const c of cited) if (found.some((f) => tokenMatches(c, f))) hit++;
  return hit / cited.length;
}

/**
 * True only when `found` is a confident match for the cited work. Used to gate the PubMed
 * author/year search and CrossRef bibliographic query away from marking a fabricated citation
 * VERIFIED just because a loosely-related real paper was returned.
 */
export function isStrongCitationMatch(cited: CitedRef, found: FoundRef): boolean {
  // Year must be within +/-1 when the citation states one.
  if (cited.year != null) {
    if (found.year == null) return false;
    if (Math.abs(cited.year - found.year) > 1) return false;
  }
  // First-author surname must appear among the found authors (diacritic-folded, word-boundary).
  if (cited.author) {
    const surname = fold(cited.author).toLowerCase().split(/[\s,]+/).filter(Boolean)[0] ?? "";
    if (surname.length >= 2) {
      const ok = (found.authors ?? []).some((a) => {
        const toks = fold(a).toLowerCase().split(/[\s,.]+/).filter(Boolean);
        // Whole-token match (so a short surname can't hide inside an unrelated name), with a
        // substring fallback only for longer, less ambiguous surnames.
        return toks.some((t) => t === surname) || (surname.length >= 5 && toks.some((t) => t.includes(surname)));
      });
      if (!ok) return false;
    }
  }
  // Volume + first page is the strongest deterministic disambiguator for title-less citations:
  // the same author, year, volume, and first page identify a single paper.
  const volPageStrong = !!cited.volume && !!found.volume &&
    String(cited.volume) === String(found.volume) && samePage(cited.firstPage, found.firstPage);
  const citedJournal = tokens(cited.journal);
  const journalStrong = citedJournal.length > 0 && overlapRatio(citedJournal, tokens(found.journal)) >= 0.75;
  const citedTitle = tokens(cited.title);
  const titleStrong = citedTitle.length >= 3 && overlapRatio(citedTitle, tokens(found.title)) >= 0.8;
  // Specificity gate: if the citation is precise enough to name BOTH a volume and a first page, a
  // journal-NAME match alone is not enough — confirm the exact volume+page (or the title). This
  // stops a fabricated citation that borrows a real journal + real author surname from verifying
  // against a DIFFERENT real paper in that journal. (Real citations verify via their real vol+page.)
  if (cited.volume && cited.firstPage) {
    return volPageStrong || titleStrong;
  }
  // Otherwise require a strong journal OR title concordance — author + year alone must not verify.
  return volPageStrong || journalStrong || titleStrong;
}
