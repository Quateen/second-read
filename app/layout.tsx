import "./globals.css";
import type { Metadata } from "next";

const SITE = process.env.NEXT_PUBLIC_SITE_URL || "https://secondread.health";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "Second Read — A safety audit for AI-generated clinical content",
  description:
    "Built for physicians who use AI in practice and want to verify what it tells them — citations, missing data, model agreement, all in under a minute. Not a medical device.",
  openGraph: {
    title: "Second Read",
    description: "A safety audit for AI-generated clinical content. Built by a practicing neurosurgeon.",
    url: SITE,
    siteName: "Second Read",
    type: "website",
  },
  twitter: { card: "summary", title: "Second Read", description: "A safety audit for AI-generated clinical content." },
  robots: { index: true, follow: true },
  icons: {
    icon: [{ url: "/favicon.ico" }, { url: "/favicon-32.png", type: "image/png", sizes: "32x32" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="disclaimer-bar bg-black text-[#f3f1ea] text-[13px] py-[9px] border-b border-black">
          <div className="max-w-[920px] mx-auto px-6">
            <span>
              <strong className="text-white">Notice.</strong> Second Read is an educational and metacognitive tool. It
              is not a medical device. All outputs require clinician verification. Do not paste protected health
              information.
            </span>
          </div>
        </div>
        <header className="site border-b border-line bg-bg">
          <div className="max-w-[920px] mx-auto px-6 py-[18px] flex justify-between items-center">
            <a href="/" className="flex items-center gap-3 border-0">
              <img
                src="/nd-logo.png"
                alt="Nucleus Digitalis"
                width={36}
                height={40}
                className="rounded-md shadow-sm"
                style={{ background: "#0e1430" }}
              />
              <span className="serif font-semibold text-[22px] tracking-tight">
                Second Read
                <span className="font-sans text-[12px] text-muted uppercase tracking-[.04em] ml-2 font-normal">
                  by Nucleus Digitalis
                </span>
              </span>
            </a>
            <nav className="text-[14px]">
              <a href="#how" className="ml-[22px] text-ink-soft border-0">How it works</a>
              <a href="/methodology" className="ml-[22px] text-ink-soft border-0">Methodology</a>
              <a href="#faq" className="ml-[22px] text-ink-soft border-0">FAQ</a>
            </nav>
          </div>
        </header>
        {children}
        <footer className="border-t border-line py-8 text-muted text-[13px] mt-12">
          <div className="max-w-[920px] mx-auto px-6 grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <h5 className="text-[12px] uppercase tracking-[.06em] text-[#333] font-semibold mb-2">Second Read</h5>
              A project of Nucleus Digitalis. Built for physicians.
            </div>
            <div>
              <h5 className="text-[12px] uppercase tracking-[.06em] text-[#333] font-semibold mb-2">Links</h5>
              <a href="/methodology" className="block text-ink-soft border-0 mb-1">Methodology</a>
              <a href="#faq" className="block text-ink-soft border-0 mb-1">FAQ</a>
              <a href="/privacy" className="block text-ink-soft border-0 mb-1">Privacy</a>
              <a href="/terms" className="block text-ink-soft border-0 mb-1">Terms</a>
            </div>
            <div>
              <h5 className="text-[12px] uppercase tracking-[.06em] text-[#333] font-semibold mb-2">Disclaimer</h5>
              Second Read is an educational tool. It is not a medical device. It does not provide medical advice.
              Clinical judgment is required for all decisions. © 2026 Nucleus Digitalis.
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
