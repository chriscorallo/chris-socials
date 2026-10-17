# 2026-10-17 — Motion themes + learned motion taste (pending merge into DECISIONS.md)

Owner's question: *"Are the animations ever-evolving and matching the topic being
discussed?"* Before this change: no — every video used one house style (BRAND palette, one
spring vocabulary, gold-metal 3D), and nothing Chris did in the editor fed back into the next
design. This work makes (a) each video's motion coherent with its topic and (b) the Motion
Designer adapt to Chris's edits over time, without turning one edit into a rule.

---

## 2026-10-17 — One pure `resolveMotionStyle(visual, theme)` decides every visual's look

**Decision:** `packages/motion/src/style.ts` (exported from `@chris/motion/pure` and the Node
entry). Input: the visual's palette (`BRAND`/`MONO`/`VIVID`) and the timeline's
`motionTheme` (contract: `MotionThemeSchema`). Output: `{ palette, feel, iconStyle, themeName }`.
- Theme `primary`/`secondary` override BRAND and VIVID accents. **MONO is never recolored** —
  it is a deliberate restraint choice; it still gets the motion feel and icon style.
- Contrast guard at render time: primary is lightened (hue kept) to WCAG 4.5:1 and secondary
  to 3:1 against the glass surface `#12121A`, so a color Chris picks in the editor can never
  make values unreadable.
- `motionTheme: null` ⇒ exactly the previous house style (BRAND + CRISP + GOLD_METAL, the
  original AUTO transition table). Every v1 timeline renders as before (unit-tested).
- `resolveThemedTransition(template, which, value, language)`: explicit enter/exit always win;
  `AUTO` follows the language (CALM never springs in, CINEMATIC defocuses in, PLAYFUL springs).

**Alternatives:** theme logic inside each template (14 copies, drift between preview and
render); a `palette` enum per language (can't express Chris's own colors).
**Reversibility:** high — removing the theme makes everything CRISP/BRAND again.

## 2026-10-17 — Motion languages are physical parameter sets, not new animations

**Decision:** `MOTION_FEELS[CALM|CRISP|PUNCHY|CINEMATIC|PLAYFUL]` = spring configs (settle,
soft, punch, grow, object), out-ease bezier, tempo (stagger multiplier), travel distance,
blur, hit scale, rotation accent, entrance/exit stretch, cinematic push, letterbox depth,
title tracking, glow, 3D spin. All 14 templates multiply their designed values by these; the
container entrance/exit (`enterExitStyle`) takes the feel as an optional last argument.
CRISP is numerically identical to the old constants. **Key "hit" moments (counter landing,
bar peak, word punch) are not re-timed** — only the feel around them — so the interaction
engineer's emphasis-timing hooks compose with this.

Measured springs (30 fps; frames to 90 % / settle / peak):

| language | settle | soft | punch | grow |
|---|---|---|---|---|
| CALM | 16/30/1.00 | 14/27/1.00 | 10/20/1.00 | 16/31/1.00 |
| CRISP | 11/21/1.00 | 8/18/1.02 | 4/15/1.09 | 13/24/1.00 |
| PUNCHY | 5/12/1.07 | 4/20/1.22 | 3/17/1.31 | 5/19/1.10 |
| CINEMATIC | 19/36/1.00 | 17/32/1.00 | 13/24/1.00 | 20/37/1.00 |
| PLAYFUL | 5/21/1.16 | 4/31/1.30 | 3/22/1.33 | 6/30/1.18 |

