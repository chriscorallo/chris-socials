import { z } from "zod";
import {
  MOTION_LANGUAGES,
  MOTION_TEMPLATES,
  MotionPropsSchemas,
  SFX_SOUNDS,
  VISUAL_TRANSITIONS,
  TEMPLATE_FOOTPRINTS,
  TimelineVisualSchema,
  solveVisualPlacements,
  timelineCaptionWords,
  timelineDuration,
  type EditTimeline,
  type MeasureText,
  type MotionTemplate,
  type MotionTheme,
  type PlacementWarning,
  type SafeZonePx,
  type SubjectTrack,
  type TimelineVisual,
  type TranscriptWord,
  applyInteractionDefaults,
} from "@chris/media/timeline";
import type { MotionTopicInput } from "@chris/domain";
import type { ModelProvider } from "./model-provider";
import { fallbackMotionTheme, sanitizeMotionTheme } from "./motion-theme";
import { buildSystemPrompt } from "./prompt-context";
import { buildTranscriptPhrases, formatTimestampedTranscript } from "./transcript-timing";

/**
 * Motion Designer — proposes animated explainer graphics (motion-contract.ts templates) for
 * a finished edit, timed to the phrase Chris is saying. /prompts/agents/MOTION_DESIGNER.md.
 *
 * The model decides WHAT to show and WHEN (semantic judgment). Everything checkable is code:
 * - FACTUAL HARD RULE: every number a visual would put on screen must match a number in the
 *   research packet's numeric inputs / FACT statements / calculation notes or the
 *   fact-checked script (formatting variants allowed). A visual with any other number is
 *   dropped and reported in `rejectedVisuals` — never shown. (Spec §5: hard gates are code.)
 * - props validated against the contract's MotionPropsSchemas;
 * - times snapped to word boundaries, clamped to the video, 1.5–5 s, no overlaps, a breath
 *   between graphics; tier cap (RAW <= 2);
 * - placement: AUTO, solved by the deterministic placement engine around Chris.
 */

// ---------------------------------------------------------------------------------------
// Model-facing output schema: an explicit discriminated union over the 14 templates. Every
// field required (nullable instead of optional/default) so it is a strict structured-output
// schema; the contract's MotionPropsSchemas (bounds, defaults) validate afterwards.
// ---------------------------------------------------------------------------------------

const S = z.string();
const N = z.number();

export const MotionDesignerPropsSchemas = {
  KINETIC_TEXT: z.object({ text: S, emphasis: z.array(S), style: z.enum(["PUNCH", "TYPEWRITER", "SLIDE_UP"]) }).strict(),
  NUMBER_COUNTER: z
    .object({ value: N, from: N, prefix: S, suffix: S, decimals: z.number().int(), label: S.nullable() })
    .strict(),
  STAT_CARD: z.object({ value: S, label: S, sublabel: S.nullable(), trend: z.enum(["UP", "DOWN", "NONE"]) }).strict(),
  BAR_CHART: z
    .object({
      title: S.nullable(),
      bars: z.array(z.object({ label: S, value: N }).strict()),
      unit: S,
      highlightIndex: z.number().int().nullable(),
      depth3d: z.boolean(),
    })
    .strict(),
  LINE_CHART: z
    .object({ title: S.nullable(), points: z.array(z.object({ label: S, value: N }).strict()), unit: S, highlightLast: z.boolean() })
    .strict(),
  COMPARISON: z
    .object({
      left: z.object({ label: S, value: S }).strict(),
      right: z.object({ label: S, value: S }).strict(),
      verdict: S.nullable(),
      winner: z.enum(["LEFT", "RIGHT", "NONE"]),
    })
    .strict(),
  PERCENT_RING: z.object({ percent: N, label: S }).strict(),
  LIST_STEPS: z.object({ title: S.nullable(), items: z.array(S), style: z.enum(["NUMBERED", "CHECK"]) }).strict(),
  ICON_3D: z
    .object({
      icon: z.enum(["COIN", "CREDIT_CARD", "HOUSE", "PIGGY_BANK", "CHART_UP", "CALENDAR", "LOCK", "PHONE", "BRIEFCASE", "GRADUATION_CAP"]),
      caption: S.nullable(),
    })
    .strict(),
  MONEY_STACK_3D: z.object({ amount: N, label: S.nullable() }).strict(),
  CALLOUT: z.object({ text: S, pointTo: z.object({ x: N, y: N }).strict() }).strict(),
  TIMELINE: z.object({ events: z.array(z.object({ label: S, sub: S.nullable() }).strict()) }).strict(),
  DEFINITION: z.object({ term: S, definition: S }).strict(),
  TITLE_CARD: z.object({ title: S, subtitle: S.nullable() }).strict(),
} satisfies Record<MotionTemplate, z.ZodTypeAny>;

