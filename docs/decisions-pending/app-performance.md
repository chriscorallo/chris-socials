# App performance pass — Home, Videos, Plan, Calendar, video page, Upload, Film, Reference, Settings, nav (2026-10-18)

Chris (iPhone-first): "the whole app is very laggy and feels amateur." This pass measured first,
then fixed root causes everywhere except the video editor (`app/content/[id]/edit/**`) and
`/api/media` (owned by the parallel editor/playback pass).

## How it was measured

- **Production** (`chris-content-intelligence.vercel.app`, deploy `c485174`): Playwright/Chromium at
  393×852 @3x, iPhone UA, touch, **CPU 2× throttle, 4G-like network (100 ms added RTT, 9/3 Mbps)**.
  Logged in as the seeded owner. Metrics: TTFB/FCP/LCP per full load, tap-to-feedback and
  tap-to-content for bottom-tab switches (event timing for INP), JS/media bytes, RSC requests.
  Plus `curl` server timing per route with a real session (doc request time minus connection setup).
- **Local before/after on the same machine**: `next build && next start` against a throwaway
  PGlite (migrated + seeded) with 120 planned videos and 6 filmed videos, each with a 126 MB raw
  take (moov at the end, like a phone file), same Playwright profile.
- Scripts were kept out of the repo (scratchpad); the numbers below are their output.

## Region check

Vercel function region **iad1** (project `functionDefaultRegions: ["iad1"]`, Fluid compute on);
Neon host suffix **`c-14.us-east-1.aws.neon.tech`** (pooled + unpooled) → **co-located** (iad1 is
AWS us-east-1). No region change needed; `vercel.json` is unchanged. Measured server time per page
(curl, minus ~120 ms edge RTT from the test machine): Upload (auth only, no DB) ≈ 60 ms, Home ≈
190 ms, Videos ≈ 220 ms, Plan ≈ 280 ms → roughly 7 ms per sequential query on top of the base.
Occasional 0.6–2 s outliers = cold starts (see "Remaining").

## Baseline (production, before)

| | Value |
|---|---|
| Videos page with **2** videos | pulled a **228 MB** iPhone `.mov` + a **12 MB** render (`<video preload="metadata" src=…#t=0.6>` per card, each through a fresh 10-minute presigned URL so never cached); `load` event fired after **52 s** unthrottled |
| First tab switch Home → Videos (4G) | **5.4 s** to content (2.3 s before anything changed) — the RSC fetch was starved by the video downloads |
| Later tab switches | median **431 ms**, max **1.3 s** of nothing visible after the tap; INP up to **1.28 s** |
| FCP | 0.8 s Home, 1.3 s Videos (bandwidth contention) vs ~0.2 s on pages without videos |
| Calendar / Plan client JS | zod (375 KB raw / 88 KB br) shipped to the browser: Calendar 443 KB raw / 108 KB gz entry JS, Plan 554 KB / 141 KB |
| Plan HTML | ~530 KB (120 rows) |
| Function trace | every route ≈ 85 MB (ffmpeg-static 43.5 MB, sharp, media fonts) |

## Root causes found

1. **Lists loaded the actual video files.** Every `VideoThumb` was a `<video>` pointing at the raw
   take/render. On a phone that's tens to hundreds of MB per card, re-downloaded on every visit
   (fresh presigned URL each time), competing with navigation requests, and tearing those media
   elements down on navigation cost hundreds of ms of main thread (INP up to 2.3 s locally).
2. **No loading states anywhere.** No `loading.tsx` existed, so (per Next 16) dynamic routes weren't
   prefetched and a tap did nothing visible until the server had rendered the whole page and it had
   crossed the phone connection.
3. **Sequential queries in production.** The PGlite "sequential awaits, never Promise.all"
   convention (correct for the local DB) also ran on Neon: Home ≈ 17 sequential round trips,
   `getContentItem` 20, To-do/needs-you 15+ (incl. an N+1), Reference 8, Calendar 6–8.
4. **zod in client bundles.** `@chris/domain/planning` re-exports `posting-plan-core` (zod schemas);
   `components/ui.tsx`, `lib/calendar-views.ts`, the calendar sheet and plan-import modules imported
   it (or `PLAN_PLATFORMS` from it) for tiny helpers.
5. **Compositing cost.** Every `.panel` had `backdrop-filter: blur(20px)` — over a flat/pre-blurred
   background it changed no pixel but made each card (120+ on Plan) its own blurred layer,
   re-rasterized while scrolling on iOS. Same for three ≥94%-opaque sticky calendar headers.
