# Pending decisions — the simple flow (2026-10-17)

Merge these into `/docs/DECISIONS.md` when the branch lands. Evidence:
`/docs/evidence/2026-10-17-flow/` (iPhone 15 393x852 + desktop 1440x900, real dev server,
real upload of a synthetic `say`-voiced video, real local transcription).

Chris, verbatim: *"Where is the editor??? The flow of this app is confusing, I can't lie...
it's not intuitive and natural flowing."*

---

## 2026-10-17 — Upload goes straight into the editor, with no AI required

**Decision:** after a footage-first upload (`/upload`, or "Upload footage" on a video's page)
the app waits briefly for the captions, then makes a deterministic **starter edit** and opens
`/content/[id]/edit`. `createStarterEdit(prisma, contentItemId, actor)`
(`packages/domain/src/starter-edit.ts`) makes zero model calls and goes through the real state
machine — `recordTakeSelection` (MEDIA_INGESTED → TAKE_SELECTED, reason "Auto: no AI
needed — …") then `recordEditPlan` (TAKE_SELECTED → EDIT_PLANNED). Idempotent: an item that
already has a plan in an editable state just returns it. Every "Edit video" button on an item
at MEDIA_INGESTED/TAKE_SELECTED runs it (`startEditing` in `app/content/[id]/flow-actions.ts`).

- **Take choice:** one take → it; several → the **longest** (ties → most recent upload). The
  upload screen says "several takes of the same video is fine", i.e. retakes; stitching them
  all together would repeat the video. The longest is the likeliest complete take; the others
  are in the editor's media bin to swap or add.
- **Plan:** a plain `EditPlanOutput` (whole take, 1080x1920, loudness-normalized, captions ON
  in the house BOLD_HIGHLIGHT style, no overlays) with **no `plan.timeline`**. The editor
  (`initialEditorDoc`) and the renderer (`timelineForPlan`) both convert it with
  `planToTimeline` at load time, which enables captions only when the take has word timings.
  So captions appear as soon as the background transcription lands — no re-plan needed. A
  web test (`apps/web/lib/starter-edit.test.ts`) pins the plan to `EditPlanOutputSchema`
  (domain can't import packages/agents).
- **Waiting for captions:** the upload screen polls `captionStatus` every 2 s for up to 90 s
  ("Getting your captions ready…", with "Open the editor now" to skip). On Vercel, where
  transcription is off, it doesn't wait.
- Uploading footage to a video still at READY_TO_FILM first applies the allowlisted manual
  transition READY_TO_FILM → FILMED ("I've filmed this") — uploading footage is that fact.
- "Improve with AI" (the existing Edit Planner re-plan from EDIT_PLANNED) is still on the
  video page; Take Selector / Edit Planner are still offered as secondary actions before an
  edit exists.

**Alternatives considered:** keep all takes as consecutive clips (rejected as the default
for retakes, see above); store a full `plan.timeline` (rejected — it would freeze captions
off when the transcript hadn't arrived yet); skip the state machine and write EDIT_PLANNED
directly (forbidden).

**Reversibility:** high. Additive domain function; AI planning is untouched.

**Known limit:** if Chris saves a finishing edit before the transcript lands, that saved
timeline has captions off (he can turn them on in the Captions tool). The editor only picks
up a newly-landed transcript on reload — we don't poll inside the editor (not this change's
file).

---

## 2026-10-17 — Plain language for every status; one shared module

**Decision:** `packages/domain/src/friendly-status.ts` maps all 24 ContentStates to plain
words (Idea · Planned · Writing · Ready to film · Filmed — upload footage · Editing ·
Checking · Needs a fix · Ready to post · Scheduled · Posting… · Posted · Done · Cancelled),
the five-step progress (Plan → Write → Film → Edit → Post), the Home groups, and the ONE next
action per state (`nextActionFor`). It's exported from the browser-safe
`@chris/domain/planning` too. `stateLabel`/`contentStateTone`/`StatusPill` in
`app/components/ui.tsx` use it, so lists, badges, calendar sheets, analytics and the video
page never show an enum. (The audit-trail list shows friendly names with the raw transition
in a tooltip.) Tests: `friendly-status.test.ts` asserts every state has a label with no
enum-looking text and exactly one next action.

**Reversibility:** high — presentation only; the state machine is unchanged.

---

## 2026-10-17 — Home = your videos; Videos = card grid; Home · Videos · + Upload · Calendar · More

**Decision:**
- **Home** (`app/page.tsx`): greeting; one big "Do this next" card (a blocked video first,
  then a video mid-edit/awaiting upload, then the top posting-plan nudge, then any video
  waiting on Chris); a one-line Stay-on-course row (→ /todo); then "In progress", "Ready to
  post", "Posted" as big cards (thumbnail = latest good render, else the first take via a
  `#t=` media fragment; plain status pill; one button: Edit video / Edit / Upload footage /
  Film it / Schedule / View post / Fix). Ideas are counted, not listed. **First run** (no
  videos): "Let's make your first video" with "Upload a video I filmed" and "Plan a new
  video". The thesis/performance/creative-director/needs-you panels moved off Home (they're
  under More → Strategy / Analytics / Learnings / To-do).
- **Videos** (`app/content/page.tsx`): the same cards in a grid with filters (In progress,
  Needs a fix, Ready to post, Posted, Ideas, All). Batch Autopilot is kept, folded under
  "Autopilot (AI)".
- **Nav:** phone tab bar Home · Videos · (+) Upload (center) · Calendar · More. Film moves
  into More (and into every "Film it" button). Desktop shows the same four + a "More" menu.
  `nav-links-data.ts` (`PRIMARY_LINKS`, `MORE_LINKS`, `TAB_LINKS`) + `mobile-nav.test.ts`.

**Reversibility:** high — no data changes.

---

## 2026-10-17 — The video page: video, status, progress, ONE button; the rest under "Details & history"

**Decision:** `/content/[id]` now opens with the video (latest good render, else the take,
else a placeholder — small beside the title on phones so the next step stays above the
fold), the title, the plain status pill, "Scheduled for …"/"Posted …", the 5-step progress
bar, and one big primary button for the next step plus at most two secondary ones. The
sticky Next-step bar on phones shows the same action. Only the input the current step needs
is open on the page (upload box, schedule form, plan-by-hand, shot-notes-by-hand, what the
final check found). Every other panel — Autopilot, each AI step, contract, research, script
versions + editing, take selection, edit plan, renders + technical QC, quality gate,
packages, publications, snapshots, evaluation, comments, creator card, takes + transcripts,
calendar date, taste feedback, cancel, audit trail — is unchanged and lives in a collapsed
"Details & history" section. No control was removed.

The editor page's "no edit yet" screen (an old link to `/edit` before an edit exists) now
offers "Edit video" (the starter edit) instead of "once the AI has planned the edit" — a
small, link-only change to `app/content/[id]/edit/page.tsx`.

**Reversibility:** high — re-arrangement of existing panels.