const commonVisualFields = {
  /** OUTPUT timeline seconds — when the phrase it illustrates starts being spoken. */
  start: N,
  end: N,
  palette: z.enum(["BRAND", "MONO", "VIVID"]),
  enter: z.enum(VISUAL_TRANSITIONS),
  exit: z.enum(VISUAL_TRANSITIONS),
  enterSfx: z.enum(SFX_SOUNDS).nullable(),
  /** The exact transcript phrase this visual illustrates. */
  anchorText: S,
  /** 1 (nice to have) .. 5 (essential to understanding) — used when something must go. */
  importance: z.number().int(),
  /** Why this visual clarifies (not decorates) this moment. */
  rationale: S,
};

function variant<T extends MotionTemplate>(t: T) {
  return z.object({ template: z.literal(t), props: MotionDesignerPropsSchemas[t], ...commonVisualFields }).strict();
}

export const MotionDesignerVisualSchema = z.discriminatedUnion("template", [
  variant("KINETIC_TEXT"),
  variant("NUMBER_COUNTER"),
  variant("STAT_CARD"),
  variant("BAR_CHART"),
  variant("LINE_CHART"),
  variant("COMPARISON"),
  variant("PERCENT_RING"),
  variant("LIST_STEPS"),
  variant("ICON_3D"),
  variant("MONEY_STACK_3D"),
  variant("CALLOUT"),
  variant("TIMELINE"),
  variant("DEFINITION"),
  variant("TITLE_CARD"),
]);
export type MotionDesignerVisual = z.infer<typeof MotionDesignerVisualSchema>;

/** The per-video motion theme the model proposes (validated + contrast-guarded by code). */
export const MotionDesignerThemeSchema = z
  .object({
    name: S,
    motionLanguage: z.enum(MOTION_LANGUAGES),
    /** #RRGGBB or null to keep the brand palette's color. */
    primary: S.nullable(),
    secondary: S.nullable(),
    iconStyle: z.enum(["GOLD_METAL", "SOFT_CLAY", "GLASS", "LINE"]),
    /** One sentence: why this look fits this topic (shown to Chris). */
    rationale: S,
  })
  .strict();

export const MotionDesignerOutputSchema = z
  .object({
    /** Overall approach in 1-3 sentences (shown to Chris). */
    rationale: S,
    /** The video's motion theme (null = keep the suggested/fallback one). */
    theme: MotionDesignerThemeSchema.nullable(),
    visuals: z.array(MotionDesignerVisualSchema),
  })
  .strict();
export type MotionDesignerOutput = z.infer<typeof MotionDesignerOutputSchema>;

// ---------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------

export type ProductionTierName = "RAW" | "FAST" | "MEDIUM" | "HERO";

/** Structural research input (the item's latest ResearchPacket row). */
export interface MotionResearchInput {
  primaryClaim?: string | null;
  numericInputs: Array<{ label: string; value: string; asOfDate?: string | null }>;
  facts?: Array<{ statement: string; type: string }>;
  calculationNotes?: string | null;
}

export interface DesignVisualsInput {
  timeline: EditTimeline;
  /** Word timings per take (MediaAsset.transcriptWords), SOURCE timeline. */
  wordsByAsset: Record<string, TranscriptWord[] | null | undefined>;
  /** Subject tracks per take; when given, AUTO placements are solved around Chris. */
  subjectTracks?: Record<string, SubjectTrack | null | undefined> | null;
  sourceDimensions?: Record<string, { width: number; height: number } | null | undefined>;
  research: MotionResearchInput | null;
  /** The latest Claims-Gate-passed script. */
  script: { spokenScript: string } | null;
  tier: ProductionTierName;
  brandContext: string;
  /** Keep (default) or replace the visuals already on the timeline. */
  replaceExisting?: boolean;
  platformSafe?: SafeZonePx;
  measure?: MeasureText;
  /** What the video is about (ContentItem title/description/pillar) — drives the theme. */
  topic?: Omit<MotionTopicInput, "script"> | null;
  /** Chris's learned motion taste (domain getMotionTasteForDesign). Optional; absent = none. */
  motionTaste?: MotionTasteInput | null;
}

