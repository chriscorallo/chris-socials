# Security & Observability

Per spec §22. Requirements first, then concrete Phase 0 obligations that make them real
rather than aspirational.

## Security requirements

- No secrets committed to the repository, ever.
- Secrets come from environment variables / a secret manager, never hardcoded.
- Least privilege for every credential and service role (e.g. a Learning Agent's DB role
  never has write access to `BrandConstitutionVersion` — see `/docs/ARCHITECTURE.md`).
- Private media storage; public access only through signed URLs with expiry, never a public
  bucket for raw or unpublished media.
- Encrypted token storage for platform credentials (Instagram/TikTok/YouTube), with refresh
  handling that doesn't require manual re-auth on every expiry.
- Every audited action is logged (`AuditLog`) — never silently dropped.
- Backups exist for the database and for permanently-stored raw media.
- Explicit deletion strategy: deleting a `ContentItem` never deletes its `AuditLog` or
  `ContentStateTransition` history (episodic memory is permanent by construction, per
  `/docs/ARCHITECTURE.md`); only the underlying media/PII may be purged, and that purge itself
  is audit-logged.
- Provider credentials are isolated per environment — a dev credential can never touch a
  production platform account.
- Development / staging / production environments are kept separate — separate databases,
  separate credential sets, separate feature-flag states.
- External media, text, and tool output (platform API responses, comments, reference-creator
  content) is treated as **untrusted input** — never interpolated into a prompt or executed
  without validation.

## Observability requirements

Persisted, queryable, and correlatable by job/run ID: job IDs, agent runs, model calls
(provider, model, prompt version, tokens/cost where available), latency, errors, retries,
state changes, decisions, external API responses, publishing actions, repair-loop iterations,
human overrides. The system must be debuggable six months later from the repository and its
data alone — not from anyone's memory of a conversation.

## Phase 0 concrete obligations

- `.env.example` at the repo root lists every required environment variable with a
  placeholder value — never a real secret.
- `.gitignore` excludes `.env`, `.env.local`, and any file matching `*.local` from version
  control.
- `AuditLog` exists as a real table from Phase 0 (see `/docs/DATA_MODEL.md`) and is written to
  by, at minimum, every state transition and every feature-flag change — proving the write
  path works before anything higher-stakes depends on it.
- Passwords are hashed (never stored plaintext) — `User.passwordHash`, not `User.password`.
- Seed scripts never contain a real secret; the seeded dev user's password is a clearly-marked
  development-only value documented in `/docs/DECISIONS.md`, expected to be rotated before any
  production deploy.
- No platform (Instagram/TikTok/YouTube) credentials are introduced in Phase 0 — the adapters
  that will need them don't exist until Phase 5, so there is nothing to secure prematurely and
  nothing to get wrong early.

## Known deviation from a strict reading of the plan (logged per `/docs/DECISIONS.md`)

Local dev/test database in this environment uses an embedded Postgres-compatible engine
(`@electric-sql/pglite` via `@electric-sql/pglite-socket`, serving the real Postgres wire
protocol on a local TCP port) rather than Docker, because Docker and Homebrew are unavailable
in this sandbox. This is dev/test-only — the Prisma schema remains genuine PostgreSQL dialect
throughout, `docker-compose.yml` remains the documented path for anyone with Docker available,
and production always uses a real managed Postgres (Neon via Vercel Marketplace). See
`/docs/DECISIONS.md` for the full rationale.
