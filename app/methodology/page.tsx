export const metadata = { title: "Methodology — Second Read" };

export default function Methodology() {
  return (
    <main className="max-w-[920px] mx-auto px-6 py-12">
      <h1 className="serif text-[36px] font-semibold tracking-tight m-0 mb-4">How Second Read audits AI-generated clinical content.</h1>
      <p className="text-ink-soft text-[16px]">
        The audit pipeline runs through ten coordinated steps. Each step produces structured output. Each output
        includes an explicit confidence score and a list of factors driving that confidence. The framework is
        informed by recent academic work on epistemic humility in clinical AI (Sikora, Celi & Abdulnour, NEJM 2026),
        semantic entropy for LLM uncertainty (Kuhn et al., Nature 2024), and conformal abstention for medical
        question answering.
      </p>
      {[
        ["Step 1: Claim extraction.", "A language model decomposes the input into atomic clinical claims, each labeled by category (diagnostic, therapeutic, prognostic, pharmacological, anatomical, procedural, epidemiological, mechanistic, or guideline reference) and by the asserted confidence of the source AI."],
        ["Step 2: Citation extraction.", "A separate pass extracts every citation, reference, or source attribution. Explicit bibliographic citations, implicit references to guidelines, and vague authority appeals (\"studies have shown\") are categorized separately."],
        ["Step 3: Citation verification.", "Deterministic, not language-model-based. Each citation is checked against PubMed (via E-utilities) and CrossRef (via the public REST API) by PMID, DOI, or fuzzy match on author/year/journal. Citations that don't match are flagged as not found."],
        ["Step 4: Evidence relevance.", "For verified citations that return an abstract from PubMed, the audit evaluates whether the cited source actually supports the claim it is attached to. The taxonomy is supported, partially supported, unsupported, contradicted, or insufficient evidence. A contradicted citation escalates the audit to its highest risk tier."],
        ["Step 5: Missing data check.", "A clinically-trained prompt identifies what patient-specific data should have been considered for the recommendations to be safely applied. Output is categorized by data type and severity (critical, important, contextual)."],
        ["Step 6: Drug name verification.", "Medication mentions are validated against RxNorm. Non-medication tokens that appear in medication context are flagged. This catches the \"Pokémon as drug\" failure mode documented in clinical AI literature."],
        ["Step 7: Risk synthesis.", "A language model synthesizes the prior findings into a four-tier risk classification: critical issues, significant concerns, minor concerns, or no issues detected on these checks. The synthesis includes an explicit reasoning chain naming the specific findings that drove the tier."],
        ["Step 8: Ensemble comparison.", "When OpenAI and Google keys are configured, claim extraction runs as independent passes across Claude, GPT, and Gemini, and the app computes a real cross-model agreement score from mean pairwise claim-category overlap and corpus-fit consensus. With only the Anthropic key, it falls back to two temperature-varied Claude passes (0.2 and 0.7) for self-consistency. Where models agree, the audit signals consensus; where they diverge, the disagreement is surfaced openly and lowers the audit-of-audit confidence."],
        ["Step 9: Safe rewrite.", "The original input is rewritten to remove fabricated citations, downgrade overconfident claims, and add caveats for critical missing data, while preserving the source AI's clinical intent."],
        ["Step 10: Audit-of-audit confidence.", "A meta-uncertainty score is computed across the pipeline: evidence coverage, specialty match to the corpus, ensemble agreement, citation verifiability, and external API reliability. This score is displayed prominently — when the audit's own confidence is low, the user sees it."],
      ].map(([h, b]) => (
        <div key={h} className="mt-5">
          <strong className="text-[15px]">{h}</strong>
          <p className="text-ink-soft text-[15px] mt-1.5">{b}</p>
        </div>
      ))}
      <p className="text-ink-soft text-[15px] mt-8">
        The methodology is intentionally conservative. The thresholds for upward risk classification are
        deliberately low. Abstention ("insufficient evidence" or "cannot determine") is treated as a valid and
        often correct output rather than a failure.
      </p>
    </main>
  );
}