/** The designer's view of the learned taste profile (see packages/domain motion-taste.ts). */
export interface MotionTasteInput {
  /** Compact text block for the prompt (STRONG/WEAK preferences with evidence counts). */
  context: string | null;
  /** -1 when "fewer graphics" is a STRONG, in-scope preference; never below 1 visual. */
  capDelta?: number;
  /** STRONG avoid-preferences: these are cut first when something must go (not banned). */
  avoidTemplates?: string[];
}

export interface RejectedVisual {
  template: string;
  start: number;
  end: number;
  anchorText: string;
  reason: string;
}

export interface DesignVisualsResult {
  /** The timeline's full visuals list after design (kept existing + new), placed. */
  visuals: TimelineVisual[];
  /** Just the new ones. */
  added: TimelineVisual[];
  rejectedVisuals: RejectedVisual[];
  /** Human-readable notes (snapping, trimming, tier cap, placement). */
  warnings: string[];
  placementWarnings: PlacementWarning[];
  rationale: string;
  model: string;
  /** The video's motion theme after design (save it as EditTimeline.motionTheme). */
  motionTheme: MotionTheme;
  /** KEPT = the timeline already had one (Chris's or an earlier design) and it was kept;
   * MODEL = the designer's proposal (sanitized); FALLBACK = topic preset (no usable proposal). */
  themeSource: "KEPT" | "MODEL" | "FALLBACK";
}

/** Max visuals per tier (RAW is restraint by definition). */
export const MOTION_TIER_CAPS: Record<ProductionTierName, number> = { RAW: 2, FAST: 4, MEDIUM: 7, HERO: 9 };
export const MIN_VISUAL_SECONDS = 1.5;
export const MAX_VISUAL_SECONDS = 5;
/** Breathing room between consecutive graphics. */
export const VISUAL_GAP_SECONDS = 0.4;

// ---------------------------------------------------------------------------------------
// Factual rule — deterministic number grounding
// ---------------------------------------------------------------------------------------

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, half: 0.5, twice: 2, double: 2, triple: 3,
};
const SCALE_WORDS: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const SUFFIX_SCALE: Record<string, number> = { k: 1e3, m: 1e6, mm: 1e6, b: 1e9, bn: 1e9, t: 1e12 };

/**
 * Every number written in `text`, normalised: "$24,500" -> 24500, "$24.5K" -> 24500,
 * "1.2 million" -> 1200000, "7%" -> 7, "three" -> 3, "twenty five thousand" -> 25000.
 */
export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?|\.\d+)(?:\s*(k|mm|m|bn|b|t|thousand|million|billion|trillion)(?![a-z]))?/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[1]!.replace(/,/g, "");
    let v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const suf = m[2]?.toLowerCase();
    if (suf) v *= SCALE_WORDS[suf] ?? SUFFIX_SCALE[suf] ?? 1;
    out.push(v);
  }
  // Spelled-out numbers ("three steps", "twenty five thousand dollars").
  const words = text.toLowerCase().replace(/-/g, " ").split(/[^a-z]+/).filter(Boolean);
  let current: number | null = null;
  let prevWord = "";
  const flush = () => {
    if (current !== null) out.push(current);
    current = null;
  };
  for (const w of words) {
    const before = prevWord;
    prevWord = w;
    // A bare scale word after digits ("1.2 million") was already counted by the digit pass;
    // only "a million" / "twenty thousand" style phrases count here.
    if (w in SCALE_WORDS && current === null && before !== "a") continue;
    if (w in SMALL) {
      const n = SMALL[w]!;
      if (w === "hundred") current = (current ?? 1) * 100;
      else if (current !== null && current % 100 >= 20 && current % 10 === 0 && n < 10) current += n;
      else if (current !== null && current >= 100 && n < 100) current += n;
      else {
        flush();
        current = n;
      }
    } else if (w in SCALE_WORDS) {
      current = (current ?? 1) * SCALE_WORDS[w]!;
      flush();
    } else if (w !== "and") flush();
  }
  flush();
  return out;
}

function sigDigits(v: number): number {
  const s = Math.abs(v).toString().replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
  return Math.max(1, s.length);
}

