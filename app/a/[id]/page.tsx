import { loadAudit, persistenceEnabled } from "@/lib/store";
import Link from "next/link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BADGE: Record<string, string> = {
  "no-issues": "background:#e6f0ef;color:#0b6e63",
  // AUDIT INCOMPLETE renders neutral (never green, never red) — matches the main app.
  incomplete: "background:#eaf1f8;color:#0284c7",
  minor: "background:#f3f0e6;color:#5a4a00",
  significant: "background:#fbeede;color:#9a5b00",
  critical: "background:#fbe6e6;color:#b3261e",
};

export default async function SharedAudit({ params }: { params: { id: string } }) {
  if (!persistenceEnabled) {
    return (
      <Shell>
        <h1 className="serif text-[28px] font-semibold tracking-tight">Sharing is not enabled</h1>
        <p className="text-ink-soft text-[15px] mt-2">
          This deployment does not have audit persistence configured, so shared links are unavailable.
        </p>
        <BackLink />
      </Shell>
    );
  }
  const audit = await loadAudit(params.id);
  if (!audit) {
    return (
      <Shell>
        <h1 className="serif text-[28px] font-semibold tracking-tight">Audit not found</h1>
        <p className="text-ink-soft text-[15px] mt-2">
          This audit link has expired or does not exist. Shared audits are kept for a limited time.
        </p>
        <BackLink />
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <span
          className="inline-block px-2.5 py-1 rounded text-[12px] font-semibold uppercase tracking-[.05em]"
          style={parseStyle(BADGE[audit.verdictTier] || BADGE.minor)}
        >
          {audit.verdictBadge}
        </span>
        <span className="text-muted text-[13px]">Audit-of-audit confidence: {audit.metaLabel} · {audit.metaConfidence}%</span>
      </div>

      <h1 className="serif text-[26px] font-semibold tracking-tight mt-3 mb-1">{audit.verdictTitle}</h1>
      <p className="text-ink-soft text-[15px]">{audit.reason}</p>

      <ul className="mt-3 text-[13.5px] text-ink-soft list-disc pl-5 space-y-0.5">
        {(audit.metaDrivers || []).map((d: string, i: number) => <li key={i}>{d}</li>)}
      </ul>

      <div className="mt-6 space-y-3">
        {(audit.domains || []).map((dm: any) => (
          <div key={dm.id} className="border border-line rounded p-4 bg-white">
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold text-[15px]">{dm.label}</span>
              <span className="text-[12px] text-muted uppercase tracking-[.05em]">{dm.pillText}</span>
            </div>
            <p className="text-ink-soft text-[14px] mt-1">{dm.summary}</p>
          </div>
        ))}
      </div>

      {audit.rewrite && (
        <div className="mt-6">
          <h2 className="serif text-[20px] font-semibold tracking-tight mb-2">Safe rewrite</h2>
          <pre className="mono text-[12.5px] whitespace-pre-wrap bg-[#fdfdfb] border border-line rounded p-4 text-ink">{audit.rewrite}</pre>
        </div>
      )}

      <div className="mt-6 border-t border-line pt-4 text-[13px] text-muted">
        This is a shared, read-only Second Read audit. It is an educational tool and does not replace clinical
        judgment. <Link href="/" className="underline">Run your own audit →</Link>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="max-w-[820px] mx-auto px-6 py-10">{children}</main>;
}
function BackLink() {
  return (
    <p className="mt-5">
      <Link href="/" className="underline text-[14px]">← Back to Second Read</Link>
    </p>
  );
}
function parseStyle(s: string): React.CSSProperties {
  const o: any = {};
  s.split(";").forEach((kv) => {
    const [k, v] = kv.split(":");
    if (k && v) o[k.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v.trim();
  });
  return o;
}
