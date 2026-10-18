## Graphics library 2 — platform-style UI, phone & apps, search, news, hooks, FX, life (2026-10-18)

**Why:** Chris wants the motion-graphics library to go far beyond finance charts — "a ton of
content and animations for like if you're on Google, TikTok, Apple, YouTube, as well as trending
on Twitter, or other things besides social media… as many as you could think of for video
content that would add value and visual hooks or even just visuals."

## Decision 1 — Same system, more base components (no one-offs)

Library 2 extends the existing `GRAPHIC` template (Graphics library decision, 2026-10-18): every
new graphic is a parametric **base component** reading the one shared, editable data model, and
every library entry is a **preset** (data). Nothing is a bespoke template.

- **33 new base components** (61 GRAPHIC components + 14 classic templates in total), in
  `packages/media/src/graphics/families/{social,phone,web,life,fx}.ts` (spec + design size per
  component; the header comment of each file is the field mapping per variant). Their specs are
  merged into `GRAPHIC_COMPONENT_SPECS`; `graphicDesignSize` delegates to the family sizers.
  - Search & web: SEARCH_BAR (typing + autocomplete / results / "people also ask" / command
    search), BROWSER (window / loading / 404 / cookie banner), WEB_CARD (link preview /
    encyclopedia box / review / product).
  - Social posts: SOCIAL_POST (short post / pro network / forum / photo post), COMMENT (reply
    sticker / pinned / thread / question box), TRENDING (ranked / hashtags / rising), VIDEO_CARD
    (tile / player + chapters / subscribe press / view counter), STORY (poll / question / slider
    / quiz stickers), SOCIAL_COUNTER (milestone / action rail / profile / live), BURST (floating
    hearts / double tap / rain / confetti).
  - Phone & apps: DM_CHAT (messages / DM / group / bubbles — typing dots, receipts, tap-backs),
    NOTIFICATION (stack / lock screen / banner), CALL (incoming / banner / video / missed),
    PHONE_APP (notes / reminders / inbox / email / invite), CLOCK_TIMER (alarm / timer /
    stopwatch / clock time-lapse), STATUS_ALERT (battery / no signal / alert / toast), APP_GRID
    (home grid with badges / dock / app listing), KEYNOTE (stage-style big number / title /
    specs / reveal on a plain black or white stage).
  - News & media: NEWS (breaking bar + ticker / headline / front page / highlighted article /
    clippings / "as seen in"), MEDIA_PLAYER (podcast / now playing / title card / voice memo).
  - Life & places: MAP_NAV (route + ETA / pin drop / flight arc / trip), WEATHER (now / week),
    SCREEN_TIME, PAYMENT (received / feed / receipt printing / declined), TRAVEL (ride /
    delivery / boarding pass / ticket), DATE (page flip / month crossed off / years / days
    until), TRACKER (habit grid / workout sets / mood), LIST_SPLIT (pros & cons / do's & don'ts /
    myth → fact).
  - Hooks, reactions & FX: VERDICT (MYTH/FACT/TRUE/FALSE stamps, big tick, big X, tape),
    HOOK_TEXT (comic POW / meme captions / POV / wait for it / plot twist / chapter), COUNTDOWN
    (3-2-1 / ring / flip digits / bar), QUIZ (question + reveal / poll results / stars / rate
    1–10 / this or that), SCREEN_FX (full-frame: glitch, film burn, light leak, speed lines, VHS,
    spotlight, punch frame, before/after split).
- **13 new 3D objects** on the classic ICON_3D template (TROPHY, ROCKET, LIGHTBULB, BRAIN, GIFT,
  KEY, MAGNIFIER, MEGAPHONE, CROWN, FIRE, LIGHTNING, TARGET, LAPTOP), procedurally modeled in
  `templates/three.tsx` with the existing studio lighting/material families and LINE fallbacks.
- **7 new categories**, chip order: Money & numbers · Charts · Comparisons · **Social posts** ·
  **Phone & apps** · **Search & web** · **News & media** · **Hooks & quizzes** · **Reactions &
  FX** · Timelines & steps · Lists & tables · **Life & places** · Text & titles · Callouts &
  annotations · 3D objects · Transitions & emphasis · Follow & CTA (the old "Social & CTA",
  relabelled; ids are stable).

## Decision 2 — The data model grows additively

