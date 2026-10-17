# Pending decisions — Calendar views, posting plan, Stay on course (2026-10-17)

Written in /docs/DECISIONS.md format, to be merged there once the owner has looked at it.
Screenshots: `docs/evidence/2026-10-17-calendar/` (iPhone 15 393×852 and desktop 1440×900).

## 2026-10-17 — Calendar becomes Month / Week / Day / List (Apple/Google-style)

**Request:** "Make the calendar look and be modular like an actual calendar — month, week, or
day view. Combine how it is now with this."

**Decision:** `/calendar` renders one of four views, picked with a segmented control and
addressable by URL (`?view=month|week|day|agenda&date=YYYY-MM-DD`; the old `?week=` links still
open the week view). The last-picked view is remembered in a `cal_view` cookie (read on the
server, so there's no flash of the wrong view). Default with no cookie: Month.

- **Month** — desktop: a grid of whole Monday–Sunday weeks (leading/trailing days dimmed),
  up to 3 chips per day (platform dots + time + title, colored by status) and "+N more" →
  that day. iPhone: Apple-Calendar-style compact grid with up to 3 status dots per day (a
  hollow gold dot = an open plan slot) and the selected day's list below it.
- **Week** — 7-column time grid with hour rows, a red now-line, events as fixed one-hour
  blocks (posts are instants; a fixed visual length reads well and stacks cleanly),
  overlapping events side by side (`layoutOverlaps`), and an all-day "due" lane that shows
  pipeline deadlines ("Film 2", "Finish editing 1") on the day they fall due.
  **On iPhone (393px) it's a 3-day swipe view**: the same grid, three columns visible with a
  sticky time gutter, scroll-snapped horizontally across the week (opens on today's column).
  Chosen over the old day-agenda strip because the List view already covers "agenda", and a
  real time grid is what makes overlaps and the now-line legible.
- **Day** — a week strip on top (tap any day) and a single-column hour timeline with large
  events (title, time, status, platforms).
- **List** — 28 days of agenda from the anchor date, day headers sticky, empty days skipped.

Everything relevant is on the calendar: SCHEDULED items at their ScheduleEntry time;
PUBLISHED/MEASURING items at their first live publication time (Publication.publishedAt,
SUCCESS or DRAFT); failed (latest attempt FAILED) and missed (SCHEDULED, 30 min past due)
posts in rose; dated-but-not-READY items as "Not ready" (gold); and open posting-plan slots as
dashed placeholders. Status colors and platform dots live in one place
(`app/calendar/calendar-ui.tsx`) and a legend sits under every view.

Kept: Auto-Fill Week (now told the plan's open slots — see below), manual placement (the "+
Add" sheet, plus click an empty spot in Week/Day/Month on desktop), platform toggles, the
unscheduled READY pool.

**Time zone:** all calendar math uses APP_TIMEZONE explicitly through the new pure
`packages/domain/src/tz.ts` (Intl-based, DST-correct, no reliance on the process TZ that
instrumentation.ts sets). Days are carried as "YYYY-MM-DD" strings. The reschedule actions
convert wall time → instant on the server with the explicit zone; `placeOnCalendar` now parses
the datetime-local value the same way instead of `new Date(str)`.

**Reversibility:** UI only; no data changes. The old page is in git history.

## 2026-10-17 — Event sheet; no "Unschedule" button (state machine has no SCHEDULED → READY)

Tapping an event opens a bottom sheet (centered dialog on desktop; portaled to `<body>` so it
sits above the tab bar): latest successful render as a thumbnail (`<video #t=0.5>`, served by
the existing `/api/media` route; "No render yet" otherwise), status, time, platforms, post
links, failure note, and actions: Open, Edit video (only in FINISHING_EDIT_STATES), and
Reschedule (date + time + platforms) for READY/SCHEDULED items.

**Unschedule is deliberately not offered.** /docs/STATE_MACHINE.md has no `SCHEDULED → READY`
transition; the only legal ways off the calendar are `SCHEDULED → EDIT_PLANNED` (save an edit)
and `→ CANCELLED`. The sheet says so in one line. **Open question for Chris:** add
`SCHEDULED → READY` ("Unschedule") as a rollback? It's cheap (no re-render needed, gates still
valid) and would make "take this off Thursday" one tap. Not done here because changing the
transition table is a state-machine decision, not a UI one.

## 2026-10-17 — Drag to reschedule (desktop drag, iPhone long-press)

Pointer-event drag (`app/calendar/useEventDrag.ts`): mouse/pen drags after a 4px move; touch
picks the event up after a 350ms still long-press (a normal swipe still scrolls), then a
non-passive `touchmove` listener (registered at touch start, before iOS commits to scrolling)
stops the page scrolling while you move it. Time-grid drops snap to 15 minutes; month drops
keep the original time. Moves are optimistic and every one goes through the same domain path
as any other placement — `scheduleContentItemForPublishing` (audit `SCHEDULE_RESCHEDULED`, or
the READY → SCHEDULED transition) via the `moveEvent` server action. Only READY/SCHEDULED
events are draggable. Verified in Chrome with a mouse drag (Tue 6pm → Thu 3pm) and a CDP touch
long-press drag on the iPhone viewport (Mon 12pm → 3pm).

## 2026-10-17 — PostingPlan: versioned, append-only, one active row

**Decision:** new `PostingPlan` model (migration `20261017120000_posting_plan`): `version`
(unique), `active`, `startDate` (YYYY-MM-DD; no slots before it, so a new plan doesn't flag
last month as missed), `timezone`, `readyLeadDays` (default 1), `filmLeadDays` (default 3),
`sameForAll` (UI convenience), and `cadences` JSON — per platform `{platform, enabled,
postsPerWeek, preferredDays (0–6), preferredTimes ("HH:mm")}` validated by
`PostingPlanDataSchema` on every read and write. `savePostingPlan` writes version N+1, flips
the previous active row off and audits `POSTING_PLAN_SAVED`, in one transaction; old rows are
never edited. Single-active is enforced in that transaction rather than by a partial unique
index (Prisma's schema can't express one, and a hand-written index would drift from
`migrate diff`).

Editor at `/calendar/plan` (linked from the calendar's Stay-on-course panel and /todo):
per-platform on/off switch, posts/week stepper, Mon–Sun day chips, time chips with add/remove,
"Same schedule for all platforms" toggle, lead-time steppers, start date, and a live preview
of the resulting week that runs the same `generatePlanSlots` in the browser (via the new
Prisma-free `@chris/domain/planning` export). If posts/week exceeds days × times the editor
says "Only N fit" — the generator caps rather than silently stacking.

Slot generation (`generatePlanSlots`, pure): per Monday-start week, per enabled cadence,
`postsPerWeek` picks spread evenly over the preferred days (Monday-first), doubling up on a
day across its times when posts > days. `matchSlotsToSchedule` (pure): a post fills a slot when
it targets that platform, is on the same local day and within ±3h; each (post, platform) fills
at most one slot, nearest wins. Open slots at the same local time are grouped — one video
posted to several platforms is one "video" of work.

Auto-Fill Week now appends each platform's cadence and its next open plan slots to the
Scheduler Agent's existing per-platform quota notes, so it aims at the plan instead of
inventing a cadence (no change to the agent or its prompt).

**Reversibility:** drop the two tables; nothing else references them.

## 2026-10-17 — Stay on course + unified to-do list (deterministic)

**Decision:** pure `computeCourse` (`packages/domain/src/course.ts`) — arithmetic, not a model
call (CLAUDE.md: deterministic checks stay deterministic):

- **Coverage** for this week and next, per platform: planned / filled (scheduled or live) /
  live / missed / open; **streak** = consecutive complete weeks where every slot got a live
  post.
- **Open slots** (future, soonest first), each paired with the oldest unscheduled READY video
  → a one-tap "Schedule ‹title› into Thu 6pm TikTok + Reels" action.
- **Pipeline worked backwards** over open slots through the end of next week: the earliest
  slots get the most-finished videos (ready → editing → filmed → to film → being written →
  nothing); each group gets a deadline from the lead times (ready-by = slot − readyLeadDays,
  film-by = slot − filmLeadDays, scripts a day before that, ideas two days before) and is "at
  risk" once the deadline has passed. Summary line: "To fill 3 open slots through Sun, Oct 25
  you need 3 videos ready, the first by Tue, Oct 20. You have 2 ready, 2 in editing… → finish
  editing 1 by Thu, Oct 22" (the most urgent step).
- **Stuck:** MISSED (SCHEDULED > 30 min past due — and it no longer counts as filling its
  slot), PUBLISH_FAILED (latest attempt per platform), PUBLISHING > 60 min, QC_BLOCKED,
  RESEARCH_BLOCKED, FILMED > 2 days, editing states > 2 days, and dated-but-not-ready within
  48h. Thresholds are in `COURSE_THRESHOLDS`.
- Status: AT_RISK (any critical stuck item or a passed deadline) / BEHIND (missed slots this
  week, or slots with nothing in the pipeline) / ON_TRACK / NO_PLAN.

`buildTodoList` (`todo.ts`, pure) merges those nudges with: NEEDS YOU strategy decisions,
proposed beliefs and critiques (QC/claims/platform failures are already course items, so not
duplicated); platform connections the plan posts to (not connected / expired → critical if
posts are due there within a week; expiring within 7 days without a refresh token);
auto-publish on but no `scheduled-publish` JobRun in 24h (GitHub cron); auto-publish off with
posts due; Anthropic credit exhausted (latest failed ModelCallLog in 3 days whose error looks
like billing/credit, with no success since) else "AI agents are off" when the key is unset;
`brand/VOICE_SAMPLES.md` empty; no posting plan. Each nudge has a stable key, one action, and a
bucket (Today / This week / Setup); sorted blocking-first.

**Dismiss "Not today":** a tiny `NudgeDismissal (key, day)` table rather than a cookie, so a
dismissal on the iPhone also hides it on the desktop. It's keyed by local day, so the nudge
returns tomorrow if it's still true. Not an audit record; rows can be pruned.

**Surfaces:** a collapsible "Stay on course" bar at the top of `/calendar` (two lines when
collapsed — status pill + the single next step — so the calendar itself stays first on an
iPhone; expands to coverage bars + top 4 nudges), a compact On track / Behind card at the top
of Home (headline + top 3 + "See all"), and `/todo` (new; "To-do" added to the More sheet and
the desktop nav) with the full list grouped Today / This week / Setup.

**Alternatives considered:** an LLM "coach" summary — rejected for now; every number here is
countable, and a model would add cost and the risk of an invented deadline.

**Reversibility:** additive; remove the panel/card/page and the two tables.

## Known gaps

- Thumbnails come from the latest successful Render (master). RenderVariant cover frames
  aren't served by `/api/media` yet, so they aren't used.
- No "Unschedule" (see above) — needs Chris's call on the state machine.
- Touch drag is implemented in Week/Day; on iPhone Month you reschedule through the sheet.
- The plan's slots don't yet feed the worker or publish jobs — they're guidance and nudges,
  not an auto-publisher of their own.