6. **Smooth-scroll on every navigation.** `html { scroll-behavior: smooth }` + Next 16 no longer
   overriding it → a tab tap from a scrolled page animated the scroll to the top.

## Fixes

- **Poster thumbnails** — `GET /api/thumb/<storageKey>` (`lib/poster.ts`): a 360-px-wide JPEG frame
  (~16 KB) made once with ffmpeg (input-side seek, so over HTTPS from Blob it reads only the needed
  byte ranges), stored at `posters/v1/<key>.jpg`, served `Cache-Control: private, max-age=31536000,
  immutable` (keys are immutable). Ownership check (`lib/media-owner.ts`, the same rules as
  `/api/media`, its four lookups in one parallel batch) runs only on first generation; afterwards a
  stored poster is served with no DB round trip. Max 2 ffmpeg decodes per instance + one generation
  per key. If a poster can't be made (ffmpeg missing/failed/timeout), a transparent pixel with a
  5-minute cache → the card's existing gradient placeholder shows, never a broken image; `<img
  alt="">` (the link names the video). Used by Home/Videos cards and the calendar sheet; on-page
  players (video page hero + render, viewer check, reference videos) keep `<video>` but with
  `preload="none"` + `poster=` so no bytes load until Chris taps play.
- **Instant navigation** — `loading.tsx` for every main route, rendering the real nav bar (the
  tapped tab already highlighted) + a skeleton of the page's shape (`components/RouteSkeleton.tsx`,
  `data-skeleton`). Home, Videos and the video page were moved into route groups
  (`app/(home)`, `app/content/(list)`, `app/content/[id]/(detail)`) so their skeletons don't wrap the
  editor route (`/content/[id]/edit` has no new loading boundary — unchanged). URLs unchanged.
- **Tab prefetch** — the four tabs (`MobileNav`, desktop `NavLinks`) use `prefetch={true}` (full
  route prefetch), so a tab tap shows the real page from the client cache; `experimental.staleTimes
  .static = 30` (was 5 min) bounds that cache to 30 s; server actions that revalidate still clear it.
- **`queryAll`** (`packages/domain/src/db-concurrency.ts`) — runs independent query thunks with
  `Promise.all` when the DB is a hosted Postgres and strictly sequentially when it is local (PGlite
  is only ever served on localhost; `DB_PARALLEL_QUERIES=1|0` overrides). Applied to:
  `getContentItem` (20 → 2 waves), video page (item ‖ draft), `getTodoData` + `loadCourseInput`
  (≈15 → ~2 waves; the transitions query now filters by the same "not cancelled" condition via the
  relation instead of waiting for the id list), `getNeedsYouQueue` (6 → 1 wave, N+1 latest-attempt
  lookups in one parallel batch, push order preserved so sorting ties are unchanged), Home, Videos,
  Plan, Calendar (+ `loadCalendarEvents`), Film, Reference. This supersedes the "sequential awaits"
  convention for **production**; on PGlite behaviour is identical to before.
- **zod-free client imports** — `PLAN_PLATFORMS` moved to `plan-platforms.ts` (re-exported from
  `posting-plan-core`, so nothing else changes); new `@chris/domain/tz` and
  `@chris/domain/friendly-status` subpaths; client code (`ui.tsx`, `calendar-views.ts`,
  `CalendarClient`, `EventSheet`, `BatchUpload`) imports those. `PlanEditor` still imports
  `planning` (it validates the plan in the browser).
- **CSS** — removed `.panel`'s backdrop blur and three near-opaque sticky calendar header blurs
  (visually identical); kept the glass on the fixed top bar, tab bar, sheets and sticky action bars.
  `<html data-scroll-behavior="smooth">` so navigations jump to the top while in-page anchors still
  scroll smoothly.
- **Indexes** (migration `20261018050000_perf_lookup_indexes`, additive): `MediaAsset(storageKey)`,
  `Render(storageKey)`, `ContentItem(currentState)`, `ScheduleEntry(scheduledDate)`. At today's row
  counts Postgres may still seq-scan; these are for growth.

## After (local, same machine/profile; production expected to match or beat the local deltas)

| Metric | Before | After |
|---|---|---|
| Tap → something visible (tab switch, median / max) | 230 / 2305 ms | **~65 / 117 ms** |
| Tap → real content (tab switch, median / max) | 238 / 2315 ms | **~85 / 145 ms** (full-prefetch cache; skeleton fallback otherwise) |
| INP on tab taps (median / max) | 160 / 2272 ms | **16–32 / 56 ms** |
| First tab switch after load | 619 ms feedback, 4.3 s content | 117 ms / 145 ms |
| Video bytes downloaded by Home / Videos / video page in 6 s | 12.6 / 12.6 / 9.5 MB (and climbing) | **0 / 0 / 0** (posters ~16 KB each, cached forever) |
| Calendar entry JS (raw / gzip) | 443 / 108 KB | **93 / 30 KB** |
| Plan entry JS (raw / gzip) | 554 / 141 KB | **191 / 58 KB** |
| Home / Videos / video page entry JS (gzip) | 10 / 10 / 54 KB | 10 / 17 / 61 KB (route-group + skeleton chunks) |
| JS fetched in the first 6 s of a cold Home visit | 142 KB | 230 KB — the extra is the **prefetched** code of the 4 tabs, which is what makes the taps instant |
| Server queries per page on Neon (sequential waves) | Home ≈ 17, video page ≈ 21, To-do ≈ 15 | Home ≈ 3, video page ≈ 3, To-do ≈ 2 → ≈ 7 ms per wave saved, ~100 ms/page |

Production expectations: the ~5 s first-tab and 1–2 s tab stalls disappear (no video downloads,
skeleton/prefetch on tap); Home/Videos/video page stop spending 10–240 MB per visit on cellular;
page server time drops by ~100 ms on Home/video page/To-do; Calendar/Plan parse ~300–450 KB less JS.
The first visit after deploy generates each video's poster once (~1–2 s per video in the
background, max 2 at a time per instance); after that they're instant.

## Trade-offs and checks

- **Prefetch load**: each page view now asks the server for up to 4 full tab renders (one user;
  bounded by the 30 s cache). Remove `prefetch={true}` to fall back to skeleton-then-content.
- **Streaming status codes**: with a loading boundary the response starts streaming before the page
  runs, so `/content/<unknown id>` now renders the not-found UI with HTTP 200 + `noindex` (Next 16
  documented behaviour) instead of a 404 status. Same for the auth redirect (client-side redirect).
- **Local PGlite + `next start`**: concurrent requests (prefetches, first poster generation) can hit
  PGlite's known "Server has closed the connection" — the same pre-existing limitation the baseline
  showed on `/api/media`. `next dev` doesn't prefetch, so day-to-day dev is unaffected; Neon is fine.
- **Not verified locally**: ffmpeg reading an HTTPS presigned Blob URL from the Linux
  `ffmpeg-static` build (the network here was too unreliable to test; the Linux static build ships
  with TLS). If it fails, cards show the old gradient placeholder (no broken image) and the logs say
  `[thumb] poster unavailable`. Check one Videos visit after deploy.
- Tests: `db-concurrency.test.ts` (detection, strict sequential mode, parallel overlap, order,
  errors, real PGlite queries), `poster.test.ts` (URLs/keys/args, real ffmpeg on a normal and a
  too-short clip, failure). Full suite, typecheck and lint green. Visual check at 393×852 of Home,
  Videos, Plan, Calendar and the Videos skeleton; all main routes smoke-tested (200).

## Remaining recommendations (not done here)

1. **Cold starts** — every route's function traces ~85 MB (ffmpeg-static 43.5 MB, sharp, media
   fonts) because NavBar/VideoCard import server-action modules whose graphs reach `@chris/media`;
   server actions run in the page's function, so excluding them per route is unsafe without an
   audit. Worth a dedicated pass: move heavy actions behind route handlers or dynamic `import()`
   inside the action, then `outputFileTracingExcludes` per page.
2. **Fluid pool hygiene** — consider `attachDatabasePool` from `@vercel/functions` for the pg pool.
3. **Plan page payload** (~460–530 KB HTML for 120 rows): virtualize or paginate the "All" range, or
   render rows from a compact JSON prop.
4. **Posters at ingest** — generating the poster right after upload (the take is already local for
   ffprobe) would remove the one-time first-view cost; the editor/proxy work may already produce a
   frame to reuse (`posters/v1/<key>.jpg` is the shared location).
5. **`/api/media`** — its four sequential ownership lookups can use `lib/media-owner.ts`
   (one parallel batch) once the playback work there has landed.
6. **Server-Timing** — no permanent instrumentation was added; Vercel Observability's function
   duration per route is the place to watch the before/after on production.

Reversibility: high. Each piece is independent — revert the route groups/loading files, the
`prefetch`/`staleTimes` pair, the poster route + `<img>` swap, or set `DB_PARALLEL_QUERIES=0` to
restore fully sequential queries in production without a code change.
