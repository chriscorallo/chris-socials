# Pending decisions — platforms, publishing, measurement (2026-10-16)

Entries in `/docs/DECISIONS.md` format, for the integrator to merge. They cover the publishing
hardening work in `packages/platforms`, `packages/domain` (preflight, publication, snapshots,
credentials, JobRun) and `apps/worker` (publish, snapshot, comment, autonomous, scheduled
jobs), plus the new OAuth connect flow in `apps/web`. The last section lists the exact wiring
`apps/web` still needs, because this branch didn't edit existing web files.

API details below were checked against the official docs on 2026-10-16:

- Instagram (Instagram API with Instagram Login): `developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login`,
  `.../instagram-platform/content-publishing`, `.../instagram-graph-api/reference/ig-user/media`,
  `.../instagram-platform/reference/instagram-media/insights`
- YouTube: `developers.google.com/youtube/v3/docs/videos/insert`, `.../docs/videos` (resource
  limits), `.../guides/using_resumable_upload_protocol`, Google OAuth 2.0 for web server apps
- TikTok: `developers.tiktok.com/doc/oauth-user-access-token-management`, `/doc/login-kit-web`,
  `/doc/content-posting-api-reference-direct-post`, `/doc/content-posting-api-reference-upload-video`,
  `/doc/content-posting-api-reference-query-creator-info`, `/doc/content-posting-api-reference-get-video-status`,
  `/doc/content-posting-api-media-transfer-guide`
- YouTube Shorts length (3 minutes since 2024-10-15): YouTube's announcement, as reported by
  secondary sources. I couldn't load the official support page.

---

## 2026-10-16 — Branch base: fast-forwarded to `fix/usable-v1`

**Decision:** this worktree branch started at `main` (eabf37d), which doesn't have the
`PlatformCredential.metadata` / `JobRun` schema or the throwaway-test-DB setup this work
assumes. Both are in `fix/usable-v1` (4995adb). I fast-forwarded the branch to 4995adb before
making any changes. No schema edits were made here.

**Alternatives:** work against `main` and add the schema myself. That would collide with the
owner of `schema.prisma` and break the brief's "schema already available" contract.

**Rationale:** it's the documented base, and the fast-forward didn't rewrite anything.

**Reversibility:** high. Merge this branch onto whichever branch carries 4995adb.

---

## 2026-10-16 — Preflight requires a QC PASS for the exact render being published (critical)

**Decision:** `runPreflight` now BLOCKs unless the latest QC report for the latest successful
render has `overallStatus = PASS`. A missing QC report counts as a block too: a skipped gate
fails closed. Preflight also now checks:
- **Media spec, per platform** (`packages/domain/src/platform-limits.ts`):
  - vertical 9:16 within ±3%
  - Instagram Reels: 3s–15min, ≤300MB, width ≤1920
  - YouTube Shorts: ≤180s
  - TikTok: 3s–10min (API cap), ≤4GB, 360–4096px; the live `creator_info`
    `max_video_post_duration_sec` overrides when available
  - Missing duration/dimensions/size fail closed.
- **Text limits:**
  - Instagram: caption ≤2,200 chars, ≤30 hashtags, ≤20 @-mentions, measured on the *composed*
    caption (caption + appended package hashtags)
  - TikTok: ≤2,200 UTF-16 units
  - YouTube: an explicit title ≤100 chars with no `<` `>`; description ≤5,000 bytes
  - Overflowing hashtags block instead of being silently dropped.
- **Credentials:** through the adapter's `checkCredentials()`, which now goes through the
  refreshing credential store, so an expired-and-unrefreshable token shows up as a specific
  "reconnect" reason.

Every failure is its own specific reason string.

**Alternatives:**
- Check QC once at READY. Rejected: READY doesn't stop a re-render from slipping through.
- Warn instead of block. Rejected: this is a hard gate (CLAUDE.md: a BLOCK is never averaged
  away).

**Rationale:** the audit found that a gate-skipped video could be published. This is the one
place every publish path passes through: human click, autonomy, and the scheduled cron.
`tryAutonomousPublish` is covered by a test proving earned autonomy can't bypass it.

**Reversibility:** high. Pure, deterministic checks; the limits are constants in one file.

---

## 2026-10-16 — Retrying a failed platform after the item is PUBLISHED

**Decision:**
- Preflight accepts `PUBLISHED`/`MEASURING` in addition to `SCHEDULED`/`PUBLISHING`, but only
  for a platform whose latest attempt is not SUCCESS/DRAFT.