`GraphicPropsSchema` gains `meta` (≤ 60, nullable — a time stamp, URL, app/source name) and
`tone` (AUTO / DARK / LIGHT; AUTO = the component's `toneDefault`); `GraphicItemSchema` gains
`side` (NONE / ME / THEM — conversations) and `meta` (≤ 40); `itemText` max 80 → 120 (longer
messages/comments). All default, so every saved timeline and all 171 earlier presets parse
unchanged (tested). Specs gain optional `uses.meta / tone / quick / ownFormat / labels`,
`items.side / meta / valueRequired`, `toneDefault`, `backdrop: "PLAIN"`; the edit sheet reads
them (Look: Auto/Dark/Light; per-component field labels — "Display name", "Handle", "Search
query"…; a Me/Them picker per message; meta inputs; the generic number-format section is hidden
where numbers are drawn in the component's own style, e.g. social counts "12.4K").
`graphicShownNumbers` lists `meta`/`item.meta` text, so the FACTUAL gate sees them.

The Motion Designer's strict model schema is unchanged (prompt version unchanged):
`meta`/`tone` are contract-only keys taken from the preset, and when the model supplies items,
the preset's per-entry `side`/`meta` are kept by position. The library catalogue in its prompt
is generated, so it now lists the new components and presets; the GRAPHIC guide line says to use
platform-style UI only when Chris refers to it and never to invent quotes/posts/messages or use
real brand names. The ICON_3D enum (contract **and** the model's strict schema + guide line) gains
the 13 new objects, so the model is never told about icons its schema would reject.

## Decision 3 — Brand-safe, no impersonation (hard rule)

All platform-like graphics are **generic "-style" UIs**: no official logos, wordmarks, trademarks,
verification badges, exact proprietary layouts, system fonts or signature colours (no bird/X
mark, no red play-button logo, no search-engine letter colours, no messaging-app blue — "me"
bubbles use the palette's accent). The platform feel comes from layout conventions and neutral
marks (a generic play glyph, a magnifier, initials avatars on gradients, original line glyphs on
tinted app tiles — `ui.tsx` `Avatar`/`AppTile`). Every name, handle, app name, outlet and URL is
an editable field; defaults are placeholders ("Your Name", "@yourhandle", "Alex", "Mom", "Bank",
"The Daily Ledger") with Chris-relevant sample copy. "As seen in" draws placeholder outlet names
as neutral type, never logos. Tags may contain platform words ("tweet", "google", "imessage") so
search works — the graphics themselves never show a brand. Numbers in presets are illustrative;
the Quality Gate still refuses ungrounded on-screen numbers, quotes are Chris's to supply.

## Decision 4 — Quick entry speaks three text dialects (deterministic)

`quick-entry.ts` `parseQuickText` / `applyQuickText` (+ `toQuickEntry` round-trip), selected by
`uses.quick`: **CHAT** `Me: running late | Mom: again?? | Me: rent went up $300` (Me = right,
other names = them with the name as sender, unlabelled lines alternate); **LINES** `1. Rent
prices 120K | 2. #budget — Trending in Finance 48K` (rank dropped, trailing count → value,
" — " → second line); **QUERY** `is a 401k worth it | …suggestions` (first group = query /
question, rest = entries; trailing numbers stay text when the component has no values). Numeric
quick entry is unchanged for every other component.

## Decision 5 — Search + suggestions

- ~35 new synonym groups ("google"→search, "tweet"/"x"→post, "text message"/"imessage"/"dm"→
  conversation, "notification", "news", "map", "subscribe", "viral/trending", "venmo"→payment,
  "uber"→ride, "boarding"→flight, "myth"→verdict…).
- `suggestGraphics` detects explicit language and pre-fills: "I googled is a 401k worth it" →
  SEARCH_BAR typing exactly that query; "my landlord texted me '…'" → DM_CHAT with the quote as
  their message; "breaking news: …" → NEWS with the headline; "went viral / trending" → TRENDING;
  "subscribe" (not "subscriptions") → subscribe press + follow CTA; "hit 100k followers" →
  milestone counter with 100k; myth/false/fact → VERDICT; "plot twist", "wait for it", "POV: …",
  "storytime", quizzes, "rate it out of 10", pros & cons, countdowns, weather, flights, a named
  city → pin drop, screen time, gym sets, streaks, podcasts, rides, "declined". Library-2
  suggestions resolve presets by component + variant (featured first), not by id.

## Decision 6 — Rendering

New families `packages/motion/src/remotion/graphics/{social,phone,web,life,fx}.tsx`, wired in
`registry.ts`; shared library-2 kit `ui.tsx` (tone colours with contrast-safe accents
`readableOn`, `card`, `Avatar`, `AppTile`, `socialCount`, typewriter/caret, typing dots, press/
ripple); 50 new original line icons (app glyphs, weather, OS, reaction faces, skull, 100…) —
never system emoji. Full-screen scenes honour `tone` (soft light studio backdrop) and
`backdrop: "PLAIN"` (keynote stage). Same performance rules as before (pure functions of the
frame, no React state/effects, no per-element blur, modest node counts) — the editor Player and
the server render draw the same components, so preview = render.

## Counts

| | Before | Library 2 | Total |
|---|---|---|---|
| GRAPHIC base components | 28 | +33 | 61 (+ 14 classic templates) |
| ICON_3D objects | 10 | +13 | 23 |
| Presets | 171 | +279 (263 GRAPHIC + 16 3D) | 450 |
| Categories | 10 | +7 | 17 |

New presets per family: social 56, phone & apps 61, search/web/news/media 46, life & places 53,
hooks/reactions/FX 47, 3D objects 16. Library chips at the end of the pass: Social posts 48 ·
Phone & apps 61 · Search & web 27 · News & media 19 · Hooks & quizzes 28 · Reactions & FX 27 ·
Life & places 47 (+ 6 in Lists & tables) · 3D objects 30.

## Evidence (verification)

- **Real renderer, every new preset:** `packages/motion/scripts/graphics-library.ts <out> --from=171
  --mid --posters=apps/web/public/motion-posters` (new `--from` flag) rendered all 279 presets
  (settled + mid-animation) through Remotion — **0 failures**, 113 s. Every settled frame and a
  sample of mid sheets were reviewed by eye (plus close crops at phone size). Fixes from that
  review: the video-call tile no longer takes an olive tint from the caller's name; brand names
  removed from preset copy ("Lambo", "reddit" in a search suggestion, "signal" as an outlet);
  one over-long pin subtitle shortened. Each family builder had already iterated its own frames
  (both tones, long text) before integration.
- **Posters:** 279 new posters (all 450 now exist; folder 5.4 MB).
- **MP4 samples** (alpha layer over a stand-in, frames checked): text thread (typing dots →
  bubbles → receipt), search typing + autocomplete + tap, breaking-news bar with looping ticker,
  100K follower milestone (odometer + confetti).
- **Editor at 393×852** (throwaway PGlite on 55491, `next dev` on 3471, Playwright): library
  shows "Search 450 graphics…"; every new category chip lists its presets with real posters
  (0 broken, 0 drawn fallbacks); searches "google", "text message", "breaking news", "tweet",
  "subscribe" return the right graphics first; inserting a text thread opens its edit sheet with
  Look (Auto/Dark/Light), contact/status/receipt fields, quick entry ("6 messages") and a Them/Me
  picker per message; 0 page errors.
- **Tests:** `pnpm typecheck`, `pnpm lint`, `pnpm test` green (1896 passed). New:
  `packages/media/src/__tests__/graphics-library-2.test.ts` (bounds, ≥200 new presets, original
  order intact, old props parse, tone defaults, canvas fit, meta in the factual list, **a
  brand-safety scan of every new preset's on-screen copy**, quick-entry dialects + round-trip,
  14 search synonyms, transcript suggestions incl. "subscriptions" ≠ subscribe); editor tests for
  the chat dialect, side alternation and inserting every new preset; the existing headless test
  renders every preset (incl. all new ones) at entrance/mid/settled/exit with no NaN.

## Not verified / known gaps

- Real iPhone playback of the heaviest new presets in the live Player (Chromium emulation only);
  particle/rain/confetti presets are capped at ≤ 40 particles but weren't profiled on a device.
- The motion designer was only exercised with the mock provider (no model call).
- Some fixed UI words are not editable (Decline/Accept, Snooze/Stop, Get/Open, "Subscribed").
- Short presets reach their settled look early (the 34 % "mid" frame is often already built).
- Two family files duplicate layout constants between the sizer (`families/*.ts`) and the
  component (phone chat metrics, life month table) — edit them together.

## Renderer / deploy note

The motion package changed (new components, new compositions per preset, new 3D models):
**the cloud renderer's snapshot / pre-built Remotion bundle (MOTION_BUNDLE_DIR) needs a rebuild**
before library-2 graphics render on the live site. Not done here (no Vercel changes).

## Reversibility

High: everything is additive (components, presets, optional fields, categories, synonyms).
Removing a family leaves saved graphics of that component unrenderable (the visual is reported,
not mis-rendered) — keep the components if Chris has used them. An old app build reading a
timeline that uses a library-2 component would reject that visual (unknown component).
