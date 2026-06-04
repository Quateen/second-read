export const metadata = { title: "Privacy Policy — Second Read" };

const UPDATED = "June 4, 2026";

export default function Privacy() {
  return (
    <main className="max-w-[920px] mx-auto px-6 py-12">
      <h1 className="serif text-[36px] font-semibold tracking-tight m-0 mb-2">Privacy Policy</h1>
      <p className="text-muted text-[13px] mb-6">Last updated: {UPDATED}</p>

      <Section title="Summary">
        Second Read is an educational tool operated by Nucleus Digitalis. We designed it to collect as little
        data as possible. We do not want, and ask you not to submit, any protected health information (PHI) or
        personally identifiable patient data. Text you submit for audit is sent to third-party language model
        providers and public biomedical databases solely to produce your audit, and is not used to train models.
      </Section>

      <Section title="Do not submit PHI">
        Second Read is intended for auditing AI-generated clinical text in the abstract — not real patient records.
        Do not paste names, medical record numbers, dates of birth, contact details, or any other information that
        could identify a patient. You are responsible for de-identifying content before submitting it.
      </Section>

      <Section title="What we process">
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Audit input.</strong> The text you submit is transmitted to language model providers (e.g. Anthropic, and, where enabled, OpenAI and Google) and to public databases (PubMed/NCBI, CrossRef, RxNorm) to generate the audit. It is processed transiently to return your result.</li>
          <li><strong>Lead form (optional).</strong> If you join the early-access list, we store the email address and optional specialty you provide, to contact you about Second Read and Nucleus Digitalis.</li>
          <li><strong>Operational logs.</strong> Standard server logs (timestamps, coarse request metadata, IP for rate limiting) may be retained briefly for security and abuse prevention.</li>
        </ul>
      </Section>

      <Section title="Third-party processors">
        Audit text is shared with the model and database providers listed above strictly to perform the audit.
        Their handling of data is governed by their own terms. We do not sell your data, and we do not use submitted
        audit text to train any model.
      </Section>

      <Section title="Data retention">
        Audit input is processed to generate your result and is not persisted to a long-term store by default. Email
        addresses submitted to the early-access list are retained until you ask us to remove them.
      </Section>

      <Section title="Your choices">
        You can request deletion of any email address you submitted by contacting us. Because we avoid storing audit
        inputs, there is generally no audit content for us to delete after the result is returned.
      </Section>

      <Section title="Contact">
        Questions about this policy: <a href="mailto:ahmed@nucleusdigitalis.com">ahmed@nucleusdigitalis.com</a>.
      </Section>

      <p className="text-muted text-[13px] mt-8">
        This policy describes current practices for an early-access educational tool and may be updated as the
        product evolves. It is not legal advice.
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