- `publishContentItem` only calls `startPublishing` from SCHEDULED.
- `finalizePublishing` transitions only from PUBLISHING. It also records the PUBLISHING
  autonomy outcome only on that transition, which fixes a pre-existing double count on
  idempotent re-runs.

**Alternatives:** a separate "retry platform" state. Rejected: it would need a schema/state-machine change, and
nothing regresses this way.

**Reversibility:** high.

---

## 2026-10-16 — Per-(item, platform) publish lease: advisory-locked claim + JobRun row

**Decision:** before calling an adapter, the publish job claims a lease:
1. A short `$transaction` takes `pg_advisory_xact_lock(hashtext('publish-lease:<item>:<platform>'))`.
2. Inside it, it checks for a RUNNING `JobRun` of that kind (younger than 20 min) and inserts
   one if there isn't one.
3. The slow network work runs *outside* any transaction. The lease row is closed as
   SUCCEEDED/FAILED in `finally`.
4. A lease older than 20 min is treated as a crashed process and taken over. The old row is
   marked FAILED with a reason.
5. A held lease means the platform is *skipped* ("already in progress"), not FAILED.

**Alternatives:**
- A unique-constrained "pending" Publication: needs a schema/enum change, which isn't allowed
  here.
- A session advisory lock held for the whole publish: unsafe with a connection pool (lock and
  unlock can land on different connections) and on serverless.
- A JobRun row without the advisory lock: racy (two inserts can both see "no lease").

**Rationale:** prevents double-click, two tabs, and cron + human from double-posting, with no
schema change. Verified on the PGlite test database: advisory xact locks work there, and a
`Promise.all` of two concurrent `publishContentItem` calls posts exactly once.

**Reversibility:** high. Lease rows are ordinary JobRun rows with kind `publish-lease:*`.

---

## 2026-10-16 — Ambiguous publish outcomes and recovery

**Decision:**
- Adapters throw `AmbiguousPublishError` when the *committing* step gets no response:
  - Instagram `media_publish`
  - a YouTube upload whose session status can't be read
  - TikTok's final chunk
- The publish job records it as FAILED with errorMessage prefix `AMBIGUOUS:`.
- On the next attempt, before posting again, it calls the adapter's optional
  `findExistingPost` (I chose matchers that cost little or no quota):
  - **Instagram:** recent `/{ig-user}/media` whose caption equals the composed caption,
    posted after the attempt minus 15 min
  - **YouTube:** the channel's uploads playlist (1 unit, not search.list's 100) matching the
    exact composed title
  - **TikTok DIRECT:** `/v2/video/list/` (scope `video.list`), matching title + `create_time`
  - **TikTok INBOX:** drafts can't be looked up, so this throws