function roundSig(v: number, sig: number): number {
  if (v === 0) return 0;
  const p = Math.pow(10, sig - Math.ceil(Math.log10(Math.abs(v))));
  return Math.round(v * p) / p;
}

/** Whether `shown` is a faithful rendering of one of the grounded numbers (exact, a rounding
 * of it to fewer significant digits, or the same quantity as percent <-> fraction). */
export function numberIsGrounded(shown: number, allowed: number[]): boolean {
  const s = Math.abs(shown);
  const candidates = [s, s * 100, s / 100];
  for (const raw of allowed) {
    const a = Math.abs(raw);
    for (const v of candidates) {
      if (Math.abs(v - a) <= Math.max(1e-9, Math.abs(a) * 1e-6)) return true;
      // A rounding to fewer significant digits ("$24K" for 24,480) — only when it stays
      // within 5% (so "100" can never stand in for 149).
      if (a !== 0 && v !== 0 && Math.abs(roundSig(a, sigDigits(v)) - v) <= Math.abs(v) * 1e-9 && Math.abs(v - a) / a <= 0.05) {
        return true;
      }
    }
  }
  return false;
}

/** The numbers a visual would put on screen, with where they come from. Structural fields
 * (decimals, highlight index, callout coordinates, a counter starting at 0) are not shown
 * numbers and are excluded. */
