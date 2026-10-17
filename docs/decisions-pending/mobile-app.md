# Pending decisions — iPhone-first app shell (merge into /docs/DECISIONS.md)

Scope: every page and shared component except the finishing editor
(`apps/web/app/content/[id]/edit/**`, `apps/web/lib/editor/**`). Evidence:
`docs/evidence/2026-10-16-mobile/`.

---

## 2026-10-16 — Mobile-first UI: phones are the primary target, desktop is the enhancement

**Decision:** Chris mostly uses the system on his iPhone, so every page is styled phone-first
(Tailwind defaults = phone, `sm:`/`md:`/`lg:` add the tablet/desktop treatment). Concretely:
16px+ form text (iOS Safari zooms the page on focus below 16px), 44px minimum tap targets for
buttons/inputs/tabs/checkbox hit areas (Apple HIG), `100dvh` instead of `100vh`, long words wrap
(`overflow-wrap: break-word`, `break-all` on URLs/filenames), and wide tables become cards on
phones (Analytics list, Autonomy grid, Performance Snapshots) while the tables stay from `sm`/`md`
up. Every form submit button shows a spinner + "Working…" and disables itself while the Server
Action runs (`SubmitButton`, `useFormStatus`) — many actions take tens of seconds, and without
feedback a phone tap looks like nothing happened.

**Rationale:** spec Final Test — simpler for Chris's real workflow. Verified with Playwright
device emulation (iPhone SE / 15 / 15 Pro Max, iPad, 1440 desktop): no element extends past the
viewport on any page, no form control below 16px, no console errors.

**Alternatives considered:** a separate mobile route tree (duplicated logic, two UIs to keep in
sync) — rejected.

**Reversibility:** high (CSS/markup only; no schema or behavior change).

---

## 2026-10-16 — Navigation: bottom tab bar + "More" sheet below `lg`, top bar on desktop

**Decision:** Below 1024px (phones and iPad portrait) the 10-link top nav is replaced by a fixed
bottom tab bar — Home, Content, Film, Calendar, More — padded by `env(safe-area-inset-bottom)`,
and a bottom sheet for the rest (Ideas, Strategy, Analytics, Learnings, Reference, Connections,
Sign out). The top bar shrinks to the brand only and pads under the status bar. The desktop top
bar is unchanged. One source list (`nav-links-data.ts`); a unit test asserts tabs + More cover
every desktop destination exactly once.

**Rationale:** the old nav was ~965px wide and pushed every phone page sideways. The four tabs
are the daily loop (what needs me → what's in production → what to film → when it posts).

**Reversibility:** high.

---

## 2026-10-16 — Content detail page: sticky "next step" in the thumb zone, history collapsed

**Decision:** On phones/tablets the detail page pins the single next action above the tab bar
(`StickyActionBar`) — the same Server Action the gold "Next Step" panel uses (e.g. Run Quality
Gate, Publish now), or a jump link to the panel when the step needs input (Schedule → `#schedule`,
Upload → `#media`). Read-only history (contract, research, script, take, edit plan, render, QC,
packages, publications, snapshots, evaluation, comments, creator card, feedback, cancel, audit
trail) is in native `<details>` panels, collapsed by default except where the current state
makes one the thing to look at (e.g. the script while SCRIPTED, the render video when it
succeeded, snapshots once live). Hidden at `lg+`, where the panels are all visible.

**Rationale:** the page was ~6,000px of identical panels on a phone; "what do I do next" is now
one thumb-reach away. No behavior change: no new actions, no changed authority, nothing skips a
gate — it's a second entry point to the same forms.

**Reversibility:** high.

---

## 2026-10-16 — Calendar: day-by-day agenda on phones, week grid from `lg`

**Decision:** One markup renders as a vertical agenda (one card per day, full-width entries,
thumb-sized platform toggles and native `datetime-local`) with a sticky 7-day strip that jumps
to each day, and as the existing 7-column grid at `lg+`.

**Reversibility:** high.

---

## 2026-10-16 — Home-screen app: manifest, icons, `viewport` export

**Decision:** `export const viewport` in the root layout (`width=device-width`, `initialScale 1`,
`viewportFit: "cover"`, `themeColor #050506`, dark color scheme — Next 16 moved these out of
`metadata`). `metadata.appleWebApp` (capable, title "Chris Studio", `black-translucent` status
bar), `app/manifest.ts` (standalone, dark, 192/512 + maskable icons), `app/apple-icon.png`
(180px) and `app/icon.svg` — all rendered from the existing gold→violet circle mark (sharp, one
time; PNGs committed). Short name "Chris Studio". Pinch-zoom is **not** disabled (accessibility);
zoom-on-focus is prevented by the 16px inputs instead.

**Reversibility:** high.

---

## 2026-10-16 — Raw-take picker accepts `video/*` on phones

**Decision:** The uploader is a large "Add raw takes" tile wrapping a hidden
`<input type="file" multiple>`. On touch devices `accept="video/*"`, because iOS only offers the
Photos library (plus camera and Files) when every accepted type is image/video; with
`audio/*` included it falls back to Files only. Fine-pointer (desktop) devices still accept
`video/*,audio/*` so audio-only takes remain possible there. Upload progress per file, a
"keep this screen open" hint, and a `beforeunload` warning while a transfer is in flight.

**Alternatives considered:** `video/*` everywhere (drops audio-only uploads on desktop).

**Reversibility:** high.

---

## 2026-10-16 — Shared CSS changes that also reach the editor

**Note for the editor owner:** `globals.css` changes are global. `.btn` now has
`min-height: 44px` (38px at `lg+` with a fine pointer), wraps its label on phones only, and is
`nowrap` from 640px; `.field-input` is 16px (14px at `lg+` fine pointer) with `min-height` 44px;
checkboxes/radios default to 20px (in `@layer base`, so utility classes like `h-4 w-4` still
win); `body` has `overflow-x: clip` as a last-resort guard. Editor files were not touched.

---

## 2026-10-16 — Verification environment notes (no product impact)

Turbopack's Google Fonts fetch timed out in the agent sandbox, so the throwaway screenshot
environment mirrors Inter locally via `NEXT_FONT_GOOGLE_MOCKED_RESPONSES`; WebKit could not be
downloaded in the sandbox (CDN connection resets), so device emulation used Chromium with
Playwright's iPhone/iPad descriptors (`isMobile`, `hasTouch`, DPR 2–3). Real-device Safari check
remains a follow-up (see "known gaps" in the hand-off report).