- Outcomes:
  - **Found:** a SUCCESS attempt is recorded with the recovered id/url ("Recovered: … not
    re-posted") and verified.
  - **Confirmed absent:** it posts normally.
  - **Can't check:** it records a FAILED "check the account; if the post isn't there, retry to
    post" and doesn't post. The next deliberate retry posts.

**Alternatives:**
- Treat every network error as FAILED. That's the old behavior, and it causes double-posts.
- Block forever until a human marks it resolved. That needs new UI/state.
- Embed an idempotency marker in the public caption/description. That pollutes public text.

**Rationale:** the safest reversible behavior that keeps Chris's workflow to "retry".

**Reversibility:** high. The matchers are adapter-internal.

---

## 2026-10-16 — Publish verification actually runs (verifiedAt)

**Decision:** after every SUCCESS/DRAFT, the publish job calls `adapter.verify()` with a short
budget (default delays 2s/5s/10s, injectable).
- On success, `markPublicationVerified` sets `verifiedAt`, can replace `platformPostId`/`url`
  with a resolved value (TikTok publish_id → video id), and appends caveats to `errorMessage`.
  The original id is kept in `rawResponse.originalPlatformPostId`; the publish response moves
  to `rawResponse.publish` and verification goes to `rawResponse.verification`.
- If the post isn't verified in time, it gets a "Not yet verified … re-checked by the snapshot
  sweep." note, which is cleared once verified.
- `captureDueSnapshotsForAll` re-verifies unverified publications from the last 7 days.

**Alternatives:** a separate Verification table. Rejected: `verifiedAt` already exists on
Publication.

**Rationale:** spec §22: a publish isn't done until verified. Updating the attempt's own
verification fields completes that row; it doesn't rewrite history, and both responses are
kept.

**Reversibility:** high.

---

## 2026-10-16 — OAuth connect flow, encrypted credential store, automatic refresh

**Decision:**
- **Domain:** `packages/domain/src/platform-credential.ts` persists already-encrypted strings
  and lists non-secret summaries. Audit entries never contain token material.
- **Platforms:**
  - `packages/platforms/src/oauth.ts`: authorization URLs, code exchange, refresh.
  - `credential-store.ts` (`PlatformCredentialStore`): decrypts (AES-256-GCM,
    `TOKEN_ENCRYPTION_KEY`), refreshes near expiry, persists refreshed tokens, and falls back
    to the legacy `*_ACCESS_TOKEN` env vars when no row exists.
  - `factory.ts` (`createPlatformAdapters({ prisma, env?, fetchImpl? })`): the replacement for
    `apps/web/lib/platform-adapters.ts`.
- **Adapters** take a token provider per call. Their old static-credential constructor shapes
  still work, so the current web code compiles unchanged.
- **Refresh windows:**
  - YouTube: ~1h tokens, refreshed within 5 min of expiry with the Google `refresh_token`
    grant.
  - TikTok: access 24h, refreshed within 5 min of expiry. The refresh token (365d) may rotate,
    and the new one is always stored. Its expiry goes in `metadata.refreshExpiresAt`.
  - Instagram: the long-lived token (60d) refreshes itself with `ig_refresh_token` within 7
    days of expiry, but only once it's ≥24h old (Meta's rule).
  - A failed refresh of a still-valid token falls back to that token; an expired one surfaces
    a "reconnect in Settings → Connections" error.
- **Scopes:**
  - Instagram: `instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights,instagram_business_manage_comments`
  - YouTube: `youtube.upload youtube.readonly`, with `access_type=offline&prompt=consent` so a
    refresh token is always issued. If one is missing, the exchange errors and tells Chris how
    to fix it.
  - TikTok: `user.info.basic,video.publish,video.upload,video.list`
- **PKCE:** TikTok documents PKCE only for mobile/desktop. The web flow uses `client_secret`
  server-side, so no PKCE.
- **Instagram account id:** taken from `GET /me?fields=user_id,username` after the long-lived
  exchange.
- **CSRF:** a random 32-byte `state` in an httpOnly, SameSite=Lax cookie (path `/api/oauth`,
  10 min), compared with `timingSafeEqual` in the callback.
- **Web:** `/settings/connections` (new) shows each platform's status, account, expiry,
  scopes, missing scopes, and missing server env, with Connect/Reconnect/Disconnect. It also
  has the `publishing.scheduled_auto` toggle and recent cron JobRuns.

**Alternatives:**
- Credential store in packages/domain: impossible without a circular dependency (domain must
  not depend on platforms, and the crypto lives in platforms).
- NextAuth account linking: that's for app sign-in, not long-lived posting credentials.

**Reversibility:** high. The env-token fallback keeps old deployments working.

---

## 2026-10-16 — Instagram adapter corrections

**Decision:**
- **Host/version:** stays on `graph.instagram.com` (Instagram Login, consistent with OAuth).
  The version comes from `INSTAGRAM_GRAPH_API_VERSION`, default `v25.0`, which is the current
  docs' examples.
- **URL:** taken from `permalink` after publish and again on verify. The old `/reel/{media-id}/`
  was wrong: media ids aren't shortcodes.
- **Insights:**
  - `views, likes, comments, shares, saved, reach, ig_reels_avg_watch_time`. `plays` is gone;
    `views` is currently marked "in development".
  - `ig_reels_avg_watch_time` is converted from ms to seconds. The reference page doesn't state
    the unit; ms matches observed API behavior and the audit finding.
  - Reads now throw `PlatformHttpError` on non-2xx.
- **Caption:** package hashtags are appended to the caption, normalized and deduped
  case-insensitively, within limits. `coverFrameSeconds` maps to `thumb_offset` in ms, and
  `share_to_feed=true` is set.
- **Status polling:** the budget is configurable (default 6 × 10s ≈ 1 min, down from 5 min
  inside a request).
  - **Still IN_PROGRESS:** FAILED with a `PENDING_PROCESSING:` prefix plus a `resumeToken`
    (container id + createdAt). The publish job stores it in `rawResponse.resumeToken`; the
    next retry, or the scheduled sweep within 23h, resumes without re-uploading.
  - **Container already PUBLISHED:** the adapter recovers the post with `findExistingPost`.
