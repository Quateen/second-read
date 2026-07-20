import { verifyByCitation } from "./lib/pubmed";
import * as fs from "fs";
const data = JSON.parse(fs.readFileSync(process.env.CAND || "", "utf8"));
function parse(cit: string) {
  const year = Number((cit.match(/\b(19|20)\d{2}\b/) || [])[0]) || 0;
  // author: first surname token (skip group-author cases -> use "" so search falls back to title/journal)
  const authMatch = cit.match(/^([A-Z][a-z]+)\b/);
  const author = authMatch ? authMatch[1] : "";
  const journal = (cit.match(/(New England Journal of Medicine|Lancet|Critical Care Medicine|Journal of Neurosurgery[^.]*|PLoS One|Neuro-Oncology[^.]*|Stroke|JAMA[^.]*)/) || [])[0] || "";
  const vp = cit.match(/;\s*(\d+)\s*(?:\((\d+)\))?\s*:\s*(\d+)/);
  const volume = vp ? vp[1] : undefined;
  const firstPage = vp ? vp[3] : undefined;
  // title fragment from the input_text is unavailable here; verify by author/year/journal/vol/page
  return { author, year, journal, volume, firstPage } as any;
}
(async () => {
  for (const c of data.candidates) {
    const cits: string[] = c.ground_truth.real_citations || [];
    if (!cits.length) { console.log(`${c.id.padEnd(9)} (uncited)`); continue; }
    for (const raw of cits) {
      const q = parse(raw);
      try {
        const r = await verifyByCitation({ author: q.author, year: q.year, title: undefined, journal: q.journal, volume: q.volume, firstPage: q.firstPage });
        const ok = r.status === "found";
        console.log(`${c.id.padEnd(9)} ${ok ? "VERIFIED" : "NOT_FOUND(" + r.status + ")"}  au=${q.author} ${q.year} vol=${q.volume} p=${q.firstPage}  ${ok ? "| " + String((r as any).title || "").slice(0,60) : "| " + raw.slice(0,55)}`);
      } catch (e: any) { console.log(`${c.id.padEnd(9)} ERROR ${e.message}`); }
      await new Promise(r => setTimeout(r, 400)); // be polite to NCBI
    }
  }
})();
