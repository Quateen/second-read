"use client";
import { useState } from "react";

export default function LeadForm({ source = "landing", cta = "Join the waitlist" }: { source?: string; cta?: string }) {
  const [email, setEmail] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "err">("idle");
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setMsg(null);
    try {
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, specialty, source, website }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || "HTTP " + res.status);
      }
      setStatus("ok");
      setMsg("Thanks. I'll send a single invitation when access opens.");
      setEmail("");
      setSpecialty("");
    } catch (e: any) {
      setStatus("err");
      setMsg(e?.message || "Submit failed");
    }
  }

  return (
    <form onSubmit={submit} className="bg-white border border-line p-5 rounded mt-6 max-w-[520px] relative">
      <h3 className="serif text-[18px] font-semibold m-0">Early access</h3>
      <p className="text-muted text-[13px] mt-1.5 mb-3">
        Get notified when paid tiers open. One email, no marketing.
      </p>
      <div className="flex flex-col gap-2">
        <input type="email" required placeholder="Your email" value={email} onChange={(e) => setEmail(e.target.value)} className="text-[14px] px-3 py-2 border border-line bg-white rounded focus:outline-none focus:border-ink" />
        <input type="text" placeholder="Specialty (optional)" value={specialty} onChange={(e) => setSpecialty(e.target.value)} className="text-[14px] px-3 py-2 border border-line bg-white rounded focus:outline-none focus:border-ink" />
        <input type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} className="absolute -left-[9999px] w-px h-px opacity-0" />
        <button type="submit" disabled={status === "loading"} className="px-4 py-2.5 bg-ink text-white text-[14px] font-medium rounded-[2px] disabled:opacity-50">
          {status === "loading" ? "Sending..." : cta}
        </button>
      </div>
      {msg && <div className={"mt-2 text-[13px] " + (status === "ok" ? "text-info" : "text-crit")}>{msg}</div>}
    </form>
  );
}