- **Comments:** paginated through `paging.next` (up to 20 pages of 50).

**Not done:** Instagram's resumable upload (`rupload.facebook.com`). The docs restrict it to
Facebook Login for Business, so it doesn't apply here.

**Reversibility:** high.

---

## 2026-10-16 — YouTube adapter corrections

**Decision:**
- **Upload:** the resumable upload protocol (session POST → PUT). On a dropped connection or a
  5xx it queries `Content-Range: bytes */N` and resumes from the acknowledged `Range`, up to 3
  times. A session it can't read is AMBIGUOUS.
- **Metadata:**
  - Title: explicit title, or the caption's first line; `<` `>` stripped, ≤100 code points (no
    split surrogate pairs).
  - Description: caption + deduped hashtags, ≤5,000 bytes, no `<` `>`.
  - Tags: ≤500 chars counted the YouTube way (commas, plus quotes for tags with spaces).
- **Privacy:** `privacyStatus` comes from `YOUTUBE_PRIVACY_STATUS` (default `public`).
  `verify()` reads `status.uploadStatus`/`privacyStatus`: rejected/failed/deleted means not
  verified, with the reason. A requested-public video that comes back private is verified with
  the note "Uploaded but private — YouTube API audit required …".

**Correction to the brief:** the current `videos.insert` page says "Videos uploaded from
unverified API projects are not restricted to private viewing mode." The lock-to-private
situation can still happen (older policy, or a channel that defaults uploads to private), so
the check stays, but the note names both causes.

- **Read errors:** metrics/comments throw on HTTP errors; metrics also throw for a missing
  video. Comments are paginated by `pageToken`, and `commentsDisabled` yields `[]`.

**Reversibility:** high.

---

## 2026-10-16 — TikTok adapter: INBOX by default, creator_info, chunking, id resolution

**Decision:**
- **Post mode:** `TIKTOK_POST_MODE` = `INBOX` | `DIRECT`. Default is INBOX unless
  `TIKTOK_APP_AUDITED=true`.
  - **INBOX:** `/v2/post/publish/inbox/video/init/` (scope `video.upload`). The video lands in
    Chris's TikTok inbox to finish in the app, so the outcome is DRAFT with that message.
    Limit: 5 pending shares per 24h; the error code is mapped to a hint.
  - **DIRECT:**
    - Calls `creator_info/query` first.
    - Privacy: `PUBLIC_TO_EVERYONE` only when audited and allowed, else `SELF_ONLY` when
      offered. If nothing is usable it fails before uploading and points at INBOX: unaudited
      clients can only post to *private* accounts.
    - Respects `comment/duet/stitch_disabled` and the creator's max duration, and sends
      `video_cover_timestamp_ms`.
- **Chunking** follows the media transfer guide: ≤64MB is a single chunk; otherwise 10MB chunks
  (clamped 5–64MB, ≤1000 chunks), `total_chunk_count = floor(size / chunk)`, with the trailing
  bytes merged into the last chunk (≤128MB). Sequential PUTs with `Content-Range`.
- **Status and ids:**
  - A short status poll after upload catches an immediate FAILED (`fail_reason`).
  - `publicaly_available_post_id` (sic) is parsed from the raw JSON text, because those int64
    ids exceed 2^53.
  - A resolved id becomes `platformPostId` (via verify/sweep).
  - `getMetrics` refuses an unresolved publish_id (throws, so the offset stays due) and throws
    on API errors.
- **Comments:** `listComments` stays `[]`; there's no endpoint at this tier (unchanged
  decision).

**Known limit:**
- TikTok exposes the video id only for *public* posts after moderation. Private/inbox posts
  never get one, so they have no TikTok metrics. That's an honest gap.
- The post URL needs `creator_username` from creator_info. It's cached per adapter instance,
  so a URL resolved in a later sweep (new instance) may stay null.

**Reversibility:** high. An env flag switches modes.

---

## 2026-10-16 — Honest snapshot windows; archiving no longer waits forever

**Decision:**
- An offset can only be captured inside its own window, `[dueAt, dueAt + max(1h, 25% of the
  offset))`: T+1h → [1h, 2h), 6h → [6h, 7.5h), 24h → [24h, 30h), 72h → [72h, 90h),
  7d → [7d, 8.75d), 30d → [30d, 37.5d). The windows never overlap.
