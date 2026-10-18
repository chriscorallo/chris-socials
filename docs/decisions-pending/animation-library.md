# Graphics library: composable, data-driven motion graphics (2026-10-18)

**Why:** Chris tried to build a graphic on the fly — "three positions: Employee, Freelance,
Business owner; above Employee a card of 4k × 12 months; then Freelance; then Business owner with
$0, $5k, −$15k, −$5k, $50k, $5k, $0, $100k, all on the same card" — and couldn't: the 14 classic
templates have fixed shapes (a bar chart is 2–6 bars, a comparison is exactly two strings).
He asked for a library of 100–200 animations that are modular, multi-animated, highly adjustable
(any data, labels, number of items/series), categorised, searchable, with suggestions.

## Decision 1 — ONE new template, `GRAPHIC`, over a universal data model (not 200 one-offs)

`packages/media/src/graphics/contract.ts` (pure). `MOTION_TEMPLATES` gains `GRAPHIC`; its props
are a base `component` (28 of them) + one universal, fully editable data model shared by every
component:

- `series[]` (label, values[], icon, colour, note, text cells) · `categories[]` · `items[]` (text,
  sub, value, icon, colour, formula operator, checklist state) · `title/subtitle/body` ·
  `highlight` · `showTotal` · `range` · `format` (NUMBER/CURRENCY/PERCENT, k/M auto or forced,
  decimals, signs, red negatives, prefix/suffix) · `animation` (element entrance RISE/POP/FADE/
  SLIDE/WIPE/DROP/FLIP/BLUR; order TOGETHER/STAGGER/GROUP_BY_GROUP/ONE_BY_ONE; stagger; group
  pause; speed; count-up; emphasis NONE/PULSE/GLOW/RING/SHAKE; element exit CONTAINER/REVERSE/
  DROP/FADE_UP) · `screen` (OVERLAY box, or FULL-screen scene with its own backdrop).
- `GRAPHIC_COMPONENT_SPECS` says, per component, its variants (layouts) and which parts of the
  model it reads with bounds — this drives validation (plain-English issues via `superRefine`),
  the edit sheet (which sections show), the Motion Designer catalogue and the quick-entry mapping.
- **Base components (28 new + the 14 classic templates = 42):** STAT_TILES, BIG_NUMBER (solo /
  from→to / odometer), MONTH_GRID (strip / calendar), VALUE_COLUMNS (Chris's layout), FORMULA (row /
  receipt), VERSUS, ENTITY_CARDS (row / grid / podium), BEFORE_AFTER, BAR_GROUP (grouped / stacked /
  horizontal, negatives), LINE_AREA, WATERFALL (steps / cash-flow "rollercoaster"), DONUT (donut /
  pie / half), PROGRESS (rings / bars), GAUGE (dial / segments), SCATTER (dots / bubbles), STEPS
  (vertical / horizontal / roadmap), CHECKLIST, RANKING, TABLE, KINETIC (stack / highlighter /
  strike→replace / outline), QUOTE (quote / note / bubble), LOWER_THIRD, ANNOTATION (circle / arrow /
  underline / box), STICKER (badge / stamp / price bubble), MAP_PIN (abstract map, pins / route),
  ICON_BURST, CTA (follow / save / comment / share), TRANSITION (wipe / iris / slam / flash —
  full-frame).
- **Footprints follow the data:** `graphicDesignSize(props)` is the box the component lays out in;
  `footprintOf(template, props)` (visual-footprints.ts) returns it (or FULL_FRAME for full-screen
  scenes), and the placement engine, interaction engine, scene sampling and the renderer's
  `placementBox`/`designSizeOf` all use it — so a 4-person, 12-month graphic reserves a taller box
  than a 2-row one, in the editor and the render alike. Classic templates are unchanged.