export function numbersShownBy(template: MotionTemplate, props: Record<string, unknown>): Array<{ value: number; field: string }> {
  const out: Array<{ value: number; field: string }> = [];
  const skip = new Set(["decimals", "highlightIndex", "pointTo", "style", "trend", "winner", "icon", "depth3d", "highlightLast"]);
  const walk = (v: unknown, path: string, key: string) => {
    if (skip.has(key)) return;
    if (typeof v === "number") {
      if (template === "NUMBER_COUNTER" && key === "from" && v === 0) return;
      out.push({ value: v, field: path });
    } else if (typeof v === "string") {
      for (const n of extractNumbers(v)) out.push({ value: n, field: path });
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`, key));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, k);
    }
  };
  walk(props, "", "");
  return out;
}

/** Every number the visuals may show: research numeric inputs (value + label), FACT
 * statements, calculation notes, and the fact-checked script. */
export function groundedNumbers(research: MotionResearchInput | null, script: { spokenScript: string } | null): number[] {
  const texts: string[] = [];
  if (research) {
    for (const n of research.numericInputs) texts.push(n.value, n.label);
    for (const f of research.facts ?? []) if (f.type === "FACT") texts.push(f.statement);
    if (research.calculationNotes) texts.push(research.calculationNotes);
    if (research.primaryClaim) texts.push(research.primaryClaim);
  }
  if (script) texts.push(script.spokenScript);
  return [...new Set(texts.flatMap(extractNumbers))].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------------------

/** Output-timeline words (what's actually heard), independent of caption edits/visibility. */
export function outputTimelineWords(
  timeline: EditTimeline,
  wordsByAsset: Record<string, TranscriptWord[] | null | undefined>,
): TranscriptWord[] {
  return timelineCaptionWords(
    { clips: timeline.clips, captions: { ...timeline.captions, enabled: true, wordEdits: {}, uppercase: false } },
    wordsByAsset,
  ).map((w) => ({ word: w.word, start: w.start, end: w.end }));
}

/**
 * Snap a proposed [start, end] onto speech: start just before the onset of the word being
 * spoken at `start` (or the next word within 0.6 s), end at the end of the word being spoken
 * at `end` (or the previous word), then enforce 1.5–5 s and the video bounds.
 */
export function snapVisualTiming(
  start: number,
  end: number,
  words: TranscriptWord[],
  duration: number,
): { start: number; end: number } {
  const lead = 0.08;
  let s = Math.max(0, Math.min(start, duration));
  let e = Math.max(s, Math.min(end, duration));
  if (words.length > 0) {
    const inside = words.find((w) => s >= w.start && s < w.end);
    const next = words.find((w) => w.start >= s && w.start - s <= 0.6);
    const onset = inside ?? next;
    if (onset) s = Math.max(0, onset.start - lead);
    const insideEnd = words.find((w) => e > w.start && e <= w.end);
    if (insideEnd) e = insideEnd.end;
  }
  if (e - s < MIN_VISUAL_SECONDS) {
    e = s + MIN_VISUAL_SECONDS;
    // Don't disappear mid-word.
    const cut = words.find((w) => e > w.start && e < w.end);
    if (cut) e = cut.end;
  }
  if (e - s > MAX_VISUAL_SECONDS) {
    e = s + MAX_VISUAL_SECONDS;
    const lastWordEnd = [...words].reverse().find((w) => w.end <= e && w.end - s >= MIN_VISUAL_SECONDS);
    if (lastWordEnd) e = lastWordEnd.end;
  }
  if (e > duration) {
    e = duration;
    s = Math.max(0, Math.min(s, e - MIN_VISUAL_SECONDS));
  }
  return { start: round3(s), end: round3(e) };
}

// ---------------------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------------------

const TEMPLATE_GUIDE: Record<MotionTemplate, string> = {
  KINETIC_TEXT: "the punchline / key phrase builds word by word (props: text <=120 chars, emphasis <=4 words, style PUNCH|TYPEWRITER|SLIDE_UP)",
  NUMBER_COUNTER: "ONE big number counts up (value, from, prefix e.g. \"$\", suffix e.g. \"%\" or \"/yr\", decimals 0-2, label)",
  STAT_CARD: "a glass card: big value string (<=16 chars) + label + optional sublabel + trend",
  BAR_CHART: "comparing 2-6 quantities (bars [{label<=16, value}], unit, highlightIndex, depth3d for HERO)",
  LINE_CHART: "growth/decline over time, e.g. compounding (2-12 points [{label<=10, value}], unit, highlightLast)",
  COMPARISON: "A vs B side by side (left/right {label, value string}, verdict, winner)",
  PERCENT_RING: "a single share/percentage 0-100 (percent, label)",
  LIST_STEPS: "2-5 short steps/rules as they're named (items <=48 chars each, NUMBERED|CHECK)",
  ICON_3D: "a concrete object made real: COIN, CREDIT_CARD, HOUSE, PIGGY_BANK, CHART_UP, CALENDAR, LOCK, PHONE, BRIEFCASE, GRADUATION_CAP (+ caption)",
  MONEY_STACK_3D: "an amount of cash made physical (amount, label)",
  CALLOUT: "arrow + label pointing at something visible on screen (text <=40, pointTo canvas fractions) — rarely needed",
  TIMELINE: "2-5 dated/ordered events (label <=16, sub)",
  DEFINITION: "a term Chris defines (term, definition <=140)",
  TITLE_CARD: "cinematic full-frame chapter/hook moment, background dimmed (title, subtitle) — HERO/MEDIUM only, max 1",
};

function researchSection(research: MotionResearchInput | null, allowed: number[]): string {
  if (!research) return "No research packet — this video makes no researched numeric claims. Show NO numbers at all.";
  const numeric = research.numericInputs.map((n) => `- ${n.label}: ${n.value}${n.asOfDate ? ` (as of ${n.asOfDate})` : ""}`).join("\n");
  const facts = (research.facts ?? []).filter((f) => f.type === "FACT").map((f) => `- ${f.statement}`).join("\n");
  return `Primary claim: ${research.primaryClaim ?? "(none)"}
Numeric inputs (fact-checked):
${numeric || "(none)"}
Facts:
${facts || "(none)"}
${research.calculationNotes ? `Calculation notes: ${research.calculationNotes}\n` : ""}
THE ONLY NUMBERS YOU MAY PUT ON SCREEN (any other number — including in labels and text — gets the visual thrown out): ${allowed.length ? allowed.join(", ") : "none"}`;
}

function onScreenSection(timeline: EditTimeline, keep: TimelineVisual[]): string {
  const texts = timeline.texts.map((t) => `- text ${t.start.toFixed(2)}-${t.end.toFixed(2)}s at y=${t.y.toFixed(2)}: "${t.text}"`);
  const vis = keep.map((v) => `- existing ${v.template} ${v.start.toFixed(2)}-${v.end.toFixed(2)}s (${v.placement.mode}) — keep clear of it in time`);
  const caps = timeline.captions.enabled ? `Captions on (block centred at y=${timeline.captions.y.toFixed(2)}).` : "Captions off.";
  return [caps, ...texts, ...vis].join("\n") || "(nothing)";
}

function themeLine(t: MotionTheme): string {
  return `"${t.name}" — motionLanguage ${t.motionLanguage}, iconStyle ${t.iconStyle}, primary ${t.primary ?? "brand gold"}, secondary ${t.secondary ?? "brand violet"}`;
}

function themeSection(input: DesignVisualsInput, suggested: { theme: MotionTheme; topic: string }, kept: MotionTheme | null): string {
  const topic = input.topic;
  const about = topic ? `Title: ${topic.title ?? "(untitled)"}${topic.pillar ? ` · pillar ${topic.pillar}` : ""}${topic.description ? `\nAbout: ${topic.description}` : ""}` : "(no title/pillar given)";
  const choice = kept
    ? `This video already has a theme (keep it; return theme: null): ${themeLine(kept)}`
    : `Deterministic suggestion for topic ${suggested.topic}: ${themeLine(suggested.theme)}. Return your own theme if the script's tone calls for something better, else return this one (or null to accept it).`;
  return `${about}\n${choice}`;
}

function buildUserPrompt(
  input: DesignVisualsInput,
  words: TranscriptWord[],
  allowed: number[],
  keep: TimelineVisual[],
  cap: number,
  theme: { suggested: { theme: MotionTheme; topic: string }; kept: MotionTheme | null },
): string {
  const duration = timelineDuration(input.timeline);
  const phrases = buildTranscriptPhrases(words);
  const transcript = phrases.length
    ? formatTimestampedTranscript(phrases)
    : "(no word timings — you cannot time visuals to speech; return no visuals)";
  const catalogue = MOTION_TEMPLATES.map((t) => `- ${t}: ${TEMPLATE_GUIDE[t]}`).join("\n");
  return `## Video

Production tier: ${input.tier}
Duration: ${duration.toFixed(2)} s (OUTPUT timeline — every time you return is on this timeline)
At most ${cap} new visual(s) for this tier and length${keep.length ? ` (${keep.length} already on the timeline count toward the cap)` : ""}.

## Timestamped transcript (OUTPUT timeline, one spoken phrase per line)

${transcript}

## Fact-checked script

${input.script?.spokenScript ?? "(no gated script available)"}

## Research

${researchSection(input.research, allowed)}

## Topic and motion theme

${themeSection(input, theme.suggested, theme.kept)}

## Chris's motion taste (learned from his edits)

${input.motionTaste?.context ?? "Nothing learned yet — use your judgment."}

## Already on screen

${onScreenSection(input.timeline, keep)}

## Templates

${catalogue}

## Task

Design the motion graphics for this video per your instructions. Time each visual to the
phrase it illustrates (start as the key word is spoken), 1.5–5 s each, never overlapping each
other or the existing ones, with space between them. Placement on screen is automatic (the
engine keeps graphics off Chris's face, the captions and platform UI) — choose only template,
props, timing, palette, enter/exit, enterSfx — and the video's motion theme. Fewer, better.
An empty list is a valid answer.`;
}

// ---------------------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------------------

export function tierCap(tier: ProductionTierName, durationSeconds: number): number {
  // Density ceiling: about one graphic per 6 s of video, never more than the tier allows.
  return Math.max(1, Math.min(MOTION_TIER_CAPS[tier], Math.floor(durationSeconds / 6) || 1));
}

function rejection(v: MotionDesignerVisual, reason: string): RejectedVisual {
  return { template: v.template, start: v.start, end: v.end, anchorText: v.anchorText, reason };
}

/**
 * Runs the Motion Designer and turns its proposal into contract-valid, factually grounded,
 * well-timed, placed TimelineVisuals. Pure apart from the one model call.
 */
export async function designVisualsForTimeline(
  provider: ModelProvider,
  input: DesignVisualsInput,
): Promise<DesignVisualsResult> {
  const { timeline } = input;
  const duration = timelineDuration(timeline);
  const words = outputTimelineWords(timeline, input.wordsByAsset);
  const allowed = groundedNumbers(input.research, input.script);
  const keep = input.replaceExisting ? [] : timeline.visuals;
  // Learned taste may lower the ceiling by one (STRONG "fewer graphics" only) — never raise it.
  const tasteDelta = Math.min(0, Math.round(input.motionTaste?.capDelta ?? 0));
  const cap = Math.max(0, Math.max(Math.min(1, tierCap(input.tier, duration)), tierCap(input.tier, duration) + tasteDelta) - keep.length);
  const avoid = new Set(input.motionTaste?.avoidTemplates ?? []);

  // Theme: an existing one is kept unless the design replaces everything (Chris's override
  // or an earlier design is an explicit decision, not something to silently redo).
  const suggested = fallbackMotionTheme({ ...(input.topic ?? {}), script: input.script?.spokenScript ?? null });
  const kept = !input.replaceExisting && timeline.motionTheme ? timeline.motionTheme : null;

  const { systemPrompt, modelClass } = buildSystemPrompt("MOTION_DESIGNER");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext,
    userPrompt: buildUserPrompt(input, words, allowed, keep, cap, { suggested, kept }),
    schema: MotionDesignerOutputSchema,
    promptId: "MOTION_DESIGNER",
  });

  const warnings: string[] = [];
  let motionTheme: MotionTheme;
  let themeSource: DesignVisualsResult["themeSource"];
  if (kept) {
    motionTheme = kept;
    themeSource = "KEPT";
  } else {
    const proposed = result.output.theme ? sanitizeMotionTheme(result.output.theme) : null;
    if (proposed) {
      motionTheme = proposed.theme;
      themeSource = "MODEL";
      warnings.push(...proposed.notes);
    } else {
      if (result.output.theme) warnings.push("The proposed motion theme was invalid — used the topic preset instead.");
      motionTheme = suggested.theme;
      themeSource = "FALLBACK";
    }
  }
  const rejected: RejectedVisual[] = [];
  type Accepted = { v: MotionDesignerVisual; props: Record<string, unknown>; start: number; end: number };
  const accepted: Accepted[] = [];
  let titleCards = keep.filter((v) => v.template === "TITLE_CARD").length;

  for (const v of result.output.visuals) {
    // 1. Contract validation of props (bounds, array sizes).
    const parsed = MotionPropsSchemas[v.template].safeParse(v.props);
    if (!parsed.success) {
      rejected.push(rejection(v, `props don't fit the ${v.template} template: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`));
      continue;
    }
    // 2. FACTUAL HARD RULE.
    const ungrounded = numbersShownBy(v.template, parsed.data as Record<string, unknown>).filter((n) => !numberIsGrounded(n.value, allowed));
    if (ungrounded.length > 0) {
      rejected.push(
        rejection(v, `FACTUAL: ${ungrounded.map((n) => `${n.value} (${n.field || "value"})`).join(", ")} not found in the research numeric inputs or the fact-checked script`),
      );
      continue;
    }
    // 3. Tier restraint on cinematic moments.
    if (v.template === "TITLE_CARD" && (input.tier === "RAW" || input.tier === "FAST" || titleCards >= 1)) {
      rejected.push(rejection(v, input.tier === "RAW" || input.tier === "FAST" ? `TITLE_CARD isn't used at ${input.tier} tier` : "only one TITLE_CARD per video"));
      continue;
    }
    if (v.template === "TITLE_CARD") titleCards++;
    // 4. Timing.
    if (v.start >= duration) {
      rejected.push(rejection(v, `starts at ${v.start}s, after the video ends (${duration.toFixed(2)}s)`));
      continue;
    }
    const t = snapVisualTiming(v.start, Math.max(v.end, v.start), words, duration);
    if (Math.abs(t.start - v.start) > 0.05 || Math.abs(t.end - v.end) > 0.05) {
      warnings.push(`${v.template} "${v.anchorText.slice(0, 40)}": ${v.start.toFixed(2)}-${v.end.toFixed(2)}s snapped to ${t.start.toFixed(2)}-${t.end.toFixed(2)}s`);
    }
    accepted.push({ v, props: parsed.data as Record<string, unknown>, start: t.start, end: t.end });
  }

  // 5. Overlaps (with each other and with kept visuals): trim the earlier one to leave a gap,
  //    else drop the less important one.
  accepted.sort((a, b) => a.start - b.start || b.v.importance - a.v.importance);
  const finalList: Accepted[] = [];
  const blocks = keep.map((k) => ({ start: k.start, end: k.end }));
  const collides = (a: { start: number; end: number }, b: { start: number; end: number }) =>
    a.start < b.end + VISUAL_GAP_SECONDS && b.start < a.end + VISUAL_GAP_SECONDS;
  for (const cand of accepted) {
    const keptHit = blocks.find((b) => collides(cand, b));
    if (keptHit) {
      // Try starting after the kept visual, still on this phrase.
      const shifted = { start: keptHit.end + VISUAL_GAP_SECONDS, end: cand.end };
      if (shifted.end - shifted.start >= MIN_VISUAL_SECONDS && !blocks.some((b) => b !== keptHit && collides(shifted, b))) {
        cand.start = round3(shifted.start);
      } else {
        rejected.push(rejection(cand.v, "overlaps a graphic already on the timeline"));
        continue;
      }
    }
    const prev = finalList[finalList.length - 1];
    if (prev && collides(prev, cand)) {
      const trimmedEnd = round3(cand.start - VISUAL_GAP_SECONDS);
      if (trimmedEnd - prev.start >= MIN_VISUAL_SECONDS) {
        warnings.push(`${prev.v.template} trimmed to end at ${trimmedEnd.toFixed(2)}s to make room for ${cand.v.template}`);
        prev.end = trimmedEnd;
      } else if (cand.v.importance > prev.v.importance) {
        finalList.pop();
        rejected.push(rejection(prev.v, `overlapped a more important ${cand.v.template}`));
        const before = finalList[finalList.length - 1];
        if (before && collides(before, cand)) {
          rejected.push(rejection(cand.v, `overlaps ${before.v.template}`));
          continue;
        }
      } else {
        rejected.push(rejection(cand.v, `overlaps ${prev.v.template}`));
        continue;
      }
    }
    finalList.push(cand);
  }

  // 6. Tier cap: keep the most important (earlier wins ties).
  let chosen = finalList;
  if (finalList.length > cap) {
    // Templates Chris consistently deletes (STRONG, learned) are the first to go — not banned.
    const rank = (a: Accepted) => a.v.importance - (avoid.has(a.v.template) ? 1.5 : 0);
    const ranked = [...finalList].sort((a, b) => rank(b) - rank(a) || a.start - b.start);
    const keepSet = new Set(ranked.slice(0, cap));
    for (const a of finalList)
      if (!keepSet.has(a)) rejected.push(rejection(a.v, `over the ${input.tier} tier's limit of ${cap} new visual(s)${tasteDelta ? " (one fewer: Chris's learned preference)" : ""}${avoid.has(a.v.template) ? ` — ${a.v.template} is one Chris usually deletes` : ""}`));
    chosen = finalList.filter((a) => keepSet.has(a));
  }

  // 7. Contract TimelineVisuals with deterministic ids + AUTO placement defaults.
  const used = new Set(keep.map((k) => k.id));
  let n = 1;
  const nextId = () => {
    while (used.has(`mv-${n}`)) n++;
    used.add(`mv-${n}`);
    return `mv-${n}`;
  };
  // AI-designed visuals get the same veteran defaults as hand-added ones (ride punch-ins,
  // shadows + scene match, light wrap on 3D) — see packages/media visual-interaction.ts.
  const added = chosen.map((a) =>
    applyInteractionDefaults(TimelineVisualSchema.parse({
      id: nextId(),
      template: a.v.template,
      props: a.props,
      start: a.start,
      end: a.end,
      placement: { mode: "AUTO", x: 0.5, y: TEMPLATE_FOOTPRINTS[a.v.template].preferY, scale: 1 },
      palette: a.v.palette,
      enter: a.v.enter,
      exit: a.v.exit,
      enterSfx: a.v.enterSfx,
      anchorText: a.v.anchorText.slice(0, 200),
    })),
  );

  let visuals = [...keep, ...added].sort((a, b) => a.start - b.start);
  let placementWarnings: PlacementWarning[] = [];
  if (input.subjectTracks) {
    const solved = solveVisualPlacements(
      { ...timeline, visuals },
      {
        subjectTracks: input.subjectTracks,
        sourceDimensions: input.sourceDimensions,
        platformSafe: input.platformSafe,
        measure: input.measure,
        wordsByAsset: input.wordsByAsset,
      },
    );
    visuals = solved.visuals;
    placementWarnings = solved.warnings;
  } else {
    warnings.push("No subject tracks provided — placements left at template defaults (AUTO; the placement engine will solve them).");
  }
  const addedIds = new Set(added.map((a) => a.id));

  return {
    visuals,
    added: visuals.filter((v) => addedIds.has(v.id)),
    rejectedVisuals: rejected,
    warnings,
    placementWarnings,
    rationale: result.output.rationale,
    model: result.model,
    motionTheme,
    themeSource,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