- A capture on day 8 records only T+7d. Earlier offsets are reported as `missed` and never
  backfilled.
- All offsets due in one run share one metrics read.
- An adapter read error records nothing, is reported in `errors`, and leaves the offset due.
- Archiving happens when every published platform has T+30d captured *or* its T+30d window has
  closed (37.5d).
- An item stuck at PUBLISHED with nothing capturable moves PUBLISHED → MEASURING → ARCHIVED
  once the window closes.

**Alternatives:** capture late offsets with a "late" flag. Rejected: that needs a schema
change, and a late number labelled T+1h still misleads downstream evaluation.

**Rationale:** spec §23: never fabricate a metric.

**Consequence:** the sweep must run at least hourly to catch T+1h.

**Reversibility:** high. The window function is one pure function.

---

## 2026-10-16 — Scheduled publishing and measurement sweeps (`apps/worker/src/scheduled-jobs.ts`)

**Decision:**
- **`publishDueScheduledItems({ prisma, storage, adapters, now?, getPublicVideoUrl?, … })`**
  - Gated by feature flag `publishing.scheduled_auto`. It's OFF when the row is absent; the
    toggle is on Settings → Connections.
  - Publishes SCHEDULED items with `scheduledDate <= now`. Items more than 24h overdue are
    reported as `missed` and never posted late.
  - Also resumes only `PENDING_PROCESSING` platforms (resume token less than 23h old) through
    `publishContentItem(..., { onlyPlatforms })`. It never blanket-retries real failures.
  - Each item is isolated; every run writes a `JobRun` (kind `scheduled-publish`) with a
    summary.
- **`captureDueSnapshotsForAll({ prisma, adapters, now? })`** (JobRun kind `snapshot-sweep`)
  - Re-verifies unverified publications, captures due snapshots for every PUBLISHED/MEASURING
    item, and archives finished ones.
  - Ingests comments only for items that hit a measurement point this run, to bound API cost.
  - It's read-only toward the platforms, so it has no flag.

**Rationale:** a human scheduled the item, so the content is approved. Posting with nobody
clicking is still new autonomous behavior, so it's flagged off by default (CLAUDE.md).

**Reversibility:** high. Turn the flag off.

---

## 2026-10-16 — Instagram public video URL is an injected dependency

**Decision:** `publishContentItem(..., { getPublicVideoUrl?: (storageKey) => Promise<string | null> })`.
It's only called for Instagram, once per run. If it's absent or returns null, Instagram is
recorded as FAILED with a clear reason, and the adapter is never called.

**Rationale:** Instagram fetches the video itself. The storage choice (Vercel Blob) belongs to
`apps/web`.

**Reversibility:** high.

---

## WIRING NEEDED IN apps/web

This branch didn't edit any existing `apps/web` file. The integrator needs to do the
following.

1. **Adapters:** replace `getPlatformAdapters()` in `apps/web/lib/platform-adapters.ts` with a
   per-request factory. It's cheap to construct, and it must *not* be a module-level singleton
   holding tokens:
   ```ts
   import { prisma } from "@chris/domain";
   import { createPlatformAdapters } from "@chris/platforms";
   export function getPlatformAdapters() { return createPlatformAdapters({ prisma }); }
   ```
2. **Public video URL provider** (`apps/web/lib/public-video-url.ts`, new):
   `getPublicVideoUrl(storageKey: string): Promise<string | null>`. It reads the bytes with
   `storage.get(storageKey)` (or uses the Blob URL directly once storage *is* Blob) and uploads
   with `@vercel/blob` `put("ig-publish/<storageKey>", bytes, { access: "public", addRandomSuffix: true, contentType: "video/mp4" })`,
   returning `.url`.
   - Per `/docs/SECURITY.md` (no permanently public raw media), delete the blob once the
     Instagram publish is verified, or have a daily cron delete `ig-publish/*` older than 24h.
     Containers expire at 24h anyway.
   - Env: `BLOB_READ_WRITE_TOKEN`.
