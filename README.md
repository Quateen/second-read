# Second Read

A safety audit for AI-generated clinical content. Paste an LLM answer in, get a structured safety report back — citation verification against PubMed and CrossRef, missing-data check, drug-name validation against RxNorm, self-consistency check across two Claude passes, and a "safe rewrite" with overconfident claims downgraded.

Built by a practicing neurosurgeon. Not a medical device. Educational use only.

---

## Where the API keys go

You'll touch this exactly twice: once locally (in `.env.local`), once in Vercel's UI (Environment Variables). Everything is set via `.env.example` as a template — copy it, then fill values.

| Variable                    | Required?            | What it does                                                                  | Where to get it                                                       |
| --------------------------- | -------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`         | **Yes**              | Claude Haiku — runs the LLM steps of the audit                                | console.anthropic.com → Settings → API Keys → Create Key              |
| `ANTHROPIC_MODEL`           | No (default Haiku)   | Override to test Sonnet/Opus. Default `claude-haiku-4-5-20251001`.            | —                                                                     |
| `NCBI_API_KEY`              | No                   | Raises PubMed rate limit from 3/sec to 10/sec                                 | ncbi.nlm.nih.gov/account → Settings → API Key Management              |
| `RESEND_API_KEY`            | No                   | If set, lead-form submissions are emailed to you                              | resend.com → API Keys                                                 |
| `LEAD_NOTIFICATION_EMAIL`   | No                   | Where leads go when Resend is configured                                      | Your inbox                                                            |
| `DAILY_AUDIT_LIMIT_PER_IP`  | No (default 5)       | Hard cap per visitor IP per day                                               | —                                                                     |
| `MAX_AUDIT_INPUT_CHARS`     | No (default 10000)   | Reject pastes larger than this. Cost-control on free tier.                    | —                                                                     |
| `NEXT_PUBLIC_SITE_URL`      | No (default secondread.health) | Used for canonical URLs and OG tags                                  | —                                                                     |

**Only `ANTHROPIC_API_KEY` is required to run.** Everything else is optional and the app degrades gracefully without them.

---

## Quick start (local)

Node 18.17+ required (`node -v`).

```bash
npm install
cp .env.example .env.local
# Edit .env.local: paste your ANTHROPIC_API_KEY. Leave everything else blank.
npm run dev
```

Open http://localhost:3000. Click **Load sample content** → **Run audit** to verify the end-to-end pipeline.

---

## What's live vs roadmap in v0.1

**Live (real API calls, real data):**
- Claude Haiku audit pipeline (8 sequential LLM steps, two parallel claim-extraction passes for self-consistency)
- PubMed citation verification — deterministic, via NCBI E-utilities (esummary + efetch for abstracts)
- CrossRef DOI / fuzzy citation verification — deterministic, via the public REST API
- RxNorm drug-name validation — deterministic, via NLM RxNav

**Roadmap (not in v0.1):**
- Scopus citation lookup — requires institutional API key
- ClinicalTrials.gov cross-check for cited trials
- True 3-model ensemble (Claude + GPT + Gemini) replacing the current two-pass self-consistency proxy
- Stripe billing + paid tiers
- Account system + audit history
- Public API for EHR integrators

The current self-consistency check is **not** a true 3-model ensemble — it's two Haiku passes at different temperatures (0.1 and 0.4). The UI says this honestly. Replacing it with Claude+GPT+Gemini is a half-day swap in `lib/audit-pipeline.ts`.

---

## Deploy to Vercel

1. Push this repo to GitHub (private is fine).
2. Go to vercel.com → **Add New** → **Project** → import the repo.
3. In **Environment Variables**, add `ANTHROPIC_API_KEY` (and any optional ones you've decided to use).
4. Click **Deploy**. First build is ~2 minutes.
5. Add a custom domain under **Settings** → **Domains**. Vercel shows the exact CNAME / A records — paste those into your registrar's DNS panel. Propagation usually under 10 min.

---

## Cost expectations

Claude Haiku 4.5: ~$1 per million input tokens, ~$5 per million output tokens (verify at console.anthropic.com — pricing changes).

A typical audit on a 5K-character paste uses roughly:
- ~12K input tokens across 8 LLM calls (input text repeated in several steps + JSON contexts)
- ~6K output tokens (structured JSON)

Per-audit estimate: `12,000 × $1/1M + 6,000 × $5/1M` = **~$0.042**

| Audits/month | Anthropic | Vercel    | Total           |
| ------------ | --------- | --------- | --------------- |
| 100          | ~$4       | $0 (free) | **~$4**         |
| 500          | ~$21      | $0 (free) | **~$21**        |
| 2,000        | ~$84      | $0–$20    | **~$84–$104**   |
| 10,000       | ~$420     | $20       | **~$440**       |

Worst-case a 10K-char paste with many extracted claims and citations could double per-audit cost. The `MAX_AUDIT_INPUT_CHARS` cap (default 10K) and `DAILY_AUDIT_LIMIT_PER_IP` (default 5) keep this bounded.

---

## Lead capture

The landing page and the FAQ both render a lead form. Submissions hit `/api/lead`. Behavior:
- If `RESEND_API_KEY` + `LEAD_NOTIFICATION_EMAIL` are both set, each lead is emailed to you.
- Otherwise, leads are logged to the Vercel function console (visible under **Logs**).
- Honeypot field + 5 leads/hour/IP cap protect against bot floods.

No database in v0.1. Add one when you have >100 leads/week.

---

## Rate limiting

`DAILY_AUDIT_LIMIT_PER_IP` (default 5) is enforced in an in-memory Map inside each serverless function instance.

Caveats — be honest with yourself about these:
1. **Per instance** — Vercel may run several function instances under load; each has its own counter.
2. **Resets on cold start** — idle instances restart and lose counters.
3. **Uses `req.ip`** (Vercel's edge-set value) — not `x-forwarded-for`, which clients can spoof.

This is "good enough" for v0.1. Upgrade path is Upstash Redis (~$0 at low volume); the limiter is a 10-line