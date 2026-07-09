"use client";
import { useEffect, useRef, useState } from "react";
import AuditTheater, { TheaterEvent, TheaterVote } from "./AuditTheater";

type Finding = { lbl: string; title: string; src: string; sev: "critical" | "important" | "contextual" };
type Domain = { id: string; label: string; pill: "ok" | "warn" | "crit" | "neut"; pillText: string; summary: string; findings: Finding[] };
export type Audit = {
  verdictTier: "no-issues" | "minor" | "significant" | "critical" | "incomplete";
  verdictTitle: string;
  verdictBadge: string;
  reason: string;
  metaConfidence: number;
  metaLabel: "Low" | "Moderate" | "High";
  metaDrivers: string[];
  agreementMode?: string;
  disagreement?: boolean;
  humanReviewFlag?: boolean;
  tierVotes?: TheaterVote[];
  events?: TheaterEvent[];
  domains: Domain[];
  rewrite: string;
  diagnostics?: { durationMs: number; tokensIn: number; tokensOut: number; costEstimateUsd: number; citationsChecked: number; citationsVerified: number; citationsNotFound: number; drugsChecked: number; drugsVerified: number; llmFailures?: string[] };
  mode?: "live" | "demo";
  shareId?: string | null;
};

const SAMPLE = `Patient: 58-year-old male presenting 6 hours after fall from height with C5-C6 ASIA C cervical spinal cord injury. MRI confirms cord compression with edema. Plan:

1. Early surgical decompression within 24 hours is associated with improved neurological recovery in acute cervical SCI (Fehlings et al., STASCIS, J Neurosurg Spine 2012).
2. Initiate high-dose methylprednisolone 30 mg/kg bolus followed by 5.4 mg/kg/hr infusion for 23 hours per NASCIS-IV guideline (Bracken & Holford, J Neurosurg 2019).
3. Mean arterial pressure goal 85-90 mmHg for 7 days post-injury to optimize spinal cord perfusion (Hawryluk et al., Neurocrit Care 2020).
4. Begin enoxaparin 40 mg subcutaneously daily for VTE prophylaxis starting within 24 hours.
5. Consult physical medicine and rehabilitation for early mobilization protocol.`;

const STEPS = [
  "Extracting clinical claims",
  "Extracting citations",
  "Verifying citations against PubMed",
  "Verifying citations against CrossRef",
  "Checking medication names against RxNorm",
  "Running missing-data check",
  "Comparing model outputs (ensemble)",
  "Scoring evidence relevance",
  "Synthesizing risk tier",
  "Generating safe rewrite",
  "Computing audit-of-audit confidence",
];
// Approximate per-step dwell (ms) reflecting real relative cost; total ~aligns
// with a typical 30-55s audit. The bar advances on this schedule while the
// request is in flight, then snaps to complete when the response returns.
const STEP_MS = [3500, 2500, 4000, 3500, 2500, 3500, 6000, 5000, 5000, 5000, 4000];
// Soft display limit shown to users (the audit focuses on AI output, not full papers). The server
// enforces the hard cap via MAX_AUDIT_INPUT_CHARS.
const MAX_CHARS = 8000;

// Per-audit feedback reason chips (mirrors FEEDBACK_REASONS in app/api/feedback/route.ts).
const FB_REASONS = [
  "Missed a real problem",
  "False alarm — flagged something fine",
  "Citation result wrong",
  "Drug/medication result wrong",
  "Verdict too harsh",
  "Verdict too lenient",
  "Confusing or unclear",
  "Too slow",
  "Other",
];

const PILL_CLS: Record<string, string> = {
  ok: "bg-info-soft text-info",
  warn: "bg-warn-soft text-warn",
  crit: "bg-crit-soft text-crit",
  neut: "bg-[#eee] text-[#444]",
};
const BADGE_CLS: Record<string, string> = {
  "no-issues": "bg-info-soft text-info",
  // AUDIT_INCOMPLETE: same neutral style as "no-issues" — never green, never red.
  // The top clinical-alarm tier must never mean "the audit failed".
  incomplete: "bg-info-soft text-info",
  minor: "bg-[#f3f0e6] text-[#5a4a00]",
  significant: "bg-warn-soft text-warn",
  critical: "bg-crit-soft text-crit",
};