3. **Publish actions** (`apps/web/app/content/[id]/actions.ts`):
   - `runPublish`: `publishContentItem(prisma, storage, getPlatformAdapters(), contentItemId, { actorId }, { getPublicVideoUrl })`
   - `tryAutonomousPublishAction`: `tryAutonomousPublish(prisma, storage, getPlatformAdapters(), contentItemId, { actorId }, { publish: { getPublicVideoUrl } })`
   - `runCaptureSnapshots` / `runIngestComments`: these now return `errors` (and snapshots also
     return `missed`). Surface non-empty `errors` through the existing `pipelineError` redirect
     instead of discarding the result.
   - The content page's "Runs Preflight + Publish + Verify" text is now accurate. Optionally
     show each Publication's `verifiedAt` and `errorMessage` notes ("Not yet verified…",
     "Uploaded but private…", "Sent to your TikTok inbox…").
4. **Cron routes** (new) plus `vercel.json`:
   - `app/api/cron/publish-scheduled/route.ts` (GET):
     - Require `request.headers.get("authorization") === \`Bearer ${process.env.CRON_SECRET}\``,
       else 401.
     - Then: `const r = await publishDueScheduledItems({ prisma, storage, adapters: createPlatformAdapters({ prisma }), getPublicVideoUrl }); return Response.json(r);`
     - Set `export const maxDuration = 300`.
     - Import from `@chris/worker/scheduled-jobs`; the export is already added in
       `apps/worker/package.json`.
   - `app/api/cron/snapshots/route.ts` (GET): same auth; `captureDueSnapshotsForAll({ prisma, adapters: createPlatformAdapters({ prisma }) })`;
     `maxDuration = 300`.
   - `vercel.json`:
     ```json
     { "crons": [
         { "path": "/api/cron/publish-scheduled", "schedule": "*/10 * * * *" },
         { "path": "/api/cron/snapshots", "schedule": "0 * * * *" } ] }
     ```
     Sub-daily crons need a Vercel Pro plan; Hobby allows once a day. The snapshot cron must be
     at least hourly for T+1h.
   - Exclude `/api/cron/*` from any auth middleware/proxy (they use `CRON_SECRET`, not a
     session).
5. **Nav:** add `{ href: "/settings/connections", label: "Connections" }` to
   `apps/web/app/components/nav-links-data.ts`.
6. **Auth middleware/proxy (if any):** `/api/oauth/*` relies on the normal session cookie. The
   provider's redirect back is a top-level GET, so SameSite=Lax session cookies are sent. Don't
   block or rewrite these paths.
7. **Platform consoles:** register these redirect URIs exactly:
   `${APP_BASE_URL}/api/oauth/instagram/callback`, `/api/oauth/youtube/callback`,
   `/api/oauth/tiktok/callback`.
8. **Env vars** (add placeholders to `.env.example`, real values only in Vercel):
   - `APP_BASE_URL`: e.g. `https://<prod-domain>`, no trailing slash needed.
   - `TOKEN_ENCRYPTION_KEY`: `openssl rand -base64 32`. Rotating it invalidates stored
     credentials; reconnect afterwards.
   - `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`: the *Instagram* app id/secret from the Meta
     dashboard's "Instagram API with Instagram Login" product.
   - `INSTAGRAM_GRAPH_API_VERSION`: optional, default `v25.0`.
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `YOUTUBE_PRIVACY_STATUS`: optional; `public` | `unlisted` | `private`, default `public`.
   - `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`
   - `TIKTOK_APP_AUDITED`: default `false`.
   - `TIKTOK_POST_MODE`: optional; `INBOX` | `DIRECT`. Default is INBOX unless audited.
   - `CRON_SECRET`
   - `BLOB_READ_WRITE_TOKEN`
   - Legacy fallbacks, still honored when no credential row exists: `INSTAGRAM_ACCESS_TOKEN`,
     `INSTAGRAM_IG_USER_ID`, `YOUTUBE_ACCESS_TOKEN`, `TIKTOK_ACCESS_TOKEN`.

### Only the owner can do

- **Meta:** App Review / Advanced Access for `instagram_business_content_publish`,
  `instagram_business_manage_insights` and `instagram_business_manage_comments`; switch the app
  to Live; the account must be a professional (Business/Creator) account.
- **Google:** OAuth consent-screen verification (`youtube.upload` is a sensitive scope; the
  app stays in "testing" with test users until verified); the YouTube API Services audit if
  uploads come back private or more quota is needed.
- **TikTok:** app review for Login Kit + Content Posting API (both `video.upload` and
  `video.publish`); the Content Posting **audit** before public direct posts. Until then, keep
  INBOX mode.
- **Vercel:** a Pro plan for sub-daily crons; set the env vars above.
