# Getting Started — running the system for real

Written for Chris. What to do, in order. Engineering detail lives in `/docs/DECISIONS.md`.

## 1. Run it on your Mac (works today)

```bash
pnpm install
pnpm db:up          # local Postgres (PGlite) — leave this terminal running; stop with Ctrl-C
pnpm dev:web        # in a second terminal → http://localhost:3000
```

Sign in with the `SEED_USER_EMAIL` / `SEED_USER_PASSWORD` from your `.env`.

**Before anything AI works:** top up the Anthropic account behind `ANTHROPIC_API_KEY` — it ran
out of credit on 2026-10-16. Normal use is a few dollars a week; there's a $30/day safety cap
(`MODEL_SPEND_DAILY_CAP_USD`).

The first transcription downloads the speech model (~280 MB) into `.cache/` — one time only.

## 2. The weekly loop

1. **Strategy** → *Generate thesis*, then *Generate portfolio proposal*. Approve the
   recommended set in one click; add any brand-new ideas the Strategist suggests.
2. **Content** (Planning / Research & Script tabs) → leave the checked items checked and click
   **Run Autopilot on checked**. For each video it drafts the production contract, researches
   with live web sources, writes the script, fact-checks the *final* script, runs the brand
   check, and drafts the Creator Card. It stops when it needs you.
3. Anything marked **You** needs a decision — usually a script the brand check flagged. Open
   it, read it, and edit it in your own words if you like (your edit is re-fact-checked
   before it can be filmed).
4. **Film** → everything ready to shoot, grouped by setup with hooks and talking points.
   Check off what you filmed → *Mark checked as filmed*.
5. Upload the raw takes on each video's page (any size, several at once). Transcription runs
   automatically.
6. **Content** (Editing tab) → **Run Autopilot on checked** again. It picks the take, plans
   the edit (cuts snapped to your words, word-by-word captions, headline/number callouts,
   punch-ins), renders, runs the four hard gates, and auto-repairs visual problems. You get a
   watchable render on each video's page.
7. **Calendar** → *Auto-Fill Week* (or schedule by hand). Then publish from the item, or turn
   on scheduled auto-publishing (step 3.6 below).
8. After posting, metrics and comments are captured on their own once the cron is set up;
   **Analytics** and **Learnings** fill in from there, and next week's thesis reads them.

Things only you can do: film, approve the portfolio, resolve anything marked **You**, and
anything subjective you want to override. Everything else either runs on Autopilot or is one
click.

## 3. Production on Vercel (one-time setup, in this order)

1. **Database:** add Neon Postgres from the Vercel Marketplace to the project (it sets
   `DATABASE_URL`). Then, from your Mac:
   `DATABASE_URL="<neon url>" pnpm db:migrate:deploy && DATABASE_URL="<neon url>" pnpm db:seed`
2. **Storage:** Vercel → Storage → create a **Blob** store with **private** access, connected
   to the project (sets `BLOB_READ_WRITE_TOKEN`).
3. **Env vars** (Project → Settings → Environment Variables): `AUTH_SECRET`,
   `ANTHROPIC_API_KEY`, `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, `APP_BASE_URL` (your production
   URL), `APP_TIMEZONE`. Generate secrets with `openssl rand -base64 32`. Full list with notes:
   `.env.example`.
4. **Deploy:** merge branch `fix/usable-v1` into `main` and push — Vercel builds it.
5. **Background jobs:** in GitHub → repo Settings → Secrets and variables → Actions, add
   `APP_BASE_URL` and `CRON_SECRET` (same value as in Vercel). If Deployment Protection is on,
   also add `VERCEL_AUTOMATION_BYPASS_SECRET` (Vercel → Settings → Deployment Protection →
   Protection Bypass for Automation). The `cron-tick` workflow then runs every 10 minutes.
6. **Scheduled auto-publish (optional):** turn on `publishing.scheduled_auto` at
   **Connections**. Off by default; only items you scheduled are ever posted.

Transcription doesn't run on Vercel (the speech model is too heavy for a serverless
function). Either upload and transcribe from your Mac against the same database, or paste the
transcript on the video's page.

## 4. Connecting the platforms

Open **Connections** in the app. Each platform needs a developer app first (one-time), then
"Connect" signs you in and stores the tokens encrypted, refreshing them automatically.

| Platform | You need | Before public posting |
|---|---|---|
| Instagram | Business/Creator account; Meta app with "Instagram API with Instagram login"; set `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` | Works for your own account in development mode; Meta App Review only if others will use it. Needs Blob storage (Instagram fetches the video from a short-lived private link). |
| YouTube | Google Cloud project, YouTube Data API v3 on, OAuth consent screen in **Production** (Testing-mode tokens expire weekly); `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | If uploads come back private, apply for the YouTube API audit — the app flags this on the publication. |
| TikTok | TikTok for Developers app with Login Kit + Content Posting; `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | Until TikTok audits the app, videos land in your TikTok **inbox** to finish and post in the TikTok app (`TIKTOK_POST_MODE=INBOX`, the default). |

Register these redirect URIs in each console: `<APP_BASE_URL>/api/oauth/instagram/callback`,
`/api/oauth/youtube/callback`, `/api/oauth/tiktok/callback`.

## 5. Make it sound like you

Fill `brand/VOICE_SAMPLES.md` with 5–10 transcripts of your best real videos (instructions are
in the file). Scripts and the brand check use them as the reference for your voice. This is the
single biggest quality lever left.

## 6. Check the AI's judgment

Once the API key has credit:
`pnpm --filter @chris/evals eval` runs the gold-standard checks (fact-check traps such as wrong
contribution limits, voice vs generic-AI copy, cringe vs good CTAs) and prints a pass/fail
table with cost.
