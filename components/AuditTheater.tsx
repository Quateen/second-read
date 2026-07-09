"use client";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

// The "orchestration theater" — replays the REAL pipeline events (voters, verification databases,
// findings) so the multi-agent, multi-database rigor is visible. Honesty guards (the product's
// whole thesis): a flagged finding NEVER animates to green; red->green only when a check returned
// ok; the mode label is truthful; prefers-reduced-motion disables the pulse; every state has text.

export type TheaterEvent = { ts: number; kind: string; actor: string; status: string; detail: string; findingId?: string };
export type TheaterVote = { provider: string; tier: string | null; ok: boolean };

const VOTER_META: Record<string, string> = { claude: "Claude", "claude-hot": "Claude (temp 0.7)", gpt: "GPT", gemini: "Gemini" };
const VERIFIERS = [
  { id: "pubmed", label: "PubMed" },
  { id: "crossref", label: "CrossRef" },
  { id: "rxnorm", label: "RxNorm" },
];
const TIER_TEXT: Record<string, string> = {
  critical_issues: "critical", significant_concerns: "significant", minor_concerns: "minor", no_issues_detected: "no issues",
};

// Finding state -> {dot color, text, label}. Green is used ONLY for a cleared individual check.
const FIND_STYLE: Record<string, { css: string; label: string }> = {
  queued: { css: "background:#ececec;color:#555", label: "queued" },
  checking: { css: "background:#fbf3d6;color:#7a5d00", label: "checking" },
  cleared: { css: "background:#e6f0ef;color:#0b6e63", label: "cleared" },
  flagged: { css: "background:#f5e1e1;color:#7a1f1f", label: "flagged" },
  noted: { css: "background:#fbf3d6;color:#7a5d00", label: "noted" },
};

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!m) return;
    setReduced(m.matches);
    const h = () => setReduced(m.matches);
    m.addEventListener?.("change", h);
    return () => m.removeEventListener?.("change", h);
  }, []);
  return reduced;
}

