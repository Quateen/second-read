// lib/rxnorm.ts — RxNorm drug-name validation (catches the "Pokemon as drug" failure mode)
const UA = "SecondRead/1.0 (https://secondread.health; mailto:ahmed@nucleusdigitalis.com)";
const BASE = "https://rxnav.nlm.nih.gov/REST";

export type RxNormResult =
  | { status: "found"; rxcui: string; name: string; ingredient?: string }
  | { status: "not_found" }
  | { status: "error"; reason: "rate_limit" | "server" | "malformed" | "timeout" | "network"; detail?: string };

async function rxFetch(url: string, timeoutMs = 8000): Promise<any | { error: RxNormResult }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
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

function pickConcept(group: any): { rxcui: string; name: string } | null {
  const props = group?.conceptGroup;
  if (!Array.isArray(props)) return null;
  const priority = ["IN", "PIN", "SCD", "SBD", "GPCK", "BPCK"];
  for (const tty of priority) {
    const g = props.find((p: any) => p?.tty === tty);
    const prop = g?.conceptProperties?.[0];
    if (prop?.rxcui && prop?.name) return { rxcui: String(prop.rxcui), name: prop.name };
  }
  for (const g of props) {
    const prop = g?.conceptProperties?.[0];
    if (prop?.rxcui && prop?.name) return { rxcui: String(prop.rxcui), name: prop.name };
  }
  return null;
}

async function fetchIngredient(rxcui: string): Promise<string | undefined> {
  const r = await rxFetch(`${BASE}/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=IN`);
  if (r?.error) return undefined;
  const groups = r?.relatedGroup?.conceptGroup;
  if (!Array.isArray(groups)) return undefined;
  for (const g of groups) {
    if (g?.tty === "IN" && g?.conceptProperties?.[0]?.name) return g.conceptProperties[0].name;
  }
  return undefined;
}

/** Verify a drug name against RxNorm; returns RxCUI + ingredient when matched. */
export async function verifyDrugName(name: string): Promise<RxNormResult> {
  const cleaned = name.trim();
  if (!cleaned) return { status: "not_found" };
  const r = await rxFetch(`${BASE}/drugs.json?name=${encodeURIComponent(cleaned)}`);
  if (r?.error) return r.error;
  const concept = pickConcept(r?.drugGroup);
  if (!concept) return { status: "not_found" };
  const ingredient = await fetchIngredient(concept.rxcui);
  return { status: "found", rxcui: concept.rxcui, name: concept.name, ingredient };
}
