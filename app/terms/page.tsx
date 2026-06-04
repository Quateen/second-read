export const metadata = { title: "Terms of Use — Second Read" };

const UPDATED = "June 4, 2026";

export default function Terms() {
  return (
    <main className="max-w-[920px] mx-auto px-6 py-12">
      <h1 className="serif text-[36px] font-semibold tracking-tight m-0 mb-2">Terms of Use</h1>
      <p className="text-muted text-[13px] mb-6">Last updated: {UPDATED}</p>

      <div className="border border-[#d8b400] bg-[#fffbe6] rounded p-4 text-[14px] text-ink mb-6">
        <strong>Not a medical device. Not medical advice.</strong> Second Read is an educational and metacognitive
        tool. It does not diagnose, treat, or make clinical recommendations, and it is not a substitute for
        professional clinical judgment or primary-source review.
      </div>

      <Section title="1. What Second Read is">
        Second Read, operated by Nucleus Digitalis, audits AI-generated clinical text for citation verifiability,
        evidence relevance, missing data, drug-name validity, and model agreement. It is intended to help clinicians
        critically evaluate output from AI systems. It never approves content; the highest verdict it produces is
        "no critical issues detected on these specific checks."
      </Section>

      <Section title="2. No clinical reliance">
        You must not rely on Second Read for any clinical decision. Every audit is provided for educational purposes
        and must be independently verified against primary sources and your own professional judgment. Nucleus
        Digitalis is not liable for clinical decisions made using the tool.
      </Section>

      <Section title="3. No PHI">
        You agree not to submit protected health information or any data that could identify a patient. You are
        solely responsible for de-identifying content before submission. See our{" "}
        <a href="/privacy">Privacy Policy</a>.
      </Section>

      <Section title="4. Acceptable use">
        <ul className="list-disc pl-5 space-y-1">
          <li>Do not use the tool to generate or launder medical advice for patients.</li>
          <li>Do not attempt to overload, reverse-engineer, or abuse the service or its rate limits.</li>
          <li>Do not submit content you are not authorized to share.</li>
        </ul>
      </Section>

      <Section title="5. Accuracy and availability">
        The audit relies on language models and third-party databases (PubMed/NCBI, CrossRef, RxNorm) that may be
        incomplete, delayed, or unavailable. Results are best-effort and may contain errors. The service is provided
        "as is," without warranties of any kind, and may change or be discontinued at any time.
      </Section>

      <Section title="6. Limitation of liability">
        To the maximum extent permitted by law, Nucleus Digitalis and its operators shall not be liable for any
        indirect, incidental, or consequential damages arising from use of Second Read, including any clinical
        outcome.
      </Section>

      <Section title="7. Contact">
        Questions about these terms: <a href="mailto:ahmed@nucleusdigitalis.com">ahmed@nucleusdigitalis.com</a>.
      </Section>

      <p className="text-muted text-[13px] mt-8">
        These terms govern an early-access educational tool and may be updated. They are not legal advice; consult
        your own counsel for your circumstances.
      </p>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="serif text-[22px] font-semibold tracking-tight m-0 mb-2">{title}</h2>
      <div className="text-ink-soft text-[15px] leading-relaxed">{children}</div>
    </section>
  );
}