export default function AuditShell() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openDomain, setOpenDomain] = useState<Domain | null>(null);
  // Per-audit feedback (thumbs + optional reasons). Reset whenever a new audit lands.
  const [fbChoice, setFbChoice] = useState<null | "up" | "down">(null);
  const [fbReasons, setFbReasons] = useState<string[]>([]);
  const [fbComment, setFbComment] = useState("");
  const [fbStatus, setFbStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const cycleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!loading) {
      if (cycleRef.current) clearTimeout(cycleRef.current);
      return;
    }
    setStepIdx(0);
    let i = 0;
    const advance = () => {
      // Hold on the last step until the response actually returns.
      if (i >= STEPS.length - 1) return;
      cycleRef.current = setTimeout(() => { i += 1; setStepIdx(i); advance(); }, STEP_MS[i] ?? 4000);
    };
    advance();
    return () => { if (cycleRef.current) clearTimeout(cycleRef.current); };
  }, [loading]);

  useEffect(() => {
    if (audit && resultsRef.current) resultsRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    // A new audit -> fresh feedback state.
    setFbChoice(null);
    setFbReasons([]);
    setFbComment("");
    setFbStatus("idle");
  }, [audit]);

  function toggleReason(r: string) {
    setFbReasons((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));
  }

  async function submitFeedback(rating: "up" | "down") {
    if (!audit) return;
    // A thumbs-down needs at least one reason chip or a comment.
    if (rating === "down" && fbReasons.length === 0 && fbComment.trim().length === 0) return;
    setFbStatus("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audit_id: audit.shareId ?? null,
          rating,
          reasons: rating === "down" ? fbReasons : [],
          comment: rating === "down" ? fbComment.trim() || undefined : undefined,
        }),
      });
      setFbStatus(res.ok ? "done" : "error");
    } catch {
      setFbStatus("error");
    }
  }

  async function runAudit() {
    setErr(null);
    setAudit(null);
    if (input.trim().length < 20) { setErr("Paste at least 20 characters."); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || "HTTP " + res.status);
      }
      const data = (await res.json()) as Audit;
      setAudit(data);
    } catch (e: any) {
      setErr(e?.message || "Audit failed");
    } finally {
      setLoading(false);
    }
  }

  function copyRewrite() {
    if (!audit) return;
    navigator.clipboard.writeText(audit.rewrite);
  }

  const [copiedLink, setCopiedLink] = useState(false);
  function copyShareLink() {
    if (!audit?.shareId) return;
    const url = `${window.location.origin}/a/${audit.shareId}`;
    navigator.clipboard.writeText(url);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  }

  return (
    <div className="bg-white border border-line rounded p-6 mt-6">
      <label htmlFor="input" className="block text-[13px] text-muted uppercase tracking-[.06em] mb-1">
        Paste AI-generated clinical content
      </label>
      <p className="text-[12.5px] text-muted mb-2">
        Paste the AI-generated content you want checked — a recommendation, answer, summary, or its
        conclusions. Not a whole article or PDF (max ~{MAX_CHARS.toLocaleString()} characters).
      </p>
      <textarea
        id="input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="e.g. a ChatGPT / Claude / Gemini answer with a treatment recommendation and its citations — paste the claims or conclusions you want audited."
        className="w-full min-h-[180px] mono text-[13.5px] leading-[1.55] p-3.5 border border-line rounded bg-[#fdfdfb] text-ink resize-y focus:outline-none focus:border-ink"
      />
      <div className="flex justify-end mt-1">
        <span className={"text-[12px] mono " + (input.length > MAX_CHARS ? "text-crit font-medium" : "text-muted")}>
          {input.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
        </span>
      </div>
      {input.length > MAX_CHARS && (
        <p className="text-[12.5px] text-crit mt-1">
          That&apos;s longer than ~{MAX_CHARS.toLocaleString()} characters. Paste the key claims or conclusions you want audited, not the whole document.
        </p>
      )}
      <div className="flex justify-end items-center mt-3.5 gap-2.5 flex-wrap">
        <div className="flex gap-2.5 flex-wrap">
          <button onClick={() => setInput(SAMPLE)} className="px-5 py-3 text-[15px] font-medium bg-transparent text-ink border border-ink rounded-[2px]">Load sample content</button>
          <button onClick={runAudit} disabled={loading} className="px-5 py-3 text-[15px] font-medium bg-ink text-white border border-ink rounded-[2px] disabled:opacity-50">
            {loading ? "Running..." : "Run audit"}
          </button>
        </div>
      </div>

      {loading && (
        <div className="bg-[#f3f1ea] border border-line p-4 mt-4 rounded">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[13px] font-medium text-ink uppercase tracking-[.06em]">Auditing</span>
            <span className="mono text-[12px] text-muted">Step {stepIdx + 1} of {STEPS.length}</span>
          </div>
          <div className="h-[4px] bg-[#e0ddd4] overflow-hidden rounded mb-4">
            <div className="h-full bg-ink transition-all duration-700 ease-out" style={{ width: ((stepIdx + 1) / STEPS.length) * 100 + "%" }} />
          </div>
          <ul className="space-y-1.5">
            {STEPS.map((s, i) => {
              const done = i < stepIdx;
              const active = i === stepIdx;
              return (
                <li key={s} className={"flex items-center gap-2.5 text-[13.5px] " + (active ? "text-ink font-medium" : done ? "text-muted" : "text-[#b8b4a8]")}>
                  <span className={"inline-flex items-center justify-center w-[16px] h-[16px] rounded-full border text-[10px] shrink-0 " + (done ? "bg-ink border-ink text-white" : active ? "border-ink text-ink" : "border-[#d6d2c6] text-transparent")}>
                    {done ? "\u2713" : active ? "" : ""}
                  </span>
                  <span>{s}{active ? "\u2026" : ""}</span>
                  {active && (
                    <span className="inline-block w-[12px] h-[12px] border-2 border-ink border-t-transparent rounded-full animate-spin ml-1" />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {err && !loading && (
        <div className="bg-crit-soft text-crit border border-crit/30 p-4 mt-4 rounded text-[14px]">
          <strong>Audit could not complete.</strong> {err}
        </div>
      )}

      {!audit && !loading && !err && (
        <div className="mt-4 text-muted text-[13.5px]">
          Paste content above to begin. An audit takes about 30-60 seconds.
        </div>
      )}

      {audit && (
        <div ref={resultsRef} className="mt-7">
          <div className="border border-line bg-white p-5 rounded flex justify-between gap-6 flex-wrap">
            <div className="flex-1 min-w-[260px]">
              <p className="serif text-[24px] font-semibold tracking-tight m-0">
                {audit.verdictTitle}
                <span className={"inline-block px-2.5 py-0.5 font-sans text-[11px] tracking-[.08em] uppercase ml-2.5 align-middle rounded-[2px] " + BADGE_CLS[audit.verdictTier]}>{audit.verdictBadge}</span>
              </p>
              <p className="text-ink-soft text-[14.5px] mt-2">{audit.reason}</p>
              <p className="mt-3 text-[13px] text-muted">Highest verdict the tool produces is "no critical issues detected on these specific checks." Clinical judgment is required.</p>
              {audit.diagnostics && (
                <p className="mt-3 text-[12px] text-muted">
                  {(audit.diagnostics.durationMs / 1000).toFixed(1)}s &middot; {audit.diagnostics.tokensIn + audit.diagnostics.tokensOut} tokens &middot; ~${audit.diagnostics.costEstimateUsd.toFixed(4)} &middot; {audit.diagnostics.citationsVerified}/{audit.diagnostics.citationsChecked} citations verified
                </p>
              )}
            </div>
            <div className="min-w-[200px] border-l border-line pl-6">
              <h4 className="m-0 mb-1 text-[12px] text-muted uppercase tracking-[.06em] font-semibold">Audit-of-audit confidence</h4>
              <div className="serif text-[22px] font-semibold my-0.5">{audit.metaLabel} &middot; {audit.metaConfidence}%</div>
              <div className="h-[6px] bg-[#eee] rounded-[3px] overflow-hidden mt-2">
                <div className="h-full bg-ink" style={{ width: audit.metaConfidence + "%" }} />
              </div>
              <ul className="pl-4 mt-2.5 text-[12.5px] text-ink-soft list-disc">
                {audit.metaDrivers.map((d, i) => <li key={i} className="mb-0.5">{d}</li>)}
              </ul>
            </div>
          </div>

          {audit.events && audit.events.length > 0 && (
            <AuditTheater
              events={audit.events}
              tierVotes={audit.tierVotes ?? []}
              agreementMode={audit.agreementMode ?? "self_consistency:claude"}
              humanReviewFlag={!!audit.humanReviewFlag}
              durationMs={audit.diagnostics?.durationMs}
              tokensTotal={audit.diagnostics ? audit.diagnostics.tokensIn + audit.diagnostics.tokensOut : undefined}
              costUsd={audit.diagnostics?.costEstimateUsd}
            />
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 mt-4">
            {audit.domains.map((d) => (
              <button key={d.id} onClick={() => setOpenDomain(d)} className="text-left bg-white border border-line p-4 rounded hover:border-ink">
                <div className="flex justify-between items-center gap-2">
                  <h3 className="text-[14px] font-semibold">{d.label}</h3>
                  <span className={"text-[11px] font-medium px-2 py-0.5 rounded-[2px] tracking-[.04em] uppercase " + PILL_CLS[d.pill]}>{d.pillText}</span>
                </div>
                <div className="mt-2 text-[13.5px] text-ink-soft">{d.summary}</div>
                <div className="mt-2 text-[12px] text-muted">Tap to view detail</div>
              </button>
            ))}
          </div>

          <div className="mt-5 bg-white border border-line p-5 rounded">
            <h3 className="serif text-[18px] font-semibold m-0">Safe rewrite</h3>
            <p className="text-muted text-[12.5px] mt-1.5 mb-2.5">Fabricated citations removed. Overconfident claims downgraded. Caveats added.</p>
            <pre className="whitespace-pre-wrap mono text-[13px] leading-[1.6] text-ink bg-bg border border-line p-3.5 rounded-[2px] m-0">{audit.rewrite}</pre>
            <div className="mt-3 flex gap-2.5 no-print flex-wrap">
              <button onClick={copyRewrite} className="text-[13px] px-3.5 py-2 bg-transparent text-ink border border-ink rounded-[2px]">Copy rewrite</button>
              <button onClick={() => window.print()} className="text-[13px] px-3.5 py-2 bg-transparent text-ink border border-ink rounded-[2px]">Export as PDF</button>
              {audit.shareId && (
                <button onClick={copyShareLink} className="text-[13px] px-3.5 py-2 bg-transparent text-ink border border-ink rounded-[2px]">
                  {copiedLink ? "Link copied \u2713" : "Copy shareable link"}
                </button>
              )}
            </div>
          </div>

          <div className="mt-5 border-t border-line pt-4 no-print">
            {fbStatus === "done" ? (
              <div className="flex items-center gap-3 text-[13.5px] text-muted flex-wrap">
                <span>Thanks \u2014 your feedback was recorded.</span>
                <button
                  onClick={() => { setFbStatus("idle"); setFbChoice(null); setFbReasons([]); setFbComment(""); }}
                  className="text-info underline underline-offset-2"
                >Change</button>
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-[13.5px] text-ink-soft">Was this audit helpful?</span>
                  <div className="flex gap-2">
                    <button
                      aria-label="Yes, this audit was helpful"
                      aria-pressed={fbChoice === "up"}
                      onClick={() => { setFbChoice("up"); submitFeedback("up"); }}
                      disabled={fbStatus === "sending"}
                      className={"px-3 py-1.5 border rounded-[2px] text-[13px] disabled:opacity-50 " + (fbChoice === "up" ? "border-info text-info bg-info-soft" : "border-line text-ink hover:border-ink")}
                    ><span aria-hidden="true">{"\ud83d\udc4d"}</span> Yes</button>
                    <button
                      aria-label="No, this audit had a problem"
                      aria-pressed={fbChoice === "down"}
                      onClick={() => setFbChoice("down")}
                      disabled={fbStatus === "sending"}
                      className={"px-3 py-1.5 border rounded-[2px] text-[13px] disabled:opacity-50 " + (fbChoice === "down" ? "border-warn text-warn bg-warn-soft" : "border-line text-ink hover:border-ink")}
                    ><span aria-hidden="true">{"\ud83d\udc4e"}</span> No</button>
                  </div>
                </div>

                {fbChoice === "up" && fbStatus === "error" && (
                  <p className="text-[12.5px] text-crit mt-2">Couldn&apos;t send \u2014 <button onClick={() => submitFeedback("up")} className="underline">retry</button>.</p>
                )}

                {fbChoice === "down" && (
                  <div className="mt-3">
                    <p className="text-[12.5px] text-muted mb-2">What went wrong? Pick at least one, or add a note.</p>
                    <div className="flex flex-wrap gap-2">
                      {FB_REASONS.map((r) => {
                        const on = fbReasons.includes(r);
                        return (
                          <button
                            key={r}
                            type="button"
                            aria-pressed={on}
                            onClick={() => toggleReason(r)}
                            className={"px-2.5 py-1 rounded-full border text-[12.5px] " + (on ? "border-ink bg-ink text-white" : "border-line text-ink-soft hover:border-ink")}
                          >{r}</button>
                        );
                      })}
                    </div>
                    <label htmlFor="fb-comment" className="sr-only">Optional feedback detail</label>
                    <textarea
                      id="fb-comment"
                      value={fbComment}
                      onChange={(e) => setFbComment(e.target.value)}
                      placeholder="Optional detail \u2014 do not include patient-identifying information."
                      maxLength={1000}
                      className="w-full mt-3 min-h-[64px] text-[13px] p-2.5 border border-line rounded bg-[#fdfdfb] text-ink resize-y focus:outline-none focus:border-ink"
                    />
                    <p className="text-[12px] text-muted mt-1">Don&apos;t include patient-identifying information.</p>
                    <div className="mt-2 flex items-center gap-3 flex-wrap">
                      <button
                        onClick={() => submitFeedback("down")}
                        disabled={fbStatus === "sending" || (fbReasons.length === 0 && fbComment.trim().length === 0)}
                        className="px-4 py-2 text-[13px] font-medium bg-ink text-white border border-ink rounded-[2px] disabled:opacity-50"
                      >{fbStatus === "sending" ? "Sending\u2026" : "Submit feedback"}</button>
                      {fbStatus === "error" && <span className="text-[12.5px] text-crit">Couldn&apos;t send \u2014 try again.</span>}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {openDomain && (
        <div className="fixed inset-0 bg-black/45 z-50 flex items-center justify-center p-4" onClick={() => setOpenDomain(null)}>
          <div className="bg-white max-w-[680px] w-full rounded shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-line flex justify-between items-center">
              <h3 className="m-0 serif text-[20px] font-semibold">{openDomain.label}</h3>
              <button onClick={() => setOpenDomain(null)} className="text-2xl text-[#555] bg-transparent border-0 cursor-pointer">x</button>
            </div>
            <div className="px-5 py-4 max-h-[60vh] overflow-auto">
              <p className="text-ink-soft text-[14.5px] mt-0">{openDomain.summary}</p>
              {openDomain.findings.length > 0 ? (
                openDomain.findings.map((f, i) => (
                  <div key={i} className="py-3 border-b border-dashed border-line last:border-0">
                    <div className="text-[11px] uppercase tracking-[.06em] text-muted">
                      {f.lbl}
                      <span className={"text-[11px] px-1.5 py-0.5 rounded-[2px] uppercase tracking-[.05em] ml-1.5 " + PILL_CLS[f.sev === "critical" ? "crit" : f.sev === "important" ? "warn" : "neut"]}>{f.sev}</span>
                    </div>
                    <strong className="block my-1 text-[14.5px]">{f.title}</strong>
                    <div className="mono text-[12px] text-muted mt-1">{f.src}</div>
                  </div>
                ))
              ) : (
                <p className="text-muted text-[13.5px]">No itemized findings for this domain.</p>
              )}
            </div>
            <div className="px-5 py-3.5 border-t border-line flex justify-end">
              <button onClick={() => setOpenDomain(null)} className="px-3.5 py-2 text-[13px] bg-transparent text-ink border border-ink rounded-[2px]">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