**Alternatives:** 150 hand-made templates (unmaintainable, not editable); one zod schema per
component in a discriminated union (28 forms, a 28-way agent schema, no shared quick entry);
generic "props: record" (rejected: CLAUDE.md typed outputs).

## Decision 2 — Presets are DATA (169 of them), so every one is fully editable

`graphics/presets.ts`: 169 curated presets (147 GRAPHIC + 22 on the classic templates, incl. all
ten 3D objects and three money stacks), each with id, name, description, category (10: Money &
numbers, Charts, Comparisons, Timelines & steps, Lists & tables, Text & titles, Callouts &
annotations, 3D objects, Transitions & emphasis, Social & CTA), tags, suggested seconds,
placement/palette/SFX. Chris's example is the flagship preset `income-3-people-12-months` with his
exact numbers (Freelance's values are placeholders — he gave none), full-screen, built person by
person, totals under each column. Numbers in presets are illustrative; the editor says so and
the Quality Gate still refuses any ungrounded on-screen number.

## Decision 3 — Rendering: shared kit + pure sequencer; parity by construction

`packages/motion/src/remotion/graphics/` — `kit.tsx` (context, colour tokens → theme palette,
count-up with a format planned from the FINAL value so "1k 2k 3k 4k" never flips to "2,700",
element entrance/exit/emphasis vocabulary scaled by the motion language), `graphics-timing.ts`
(pure `graphicSequence`: groups × order × stagger, **auto-compressed so the build always finishes
before the exit with a 0.6 s hold**; `emphasisFrame` lands the highlight on the speaker's vocal
hit when Motion v2 provides one), `icons.tsx` (58 original line icons — never system emoji: the
iPhone and the Linux render host have different emoji fonts), and the families `money.tsx`,
`charts.tsx`, `compare.tsx`, `text.tsx`, dispatched by `Graphic.tsx` (overlay box or full-screen
scene). The same components render in `VisualsLayer` (server render) and the editor's Player.
Performance: pure functions of the frame, no React state/effects, CSS blur only when ≤ 12
elements animate. The classic AUTO transition for GRAPHIC is a plain FADE (elements carry the
motion).

## Decision 4 — Quick entry: a deterministic parser (no AI)

`graphics/quick-entry.ts`: `Employee: 4k x12 | Freelance: 2k,6k,0,8k,3k,… | Business owner: 0,
5k, -15k, -5k, 50k, 5k, 0, 100k` → series. Groups by `|`, `;`, newline; `Label: values`; label/
value pairs (`Rent 1800, Food 650`); word-only groups → categories; numbers with $/€/£, thousands
commas (kept apart from list commas), k/m/mm/b/bn, %, +/−/-, accounting `(15k)`; repeats `4k x12`,
`4k ×12`, `4k*12`, `x12 4k`; ellipses ignored; unreadable tokens become warnings, never guesses.
`applyQuickEntry` maps it onto series- or item-shaped components (12 unlabelled values → month
names; existing icons/colours kept); `toQuickEntry` round-trips the current data into the box.

## Decision 5 — Search + suggestions are deterministic; AI is an optional extra

- `graphics/search.ts`: every query word must match (exact, prefix, synonym group — "paycheck" →
  income, "vs" → comparison — or Damerau–Levenshtein ≤ 1/2), ranked name > tag > component >
  description, +phrase, +featured, +favourite, +recent.
- `graphics/suggest.ts`: from the words around the playhead (sentence + ~9 s ahead, because
  comparisons span sentences) it detects money/percent/plain numbers (incl. "five thousand
  dollars", "lost 15k" = −15k), roles (employee / freelancer / business owner / renting / owning…),
  vs-language, from→to, lists, monthly/yearly, debt/growth/budget, and returns presets PRE-FILLED
  with those values (each role gets the amounts said after it). Always offers the words as
  kinetic text.
- **"Suggest with AI"** reuses the Motion Designer with a new optional `focus` window (one
  graphic for one moment; proposals outside it dropped) through the existing job/heavy-job path.

## Decision 6 — Motion Designer 1.1.0 → 1.2.0 chooses among presets and fills data

The model-facing schema gains a strict `GRAPHIC` variant: `preset` (id or null), `component`,
`variant`, content fields (null = keep the preset's), `range`, `format`, `order`, `screen`.
`graphicPropsFromModel` merges the content onto the named preset (unknown presets ignored), then
the contract validates. `numbersShownBy("GRAPHIC")` uses `graphicShownNumbers`, which includes
DERIVED numbers (column totals, running totals, donut shares, gauge scale) — the factual hard rule
and the Quality Gate's FACTUAL check cover them (a test proves an ungrounded total drops the
graphic). The prompt carries a compact library catalogue (component → reads → preset ids).
`AGENT_CONTRACTS.md` row updated. Tested with MockModelProvider only (no credit).

## Decision 7 — Favourites + recents per user (additive migration)

`20261018050000_graphic_preset_prefs`: new table `GraphicPresetPref` (userId, presetId, favorite,
useCount, lastUsedAt, favoritedAt; unique per user+preset). `packages/domain/src/graphic-prefs.ts`
— idempotent upserts, recents capped at 12. Server actions in the editor are best-effort (the
library works without them). No AuditLog rows: UI convenience, not history (edits are versioned).

## Decision 8 — Editor: library in the Visuals sheet, generated edit sheet

- `GraphicLibrary.tsx`: sticky search, "For this moment" suggestions (+ Suggest with AI), category
  chips incl. ★ Favorites / Recent, a 2-column grid of real rendered posters
  (`apps/web/public/motion-posters/<id>.jpg`, built by `packages/motion/scripts/graphics-library.ts
  --posters=…` through the real renderer; a drawn fallback if one is missing), ▶ opens a live
  looping preview (`@chris/motion/preset-player`, mounted only while open). Tap = insert at the
  playhead in the free gap (presets carry their own length), then its edit sheet opens.
- `GraphicEditor.tsx`: layout/variant + full-screen, quick entry (live parse summary), text, a data
  table (rows × columns, add/remove, sticky row labels, per-row "Fill: 4k x12", icon + colour per
  row, text cells for tables), entries (value, sub, icon, operator, state, colour, reorder),
  highlight/totals/range, number format with a live example, animation controls. Pure ops in
  `lib/editor/graphics.ts`; every change is one undo step.
- The classic 14-template gallery is replaced by the library (the classic templates are presets
  in it); their typed forms are unchanged.

## Backward compatibility

Additive everywhere: existing timelines never contain `GRAPHIC`; classic templates, their props,
footprints, transitions and rendering are untouched (all pre-existing tests pass unchanged except
the "model schema mirrors contract" test, which now documents GRAPHIC's model-only `order` key).
No persisted-timeline migration is needed. An old app build reading a timeline with a GRAPHIC
visual would reject that visual (unknown template) — only relevant if a deploy is rolled back
after Chris used the library.

## Renderer / deploy note

The motion package changed (new components, compositions per preset): **the cloud renderer's
snapshot / pre-built Remotion bundle (MOTION_BUNDLE_DIR) needs a rebuild** before graphics render
on the live site. Not done here (no Vercel changes).

## Not verified / gaps

- Real iPhone performance of the edit sheet and a 36-cell graphic in the live Player (Chromium
  emulation at 393×852 only).
- Text fitting in the text family is estimated from a per-character table, not measured.
- Medal colours (podium/ranking) are fixed gold/silver/bronze (don't follow MONO/VIVID).
- Suggestions' role detection is English keyword rules; unusual phrasing falls back to the
  hero-number / kinetic-text suggestions.

## Reversibility

High: GRAPHIC is one additive template; removing the library UI leaves stored graphics renderable;
the prefs table is independent; the agent prompt has `rollback_version: 1.1.0`.