function style(css: string): CSSProperties {
  const o: any = {};
  css.split(";").forEach((kv) => { const [k, v] = kv.split(":"); if (k && v) o[k.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v.trim(); });
  return o;
}

export default function AuditTheater({ events, tierVotes, agreementMode, humanReviewFlag }: {
  events: TheaterEvent[]; tierVotes: TheaterVote[]; agreementMode: string; humanReviewFlag: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  const [n, setN] = useState(events.length);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduced || !events.length) { setN(events.length); return; }
    setN(0);
    let i = 0;
    const stepMs = Math.max(18, Math.min(70, Math.floor(1800 / events.length)));
    const id = setInterval(() => { i += 1; setN(i); if (i >= events.length) clearInterval(id); }, stepMs);
    return () => clearInterval(id);
  }, [events, reduced]);

  const shown = useMemo(() => events.slice(0, n), [events, n]);
  useEffect(() => { if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight; }, [n]);
  const done = n >= events.length;

  const modeLabel = agreementMode === "ensemble:3" ? "3-model ensemble (Claude · GPT · Gemini)"
    : agreementMode === "ensemble:2" ? "2-model ensemble" : "Claude self-consistency (2 passes)";

  // Voter lane shows the REAL tier voters (from tierVotes) — including any that FAILED (shown as
  // "no vote"). We never fabricate a chip for a pass that didn't run; the self-consistency detail is
  // conveyed by the mode label, not a fake voter row.
  const voters = tierVotes;
  const activeActors = new Set(shown.filter((e) => e.status === "start").map((e) => e.actor));
  const settledVoters = new Set(shown.filter((e) => e.kind === "voter" && (e.status.startsWith("vote:") || e.status === "fail" || e.status === "flag")).map((e) => e.actor));

  // Verifier lane — counts derived from real verifier events.
  const verifierCounts = useMemo(() => {
    const s: Record<string, { ok: number; fail: number }> = {};
    for (const e of shown) if (e.kind === "verifier" && e.actor !== "orchestrator") { s[e.actor] = s[e.actor] ?? { ok: 0, fail: 0 }; if (e.status === "ok") s[e.actor].ok++; else if (e.status === "fail") s[e.actor].fail++; }
    return s;
  }, [shown]);

  // Findings meters — honesty guard: once flagged, stays flagged.
  const findings = useMemo(() => {
    const map = new Map<string, { label: string; state: string }>();
    for (const e of shown) {
      if (e.kind !== "finding" || !e.findingId) continue;
      const cur = map.get(e.findingId);
      if (cur?.state === "flagged") continue;
      const state = ["checking", "cleared", "noted"].includes(e.status) ? e.status : e.status === "flag" ? "flagged" : cur?.state ?? "queued";
      map.set(e.findingId, { label: (e.detail || e.findingId).slice(0, 46), state });
    }
    return [...map.values()];
  }, [shown]);

  const pct = events.length ? Math.round((n / events.length) * 100) : 100;

  return (
    <div className="border border-line rounded bg-white p-4 mt-4" aria-label="Audit orchestration">
      {/* Orchestrator bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-2">
          <span className={"inline-block w-2.5 h-2.5 rounded-full " + (done ? "bg-info" : "bg-info " + (reduced ? "" : "animate-pulse"))} aria-hidden />
          <span className="text-[13px] font-semibold text-ink uppercase tracking-[.06em]">Orchestrator</span>
          <span className="text-[12px] text-muted">· {modeLabel}</span>
        </div>
        {humanReviewFlag && (
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-[2px] uppercase tracking-[.05em]" style={style(FIND_STYLE.noted.css)}>Human review recommended</span>
        )}
      </div>
      <div className="h-[4px] bg-[#e0ddd4] overflow-hidden rounded mb-4"><div className="h-full bg-ink transition-all duration-300" style={{ width: pct + "%" }} /></div>

      {/* Voter + verifier lanes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <div>
          <div className="text-[11px] text-muted uppercase tracking-[.06em] mb-1.5">Voters (LLMs)</div>
          <div className="flex flex-wrap gap-2">
            {voters.map((v, i) => {
              const active = activeActors.has(v.provider) && !settledVoters.has(v.provider) && !reduced && !done;
              const tier = (v as any).tier as string | null;
              return (
                <div key={v.provider + i} className="border border-line rounded px-2.5 py-1.5 min-w-[120px]">
                  <div className="flex items-center gap-1.5">
                    <span className={"inline-block w-2 h-2 rounded-full " + (active ? "bg-info animate-pulse" : settledVoters.has(v.provider) || done ? "bg-ink" : "bg-[#cfcabd]")} aria-hidden />
                    <span className="text-[12.5px] font-medium text-ink">{VOTER_META[v.provider] ?? v.provider}</span>
                  </div>
                  <div className="text-[11px] text-muted mt-0.5">{tier ? "vote: " + (TIER_TEXT[tier] ?? tier) : v.ok ? (done ? "returned" : "…") : "no vote"}</div>
                </div>
              );
            })}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-muted uppercase tracking-[.06em] mb-1.5">Verifiers (databases)</div>
          <div className="flex flex-wrap gap-2">
            {VERIFIERS.map((vf) => {
              const c = verifierCounts[vf.id];
              // Green ONLY when there were matches and NO failures; mixed = amber; all-fail = red.
              const cls = !c ? FIND_STYLE.queued.css
                : c.ok > 0 && c.fail === 0 ? FIND_STYLE.cleared.css
                : c.ok > 0 ? FIND_STYLE.noted.css
                : c.fail > 0 ? FIND_STYLE.flagged.css : FIND_STYLE.noted.css;
              const txt = !c ? "idle" : `${c.ok}✓ / ${c.fail}✗`;
              return (
                <span key={vf.id} className="text-[12px] px-2.5 py-1 rounded-[2px] font-medium" style={style(cls)}>
                  {vf.label} · {txt}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      {/* Findings meters */}
      {findings.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] text-muted uppercase tracking-[.06em] mb-1.5">Findings</div>
          <div className="flex flex-wrap gap-1.5">
            {findings.map((f, i) => {
              const s = FIND_STYLE[f.state] ?? FIND_STYLE.queued;
              const pulse = f.state === "checking" && !reduced && !done;
              return (
                <span key={i} className={"text-[11.5px] px-2 py-0.5 rounded-[2px] font-medium " + (pulse ? "animate-pulse" : "")} style={style(s.css)} title={f.label}>
                  {f.label} · {s.label}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Activity feed */}
      <div>
        <div className="text-[11px] text-muted uppercase tracking-[.06em] mb-1.5">Activity</div>
        <div ref={feedRef} className="mono text-[11.5px] leading-[1.6] bg-[#fbfbf9] border border-line rounded p-2 h-[180px] overflow-auto" aria-live="polite" role="log">
          {shown.map((e, i) => (
            <div key={i} className="whitespace-pre-wrap">
              <span className="text-muted">{(e.ts / 1000).toFixed(1)}s</span>{" "}
              <span className="text-ink-soft">{e.actor}</span>{" "}
              <span className={e.status === "fail" || e.status === "flag" ? "text-crit" : e.status === "ok" || e.status.startsWith("vote") || e.status === "cleared" ? "text-info" : "text-muted"}>{e.status}</span>
              {e.detail ? <span className="text-muted"> — {e.detail}</span> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
