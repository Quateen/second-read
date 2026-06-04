import AuditShell from "@/components/AuditShell";
import LeadForm from "@/components/LeadForm";

export default function HomePage() {
  return (
    <main className="max-w-[920px] mx-auto px-6">
      <section className="py-16">
        <h1 className="serif text-[44px] leading-[1.1] font-semibold tracking-tight m-0 mb-4">
          A safety audit for AI-generated clinical content.
        </h1>
        <p className="text-[18px] text-ink-soft max-w-[640px] mb-7">
          Built for physicians who use AI in practice and want to verify what it tells them — citations, missing
          data, model agreement, all in under a minute.
        </p>
        <div className="flex items-center gap-4 flex-wrap">
          <a href="#audit" className="inline-block px-5 py-3 text-[15px] font-medium bg-ink text-white border border-ink rounded-[2px] no-underline border-b-0">Run an audit</a>
          <span className="text-muted text-[13px]">No signup required. Free tier available.</span>
        </div>
        <div className="mt-9 text-muted text-[13px] border-t border-line pt-4">
          Built by a practicing neurosurgeon. Not a medical device. Educational use only.
        </div>
      </section>

      <section className="py-12 border-t border-line" id="problem">
        <h2 className="serif text-[28px] font-semibold m-0 mb-4 tracking-tight">The "confidently wrong" problem.</h2>
        <p className="text-ink-soft text-[16px]">
          Large language models hallucinate at clinically meaningful rates. In one study of 300 physician-designed
          vignettes, leading models accepted and amplified fabricated clinical details between 50% and 82% of the
          time. In another, models invented dosing instructions for fictional medications in 90% of cases when a
          Pokémon character name was inserted into a medication list.
        </p>
        <p className="text-ink-soft text-[16px]">
          A clinician saying "I don't know" is a hallmark of expertise. A chatbot that never says "I don't know" — that
          confabulates citations, invents dosages, and answers every question with the same fluent confidence — is a
          clinical hazard. Second Read addresses the gap. It is not a substitute for clinical judgment. It is a
          structured prompt to use yours.
        </p>
        <div id="audit"><AuditShell /></div>
      </section>

      <section className="py-12 border-t border-line" id="how">
        <h2 className="serif text-[28px] font-semibold m-0 mb-4 tracking-tight">What an audit checks.</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-2">
          <div className="border-l-2 border-ink pl-3.5 py-1.5">
            <span className="serif text-[30px] font-semibold block">Citations</span>
            <span className="text-muted text-[13px]">
              Verified against PubMed and CrossRef directly via deterministic API calls. Fabricated citations are
              flagged as not found. Real citations are checked against the claim they support.
            </span>
          </div>
          <div className="border-l-2 border-ink pl-3.5 py-1.5">
            <span className="serif text-[30px] font-semibold block">Missing data</span>
            <span className="text-muted text-[13px]">
              Specific patient information that should have been considered. Severity ranked from contextual to
              critical — not generic checklists.
            </span>
          </div>
          <div className="border-l-2 border-ink pl-3.5 py-1.5">
            <span className="serif text-[30px] font-semibold block">Model agreement</span>
            <span className="text-muted text-[13px]">
              Two independent Claude passes at different temperatures are compared for self-consistency, producing an
              explicit agreement score. A true Claude+GPT+Gemini ensemble is the next step on the roadmap.
            </span>
          </div>
        </div>
      </section>

      <section className="py-12 border-t border-line">
        <h2 className="serif text-[28px] font-semibold m-0 mb-4 tracking-tight">What Second Read won't do.</h2>
        <p className="text-ink-soft text-[16px]">
          Second Read is built around a specific commitment: it will not give clinicians false reassurance. The
          highest verdict the tool produces is "no critical issues detected on these specific checks" — never "safe
          to use."
        </p>
        <p className="text-ink-soft text-[16px]"><strong>It will not approve content.</strong> No clean bills of health. Every audit returns with the caveat that clinical judgment is required.</p>
        <p className="text-ink-soft text-[16px]"><strong>It will not hide its own uncertainty.</strong> Every audit includes an audit-of-audit confidence score driven by what can actually be verified — citations, evidence relevance, missing data, and model agreement. When that confidence is low, the audit says so prominently rather than burying it.</p>
        <p className="text-ink-soft text-[16px]"><strong>It will not replace primary source review.</strong> For high-stakes decisions, the audit suggests specific consults and reviews. It does not substitute for them.</p>
      </section>

      <section className="py-12 border-t border-line" id="faq">
        <h2 className="serif text-[28px] font-semibold m-0 mb-4 tracking-tight">Common questions.</h2>
        {[
          ["Is Second Read a medical device?", "No. Second Read is an educational and metacognitive tool designed to help physicians evaluate AI-generated content. It is not regulated as a medical device, makes no diagnostic or treatment recommendations of its own, and must not be used as a substitute for clinical judgment."],
          ["What language models does it use?", "Claude (Haiku 4.5) is the primary auditor. When OpenAI and Google keys are configured, the audit runs a real multi-model ensemble — Claude, GPT, and Gemini each extract claims independently and the app measures genuine cross-model agreement. With only the Anthropic key, it falls back to two temperature-varied Claude passes for self-consistency. Citations are always verified deterministically against PubMed and CrossRef — not through language models."],
          ["How accurate is the audit?", "Citation verification accuracy is high because it relies on deterministic API calls to PubMed and CrossRef. Clinical claim assessment is moderately accurate. The tool was originally calibrated for neurosurgery and spine surgery, but because verification uses the same PubMed, CrossRef, and RxNorm methods for every specialty, confidence is now driven by what can be verified rather than by the specialty itself."],
          ["Can I use this for content from any AI tool?", "Yes. The audit works on AI-generated text regardless of source — ChatGPT, Claude, Perplexity, Gemini, specialty medical AI tools, or any other generator."],
        ].map(([q, a]) => (
          <details key={q} className="border-t border-line py-3.5">
            <summary className="cursor-pointer font-medium text-[15px] list-none">{q}</summary>
            <p className="mt-2.5 text-ink-soft text-[14.5px]">{a}</p>
          </details>
        ))}
        <LeadForm source="faq" cta="Notify me when paid tiers open" />
      </section>
    </main>
  );
}