Quality-loop fixes made after looking at frames (docs/evidence/2026-10-17-motion-themes/):
overshooting word punches no longer squash below 95 % scale; bar/stack overshoot capped at
8 % so the tallest value label never meets the card title; tracked titles (CINEMATIC) only
track when the title is one line and the widest state still fits (no mid-animation re-wrap —
this also fixes a latent re-wrap in the house style's 0.1 em settle on long titles); exits in
defocus-heavy languages are capped (×1.15 blur, ×1.2 length) so graphics don't smear out.

## 2026-10-17 — Icon styles: GOLD_METAL / SOFT_CLAY / GLASS / LINE

**Decision:** `useMaterials(palette, iconStyle)` returns the same material *slots* for every
family, so all 10 ICON_3D models, MONEY_STACK_3D and the depth3d bar chart render in every
family without per-model code. SOFT_CLAY = matte pastel (roughness ~0.8, sheen, softer key,
saturated enough to survive ACES — the first pass washed to white). GLASS = tinted acrylic
with a **fresnel rim shader patch** (onBeforeCompile) — plain transparency read as dull gray
on the dark layer; true transmission is impossible because the alpha layer has no footage
behind it to refract. LINE = 2D line icons (`templates/line-icons.tsx`, original 64-grid
geometry, stroke-by-stroke draw-on on a glass disc), an isometric line-drawn money stack, and
outlined bars for depth3d charts. Footprints are unchanged, so placement is unaffected.

**Known gaps:** glass money stacks are the weakest combination (bills as glass is odd) —
acceptable, the designer rarely pairs them; glass cannot refract the footage (would need
compositing in the ffmpeg graph).

## 2026-10-17 — Topic → theme: the model chooses, a deterministic preset backs it up

**Decision:** Motion Designer output gains a strict, required-nullable `theme`
(`MotionDesignerThemeSchema`). Code then:
1. keeps the timeline's existing theme unless `replaceExisting` (Chris's override is an
   explicit decision — authority order — and is never silently redone) → `themeSource: KEPT`;
2. else uses the model's theme after `sanitizeMotionTheme` (schema, contrast lightening,
   gray/near-white "accents" dropped, primary==secondary separated) → `MODEL`;
3. else the topic preset → `FALLBACK`.
Topic = `classifyMotionTopic` (packages/domain, deterministic keyword scoring over title ×3,
description ×2, script ×1 capped, plus pillar priors; "credit card debt" resolves to DEBT).
Presets (`MOTION_THEME_PRESETS`, all contrast-tested): DEBT "Debt pressure" PUNCHY amber/red;
CREDIT CRISP amber/red; INVESTING "Compounding growth" CINEMATIC gold/emerald GLASS; SAVING
CALM gold/green; CAREER CRISP gold/blue; LIFESTYLE "Golden hour" PLAYFUL sunset SOFT_CLAY;
MINDSET CALM gold/violet LINE; GENERAL = house style. The suggestion is shown to the model,
which may deviate when the tone calls for it (e.g. a hopeful debt-freedom story).
The motion design job saves `motionTheme` on the new timeline version and audit-logs theme +
source. The factual hard rule is untouched (tested again with a theme present).
Prompt `MOTION_DESIGNER` 1.0.0 → **1.1.0** (`rollback_version: 1.0.0`, `required_context` +
`MotionTasteProfile`; AGENT_CONTRACTS row updated). `eval_status` stays `unevaluated` (no
credit for a real run).

## 2026-10-17 — Learning motion taste from editor saves (`TasteFeedback.context`)

**Decision:** additive migration `20261017140000_taste_feedback_context` (`context JSONB`,
nullable; existing rows untouched). `recordTasteFeedback` accepts an optional `context`.
`packages/domain/src/motion-taste.ts`:
- `diffMotionEdits(before, after, {topic, beforeWasAiDesign})` (pure). AI visuals are the
  designer's `mv-N` ids. Tags (event-level interpretations): REJECTED_TEMPLATE,
  ACCEPTED_TEMPLATE (only on the first save after an AI design, so untouched visuals aren't
  re-counted every save), ADJUSTED_TEMPLATE (changes: props/placement/timing/depth/palette/
  transitions/sound), SWAPPED_TEMPLATE, ADDED_TEMPLATE, SHORTER/LONGER_ANIMATIONS (≥ 0.3 s and
  ≥ 15 %), MORE/LESS_BEHIND_HEAD, LESS_SOUND, TOO_BUSY (≥ 2 and ≥ 40 % of AI visuals deleted in
  one save), PREFERS_THEME, FORGET. Raw feedback is auto-written ("Deleted AI bar chart at
  5.4s on a debt video"); structured context holds template, topic, time, 3D flag, changes.
- `recordMotionEditSignals(prisma, {contentItemId, before, after, actorId, planId,
  beforeWasAiDesign})` persists rows (artifactType `MOTION_GRAPHIC`), idempotent per saved
  plan version, audit-logged.
- Capture point: `saveFinishingEditAction` (apps/web edit actions) reads the latest plan
  before saving and calls a best-effort `learnMotionTaste` after — wrapped so learning can
  never fail or block a save.

## 2026-10-17 — Motion taste profile: evidence thresholds, decay, scope, forget

**Decision:** `buildMotionTasteProfile(rows, now)` (pure). Preference keys: AVOID/FAVOR
_TEMPLATE:<T>, PREFERS_3D / AVOIDS_3D, FEWER_VISUALS, SHORTER/LONGER_ANIMATIONS,
MORE_BEHIND_HEAD, LESS_SOUND, THEME:<topic>:<language>, ICON_STYLE:<style>. Each signal
supports some keys and opposes their opposites (adding a bar chart contradicts "avoid bar
charts"). Recency half-life 45 days. **STRONG** only with ≥ 3 supporting signals from ≥ 2
videos and ≥ 70 % weighted consistency; **WEAK** (a hint) at ≥ 60 %; below that it is
dropped. Evidence from a single topic stays **scoped** to that topic; theme-language
preferences are always topic-scoped. "Forget this" writes a FORGET counter-signal; evidence
before it is ignored for that key, later edits can re-teach it, nothing is deleted.
`motionTasteForDesign(profile, topic)` → `{context, capDelta, avoidTemplates}`: the text block
goes in the prompt (STRONG = follow unless the moment needs otherwise; WEAK = never a rule);
the only deterministic levers are STRONG + in-scope: "fewer graphics" lowers the cap by one
(never below 1), and STRONG-avoided templates are the first cut *when something must be cut*
— never banned. The /learnings page shows "Your motion style" (strength, evidence, videos,
scope, confidence, Forget this).

**Alternatives:** feeding raw feedback to the LLM Taste Learner only (non-deterministic,
costs a call, and can't enforce "one instance ≠ rule"); hard-banning disliked templates
(violates spec §7). The LLM Taste Learner still sees MOTION_GRAPHIC rows via the existing
"Refresh taste model" path (a richer, slower second opinion).
**Reversibility:** high — the capture hook is one wrapped call; the profile is derived.

## 2026-10-17 — Evals

`fixtures/evals/motion-designer.json` (4 SYNTHETIC cases: debt theme fits, investing
fallback fits, STRONG taste respected under a tight cap, invented number dropped) run through
the real `designVisualsForTimeline` in the mock self-test; the grader is shown to fail a
PLAYFUL theme on a debt video. `@chris/evals` now depends on `@chris/media` (timeline schema).

---

### INTEGRATION NOTES

1. **Composition props (interaction engineer).** `VisualsLayerProps.motionTheme?:
   MotionTheme | null` is the one prop. My plumbing in `VisualsLayer.tsx` is deliberately
   tiny: wrap the tree in `<MotionThemeProvider theme={motionTheme}>` and, in `VisualItem`,
   `const ms = useVisualMotionStyle(pv.template, v)` → pass `palette: ms.palette, feel:
   ms.feel, iconStyle: ms.iconStyle` to the template and `ms.feel` as the last argument of
   `enterExitStyle`; `enter`/`exit` come from `ms` (language-aware AUTO). If your branch also
   added a `motionTheme` prop, keep one — same name and type. Context/hook live in
   `src/remotion/motion-theme-context.tsx`.
2. **Player / editor preview:** pass `motionTheme: timeline.motionTheme` in
   `VisualsPreview`'s `inputProps` (not done here — player.tsx is yours). Render path:
   `renderVisualsLayer` already forwards `input.timeline.motionTheme` (one-line change in
   `packages/motion/src/render.ts`); the worker passes the timeline through unchanged.
3. **Template props are optional:** `feel?` / `iconStyle?` on `TemplateComponentProps`
   default to CRISP / GOLD_METAL, so templates still render if a caller doesn't pass them.
   Timing hooks (`hitAtFrame`-style) can be added beside them; the feel never moves hits.
4. **Editor theme picker:** use `@chris/motion/pure` → `resolveMotionStyle`, `MOTION_FEELS`,
   `contrastRatio`/`ensureContrast` for swatches; the topic presets for a "suggested" chip are
   `MOTION_THEME_PRESETS` / `fallbackMotionTheme({title, description, pillar})` in
   `@chris/agents` (server-side).
5. **Saving a theme override** from the picker flows through `saveFinishingEditAction`, so
   it is automatically captured as a PREFERS_THEME signal.
6. **No-model path:** when a timeline has `motionTheme: null` (e.g. never designed), it
   renders in the house style. A caller that wants the topic look without a model call can
   set `fallbackMotionTheme(...)` on the timeline.
7. **Quality loop:** `pnpm --filter @chris/motion exec tsx scripts/theme-matrix.ts <outDir>
   [--only=icons,languages,themes]` (real Remotion pipeline, RGBA frames).
8. **Merge note:** the mock Motion Designer responses in tests must now include `theme`
   (required-nullable, strict structured output).
