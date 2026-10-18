import {
  MotionPropsSchemas,
  MOTION_TEMPLATES,
  timelineDuration,
  type MotionTemplate,
  type PlacementWarning,
  type TimelineCaptionWord,
  type TimelineMusic,
  type TimelineSfx,
  type SfxSound,
  type TimelineVisual,
  type MotionTheme,
  MotionThemeSchema,
  GraphicPropsSchema,
  graphicSummary,
  presetById,
  VISUAL_INTERACTION_DEFAULTS,
  applyInteractionDefaults,
} from "@chris/media/timeline";
import { SAMPLE_PLACEMENT, SAMPLE_PROPS } from "@chris/motion/pure";
import { newId } from "./timeline-ops";
import { PLATFORM_IDS } from "./platform-profiles";
import type { PlatformWarning } from "./platform-warnings";
import type { EditorDoc } from "./types";

/**
 * Motion graphics, sound effects and music in the finishing editor — PURE document operations
 * and template metadata (no React). Everything returns a NEW doc, like timeline-ops.ts, so
 * every change is one undo step through the reducer.
 *
 * Overlap rule: visuals live on ONE track and never overlap in time. The placement engine
 * (packages/media visual-placement.ts) treats other on-screen visuals as hard obstacles and the
 * Motion Designer keeps >= 0.4 s between graphics, so the editor follows the same rule: an
 * insert lands in the free gap at the playhead, a move or trim stops at its neighbours
 * (CapCut's same-lane behaviour). A ripple edit that shrinks the video can still squeeze two
 * together — `overlappingVisuals` reports that as a warning instead of silently moving them.
 */

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Shortest a graphic may be: its entrance (0.7 s) + exit (0.45 s) need room to play. */
export const VISUAL_MIN_SECONDS = 1.2;
export const VISUAL_DEFAULT_SECONDS = 3;

export const TEMPLATE_LABEL: Record<MotionTemplate, string> = {
  KINETIC_TEXT: "Kinetic text",
  NUMBER_COUNTER: "Counter",
  STAT_CARD: "Stat card",
  BAR_CHART: "Bar chart",
  LINE_CHART: "Line chart",
  COMPARISON: "Comparison",
  PERCENT_RING: "Percent ring",
  LIST_STEPS: "List",
  ICON_3D: "3D icon",
  MONEY_STACK_3D: "Money stack",
  CALLOUT: "Callout",
  TIMELINE: "Timeline",
  DEFINITION: "Definition",
  TITLE_CARD: "Title card",
  GRAPHIC: "Graphic",
};

export const TEMPLATE_BLURB: Record<MotionTemplate, string> = {
  KINETIC_TEXT: "Your words, punched in",
  NUMBER_COUNTER: "A number that counts up",
  STAT_CARD: "One big stat, glass card",
  BAR_CHART: "Compare amounts",
  LINE_CHART: "Growth over time",
  COMPARISON: "This vs that",
  PERCENT_RING: "A share of the whole",
  LIST_STEPS: "Steps or a checklist",
  ICON_3D: "A 3D object",
  MONEY_STACK_3D: "Stacks of cash",
  CALLOUT: "Point at something",
  TIMELINE: "Milestones",
  DEFINITION: "Explain a term",
  TITLE_CARD: "Chapter title",
  GRAPHIC: "From the graphics library",
};

export const ICON_3D_LABEL: Record<string, string> = {
  COIN: "Coin",
  CREDIT_CARD: "Credit card",
  HOUSE: "House",
  PIGGY_BANK: "Piggy bank",
  CHART_UP: "Chart up",
  CALENDAR: "Calendar",
  LOCK: "Lock",
  PHONE: "Phone",
  BRIEFCASE: "Briefcase",
  GRADUATION_CAP: "Grad cap",
};

export const SFX_LABEL: Record<SfxSound, string> = {
  WHOOSH: "Whoosh",
  SWOOSH_UP: "Swoosh up",
  SOFT_POP: "Soft pop",
  CLICK: "Click",
  TICK: "Tick",
  RISER: "Riser",
  IMPACT: "Impact",
  SHIMMER: "Shimmer",
  CASH: "Cash register",
};

/** `/api/sfx/<file>` — same names as packages/motion/assets/sfx. */
export function sfxUrl(sound: SfxSound): string {
  return `/api/sfx/${sound.toLowerCase()}.wav`;
}

// ---------------------------------------------------------------------------------------
// Props editor spec (one hand-written spec per template; a test checks it mirrors the
// contract's MotionPropsSchemas key for key)
// ---------------------------------------------------------------------------------------

export type FieldSpec =
  | { key: string; label: string; kind: "text"; max: number; nullable?: boolean; optional?: boolean; multiline?: boolean; placeholder?: string }
  | { key: string; label: string; kind: "number"; min?: number; max?: number; step?: number; int?: boolean }
  | { key: string; label: string; kind: "enum"; options: Array<[string | number, string]> }
  | { key: string; label: string; kind: "bool" }
  | { key: string; label: string; kind: "tags"; maxItems: number; itemMax: number }
  | { key: string; label: string; kind: "stringList"; minItems: number; maxItems: number; itemMax: number; itemLabel: string }
  | { key: string; label: string; kind: "objectList"; minItems: number; maxItems: number; itemLabel: string; fields: FieldSpec[]; blank: () => Record<string, unknown> }
  | { key: string; label: string; kind: "object"; fields: FieldSpec[] }
  | { key: string; label: string; kind: "point" }
  /** Nullable index into a sibling list (e.g. which bar is highlighted). */
  | { key: string; label: string; kind: "index"; of: string; itemKey: string }
  /** Edited by a dedicated editor (GRAPHIC: GraphicEditor.tsx) — the generic form skips it. */
  | { key: string; label: string; kind: "custom" };

const TITLE: FieldSpec = { key: "title", label: "Title", kind: "text", max: 60, nullable: true, placeholder: "Optional" };
const UNIT: FieldSpec = { key: "unit", label: "Unit", kind: "text", max: 6, optional: true, placeholder: "$, %, …" };

export const TEMPLATE_FIELDS: Record<MotionTemplate, FieldSpec[]> = {
  KINETIC_TEXT: [
    { key: "text", label: "Text", kind: "text", max: 120, multiline: true },
    { key: "emphasis", label: "Words that hit harder", kind: "tags", maxItems: 4, itemMax: 30 },
    { key: "style", label: "Style", kind: "enum", options: [["PUNCH", "Punch"], ["TYPEWRITER", "Typewriter"], ["SLIDE_UP", "Slide up"]] },
  ],
  NUMBER_COUNTER: [
    { key: "value", label: "Number", kind: "number" },
    { key: "from", label: "Counts from", kind: "number" },
    { key: "prefix", label: "Before", kind: "text", max: 4, optional: true, placeholder: "$" },
    { key: "suffix", label: "After", kind: "text", max: 6, optional: true, placeholder: "%, /mo" },
    { key: "decimals", label: "Decimals", kind: "enum", options: [[0, "0"], [1, "0.0"], [2, "0.00"]] },
    { key: "label", label: "Label", kind: "text", max: 60, nullable: true, placeholder: "Optional" },
  ],
  STAT_CARD: [
    { key: "value", label: "Big value", kind: "text", max: 16 },
    { key: "label", label: "Label", kind: "text", max: 60 },
    { key: "sublabel", label: "Small print", kind: "text", max: 60, nullable: true, placeholder: "Optional" },
    { key: "trend", label: "Trend", kind: "enum", options: [["UP", "Up"], ["DOWN", "Down"], ["NONE", "None"]] },
  ],
  BAR_CHART: [
    TITLE,
    {
      key: "bars",
      label: "Bars",
      kind: "objectList",
      minItems: 2,
      maxItems: 6,
      itemLabel: "Bar",
      fields: [
        { key: "label", label: "Label", kind: "text", max: 16 },
        { key: "value", label: "Value", kind: "number" },
      ],
      blank: () => ({ label: "New", value: 1 }),
    },
    UNIT,
    { key: "highlightIndex", label: "Highlight", kind: "index", of: "bars", itemKey: "label" },
    { key: "depth3d", label: "3D bars", kind: "bool" },
  ],
  LINE_CHART: [
    TITLE,
    {
      key: "points",
      label: "Points",
      kind: "objectList",
      minItems: 2,
      maxItems: 12,
      itemLabel: "Point",
      fields: [
        { key: "label", label: "Label", kind: "text", max: 10 },
        { key: "value", label: "Value", kind: "number" },
      ],
      blank: () => ({ label: "Next", value: 1 }),
    },
    UNIT,
    { key: "highlightLast", label: "Highlight the last point", kind: "bool" },
  ],
  COMPARISON: [
    { key: "left", label: "Left", kind: "object", fields: [{ key: "label", label: "Label", kind: "text", max: 60 }, { key: "value", label: "Value", kind: "text", max: 16 }] },
    { key: "right", label: "Right", kind: "object", fields: [{ key: "label", label: "Label", kind: "text", max: 60 }, { key: "value", label: "Value", kind: "text", max: 16 }] },
    { key: "verdict", label: "Verdict", kind: "text", max: 60, nullable: true, placeholder: "Optional" },
    { key: "winner", label: "Winner", kind: "enum", options: [["LEFT", "Left"], ["RIGHT", "Right"], ["NONE", "Neither"]] },
  ],
  PERCENT_RING: [
    { key: "percent", label: "Percent", kind: "number", min: 0, max: 100 },
    { key: "label", label: "Label", kind: "text", max: 60 },
  ],
  LIST_STEPS: [
    TITLE,
    { key: "items", label: "Items", kind: "stringList", minItems: 2, maxItems: 5, itemMax: 48, itemLabel: "Item" },
    { key: "style", label: "Style", kind: "enum", options: [["NUMBERED", "1 2 3"], ["CHECK", "Checks"]] },
  ],
  ICON_3D: [
    { key: "icon", label: "Object", kind: "enum", options: Object.entries(ICON_3D_LABEL) },
    { key: "caption", label: "Caption", kind: "text", max: 60, nullable: true, placeholder: "Optional" },
  ],
  MONEY_STACK_3D: [
    { key: "amount", label: "Amount ($)", kind: "number", min: 1 },
    { key: "label", label: "Label", kind: "text", max: 60, nullable: true, placeholder: "Optional" },
  ],
  CALLOUT: [
    { key: "text", label: "Text", kind: "text", max: 40 },
    { key: "pointTo", label: "Points at", kind: "point" },
  ],
  TIMELINE: [
    {
      key: "events",
      label: "Milestones",
      kind: "objectList",
      minItems: 2,
      maxItems: 5,
      itemLabel: "Milestone",
      fields: [
        { key: "label", label: "Label", kind: "text", max: 16 },
        { key: "sub", label: "Detail", kind: "text", max: 40, nullable: true, placeholder: "Optional" },
      ],
      blank: () => ({ label: "Next", sub: null }),
    },
  ],
  DEFINITION: [
    { key: "term", label: "Term", kind: "text", max: 60 },
    { key: "definition", label: "Meaning", kind: "text", max: 140, multiline: true },
  ],
  TITLE_CARD: [
    { key: "title", label: "Title", kind: "text", max: 120 },
    { key: "subtitle", label: "Subtitle", kind: "text", max: 60, nullable: true, placeholder: "Optional" },
  ],
  // Composable graphics have their own editor (data table, quick entry, format, animation).
  GRAPHIC: ["component", "variant", "preset", "title", "subtitle", "body", "series", "categories", "items", "highlight", "showTotal", "range", "format", "animation", "screen"].map(
    (key) => ({ key, label: key, kind: "custom" as const }),
  ),
};

/** Whether a field puts a number on screen (for the "not fact-checked yet" note). */
export function fieldShowsNumber(spec: FieldSpec): boolean {
  if (spec.kind === "number") return spec.key !== "from";
  return false;
}

// ---------------------------------------------------------------------------------------
// Validation, labels, warnings
// ---------------------------------------------------------------------------------------

/** First problem with a visual's props (null = renders fine). Worded for Chris. */
export function visualPropsProblem(v: Pick<TimelineVisual, "template" | "props">): string | null {
  const r = MotionPropsSchemas[v.template].safeParse(v.props);
  if (r.success) return null;
  const issue = r.error.issues[0];
  if (!issue) return "Something in this graphic isn't filled in.";
  const path = issue.path.map((p) => (typeof p === "number" ? `#${p + 1}` : String(p))).join(" ");
  const tooSmall = issue.code === "too_small";
  const tooBig = issue.code === "too_big";
  const what = path || "A field";
  if (tooSmall && (issue as { origin?: string }).origin === "string") return `${what} can't be empty.`;
  if (tooSmall) return `${what} needs more entries.`;
  if (tooBig && (issue as { origin?: string }).origin === "string") return `${what} is too long.`;
  if (tooBig) return `${what} is too big.`;
  return `${what}: ${issue.message}`;
}

function fmtNum(n: unknown): string {
  return typeof n === "number" ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(n ?? "");
}
function short(s: unknown, n = 22): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Track label: template name + a short summary of what it shows. */
export function visualSummary(v: Pick<TimelineVisual, "template" | "props">): string {
  if (v.template === "GRAPHIC") {
    const g = GraphicPropsSchema.safeParse(v.props);
    return g.success ? graphicSummary(g.data, presetById(g.data.preset)?.name ?? null) : TEMPLATE_LABEL.GRAPHIC;
  }
  const p = v.props as Record<string, unknown>;
  const name = TEMPLATE_LABEL[v.template];
  let detail = "";
  switch (v.template) {
    case "KINETIC_TEXT":
    case "TITLE_CARD":
      detail = short(v.template === "KINETIC_TEXT" ? p.text : p.title);
      break;
    case "CALLOUT":
      detail = short(p.text);
      break;
    case "NUMBER_COUNTER":
      detail = `${p.prefix ?? ""}${fmtNum(p.value)}${p.suffix ?? ""}`;
      break;
    case "STAT_CARD":
      detail = short(p.value, 16);
      break;
    case "MONEY_STACK_3D":
      detail = `$${fmtNum(p.amount)}`;
      break;
    case "PERCENT_RING":
      detail = `${fmtNum(p.percent)}%`;
      break;
    case "BAR_CHART":
      detail = `${Array.isArray(p.bars) ? p.bars.length : 0} bars${p.depth3d ? " · 3D" : ""}`;
      break;
    case "LINE_CHART":
      detail = `${Array.isArray(p.points) ? p.points.length : 0} points`;
      break;
    case "LIST_STEPS":
      detail = `${Array.isArray(p.items) ? p.items.length : 0} items`;
      break;
    case "TIMELINE":
      detail = `${Array.isArray(p.events) ? p.events.length : 0} milestones`;
      break;
    case "COMPARISON": {
      const l = p.left as { label?: string } | undefined;
      const r = p.right as { label?: string } | undefined;
      detail = `${short(l?.label, 10)} vs ${short(r?.label, 10)}`;
      break;
    }
    case "ICON_3D":
      detail = ICON_3D_LABEL[String(p.icon)] ?? "";
      break;
    case "DEFINITION":
      detail = short(p.term);
      break;
  }
  return detail ? `${name} · ${detail}` : name;
}

/** Pairs of visuals that overlap in time (only possible after a ripple edit squeezed them). */
export function overlappingVisuals(visuals: TimelineVisual[]): Array<[string, string]> {
  const s = [...visuals].sort((a, b) => a.start - b.start);
  const out: Array<[string, string]> = [];
  for (let i = 1; i < s.length; i++) if (s[i]!.start < s[i - 1]!.end - 1e-6) out.push([s[i - 1]!.id, s[i]!.id]);
  return out;
}

const span = (v: Pick<TimelineVisual, "start" | "end">) => `${v.start.toFixed(1)}–${v.end.toFixed(1)}s`;

/**
 * The editor's warnings for graphics, in the platform warnings list's shape (so they show in
 * the same chip/sheet): placement engine warnings (reworded: "Bar chart 2.1–4.0s covers
 * Chris's face…"), props that won't render, and overlaps.
 */
export function visualWarnings(doc: EditorDoc, placement: PlacementWarning[]): PlatformWarning[] {
  const byId = new Map(doc.visuals.map((v) => [v.id, v]));
  const out: PlatformWarning[] = [];
  for (const w of placement) {
    if (w.severity !== "WARNING" && w.code !== "MANUAL_OUTSIDE_SAFE_ZONE") continue;
    const v = byId.get(w.visualId);
    if (!v) continue;
    // The engine's message starts with "<template> at 2.1s"; lead with the editor's name + span.
    const rest = w.message.replace(/^[a-z0-9 ]+ at \d+(\.\d+)?s:?\s*/i, "");
    out.push({ id: `visual:${w.code}:${v.id}`, platforms: [...PLATFORM_IDS], message: `${TEMPLATE_LABEL[v.template]} ${span(v)} ${rest}`, target: { kind: "visual", id: v.id } });
  }
  for (const v of doc.visuals) {
    const problem = visualPropsProblem(v);
    if (problem) out.push({ id: `visual:props:${v.id}`, platforms: [...PLATFORM_IDS], message: `${TEMPLATE_LABEL[v.template]} ${span(v)} won't render: ${problem}`, target: { kind: "visual", id: v.id } });
  }
  for (const [a, b] of overlappingVisuals(doc.visuals)) {
    const va = byId.get(a)!;
    const vb = byId.get(b)!;
    out.push({
      id: `visual:overlap:${a}:${b}`,
      platforms: [...PLATFORM_IDS],
      message: `${TEMPLATE_LABEL[va.template]} and ${TEMPLATE_LABEL[vb.template]} overlap in time (${vb.start.toFixed(1)}–${Math.min(va.end, vb.end).toFixed(1)}s) — trim one.`,
      target: { kind: "visual", id: b },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Defaults (prefilled from what's being said under the playhead)
// ---------------------------------------------------------------------------------------

/** The spoken phrase around output time `t` (what the captions show), up to ~10 words. */
export function phraseAt(words: Pick<TimelineCaptionWord, "word" | "start" | "end">[], t: number, maxWords = 10): string {
  if (!words.length) return "";
  let i = words.findIndex((w) => w.end > t);
  if (i < 0) i = words.length - 1;
  // start at the beginning of the sentence-ish run (a gap > 0.6 s or punctuation before)
  let s = i;
  while (s > 0 && i - s < 4 && words[s]!.start - words[s - 1]!.end < 0.6 && !/[.!?]$/.test(words[s - 1]!.word)) s--;
  const out: string[] = [];
  for (let k = s; k < words.length && out.length < maxWords; k++) {
    if (k > s && words[k]!.start - words[k - 1]!.end > 0.6) break;
    out.push(words[k]!.word);
    if (/[.!?]$/.test(words[k]!.word) && k >= i) break;
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const c = s.slice(0, max);
  const sp = c.lastIndexOf(" ");
  return (sp > max * 0.5 ? c.slice(0, sp) : c).replace(/[,;:]$/, "");
}

/** First number written in a phrase ("$24,500" -> 24500, "7%" -> 7), or null. */
export function firstNumber(phrase: string): { value: number; prefix: string; suffix: string } | null {
  const m = /(\$)?(\d[\d,]*(?:\.\d+)?)\s*(%|k\b|K\b)?/.exec(phrase);
  if (!m) return null;
  let value = Number(m[2]!.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  if (m[3] === "k" || m[3] === "K") value *= 1000;
  return { value, prefix: m[1] ? "$" : "", suffix: m[3] === "%" ? "%" : "" };
}

/**
 * Props for a freshly inserted template: the template's designed sample, with the words /
 * number under the playhead dropped in where they fit. Numbers taken from the sample are a
 * placeholder Chris edits; the Quality Gate refuses any on-screen number that isn't in the
 * fact-checked research or script.
 */
export function defaultVisualProps(template: MotionTemplate, phrase: string): Record<string, unknown> {
  const base = structuredClone(SAMPLE_PROPS[template]) as Record<string, unknown>;
  const text = phrase.replace(/[“”"]/g, "").trim();
  const num = firstNumber(text);
  switch (template) {
    case "KINETIC_TEXT":
      if (text) return { text: cut(text, 120), emphasis: [], style: "PUNCH" };
      break;
    case "TITLE_CARD":
      if (text) return { title: cut(text, 120), subtitle: null };
      break;
    case "CALLOUT":
      if (text) return { ...base, text: cut(text, 40) };
      break;
    case "NUMBER_COUNTER":
      if (num) return { value: num.value, from: 0, prefix: num.prefix, suffix: num.suffix, decimals: Number.isInteger(num.value) ? 0 : 1, label: null };
      break;
    case "STAT_CARD":
      if (num) return { ...base, value: cut(`${num.prefix}${num.value.toLocaleString("en-US")}${num.suffix}`, 16), sublabel: null, trend: "NONE" };
      break;
    case "PERCENT_RING":
      if (num && num.suffix === "%" && num.value <= 100) return { ...base, percent: num.value };
      break;
    case "MONEY_STACK_3D":
      if (num && num.prefix === "$" && num.value > 0) return { ...base, amount: num.value };
      break;
  }
  return base;
}

// ---------------------------------------------------------------------------------------
// Visual ops
// ---------------------------------------------------------------------------------------

function sorted(visuals: TimelineVisual[], exceptId?: string): TimelineVisual[] {
  return visuals.filter((v) => v.id !== exceptId).sort((a, b) => a.start - b.start);
}

/**
 * Where a new graphic of `length` seconds can go near output time `t`: inside the free gap
 * under the playhead (shortened to fit, but never below VISUAL_MIN_SECONDS), else the next free
 * gap after it, else the nearest one before it. null = no room anywhere.
 */
export function freeSlotAt(visuals: TimelineVisual[], t: number, duration: number, length = VISUAL_DEFAULT_SECONDS): { start: number; end: number } | null {
  const s = sorted(visuals);
  const gaps: Array<{ a: number; b: number }> = [];
  let cursor = 0;
  for (const v of s) {
    if (v.start > cursor) gaps.push({ a: cursor, b: Math.min(v.start, duration) });
    cursor = Math.max(cursor, v.end);
  }
  if (cursor < duration) gaps.push({ a: cursor, b: duration });
  const fits = gaps.filter((g) => g.b - g.a >= VISUAL_MIN_SECONDS - 1e-6);
  const place = (g: { a: number; b: number }, from: number) => {
    const start = clamp(from, g.a, g.b - VISUAL_MIN_SECONDS);
    return { start: r3(start), end: r3(Math.min(g.b, start + length)) };
  };
  const here = fits.find((g) => t >= g.a - 1e-6 && t < g.b);
  if (here) return place(here, t);
  const after = fits.find((g) => g.a >= t);
  if (after) return place(after, after.a);
  const before = [...fits].reverse().find((g) => g.b <= t);
  if (before) return place(before, Math.max(before.a, before.b - length));
  return null;
}

export function addVisual(
  doc: EditorDoc,
  template: MotionTemplate,
  at: number,
  props: Record<string, unknown>,
  id: string = newId("vis"),
  anchorText: string | null = null,
): { doc: EditorDoc; id: string | null } {
  const slot = freeSlotAt(doc.visuals, at, timelineDuration(doc));
  if (!slot) return { doc, id: null };
  const p = SAMPLE_PLACEMENT[template];
  // New graphics start from the veteran interaction defaults (cards ride punch-ins at 35%,
  // shadows on, light wrap on 3D) — applied only at creation, never to existing graphics.
  const v: TimelineVisual = applyInteractionDefaults({
    id,
    template,
    props,
    start: slot.start,
    end: slot.end,
    ...VISUAL_INTERACTION_DEFAULTS,
    placement: { mode: "AUTO", x: p.x, y: p.y, scale: 1 },
    palette: "BRAND",
    enter: "AUTO",
    exit: "AUTO",
    enterSfx: "WHOOSH",
    anchorText: anchorText ? cut(anchorText, 200) : null,
  });
  return { doc: { ...doc, visuals: [...doc.visuals, v] }, id };
}

export function updateVisual(doc: EditorDoc, id: string, patch: Partial<Omit<TimelineVisual, "id">>): EditorDoc {
  return { ...doc, visuals: doc.visuals.map((v) => (v.id === id ? { ...v, ...patch } : v)) };
}

export function updateVisualProps(doc: EditorDoc, id: string, props: Record<string, unknown>): EditorDoc {
  return updateVisual(doc, id, { props });
}

export function deleteVisual(doc: EditorDoc, id: string): EditorDoc {
  return { ...doc, visuals: doc.visuals.filter((v) => v.id !== id) };
}

/** A copy in the next free gap after the original (null when there's no room). */
export function duplicateVisual(doc: EditorDoc, id: string, newVisualId: string = newId("vis")): { doc: EditorDoc; id: string | null } {
  const v = doc.visuals.find((x) => x.id === id);
  if (!v) return { doc, id: null };
  const slot = freeSlotAt(doc.visuals, v.end, timelineDuration(doc), v.end - v.start);
  if (!slot) return { doc, id: null };
  const copy: TimelineVisual = { ...structuredClone(v), id: newVisualId, start: slot.start, end: slot.end };
  return { doc: { ...doc, visuals: [...doc.visuals, copy] }, id: newVisualId };
}

/** The neighbours' bounds a visual may move/trim within (no overlaps). */
function neighbourBounds(doc: EditorDoc, v: TimelineVisual): { lo: number; hi: number } {
  const D = timelineDuration(doc);
  let lo = 0;
  let hi = D;
  for (const o of doc.visuals) {
    if (o.id === v.id) continue;
    if (o.start < v.start || (o.start === v.start && o.id < v.id)) lo = Math.max(lo, o.end);
    else hi = Math.min(hi, o.start);
  }
  return { lo, hi };
}

/** Moves a visual in time keeping its length, stopping at its neighbours and the video's ends. */
export function moveVisualSpan(doc: EditorDoc, id: string, newStart: number): EditorDoc {
  const v = doc.visuals.find((x) => x.id === id);
  if (!v) return doc;
  const len = v.end - v.start;
  const { lo, hi } = neighbourBounds(doc, v);
  const start = hi - lo >= len ? clamp(newStart, lo, hi - len) : clamp(newStart, 0, Math.max(0, timelineDuration(doc) - len));
  return updateVisual(doc, id, { start: r3(start), end: r3(start + len) });
}

/** Trims one edge (output seconds), keeping VISUAL_MIN_SECONDS and stopping at neighbours. */
export function trimVisualSpan(doc: EditorDoc, id: string, edge: "start" | "end", value: number): EditorDoc {
  const v = doc.visuals.find((x) => x.id === id);
  if (!v) return doc;
  const { lo, hi } = neighbourBounds(doc, v);
  const min = Math.min(VISUAL_MIN_SECONDS, v.end - v.start);
  if (edge === "start") return updateVisual(doc, id, { start: r3(clamp(value, Math.min(lo, v.start), v.end - min)) });
  return updateVisual(doc, id, { end: r3(clamp(value, v.start + min, Math.max(hi, v.end))) });
}

/** Chris positioned it by hand: MANUAL, so the placement engine never moves it again. */
export function placeVisualManually(doc: EditorDoc, id: string, place: { x?: number; y?: number; scale?: number }): EditorDoc {
  const v = doc.visuals.find((x) => x.id === id);
  if (!v) return doc;
  const placement = {
    mode: "MANUAL" as const,
    x: r3(clamp(place.x ?? v.placement.x, 0, 1)),
    y: r3(clamp(place.y ?? v.placement.y, 0, 1)),
    scale: Math.round(clamp(place.scale ?? v.placement.scale, 0.3, 2.5) * 100) / 100,
  };
  return updateVisual(doc, id, { placement });
}

/**
 * "Auto-place": hand the visual(s) back to the placement engine. `solve` is
 * resolveVisualPlacements bound to the editor's subject tracks / measure (it only moves AUTO
 * visuals, so the doc is flipped to AUTO first, then solved).
 */
export function autoPlaceVisuals(doc: EditorDoc, ids: string[] | "ALL", solve: (d: EditorDoc) => TimelineVisual[]): EditorDoc {
  const pick = (v: TimelineVisual) => ids === "ALL" || ids.includes(v.id);
  const flipped: EditorDoc = { ...doc, visuals: doc.visuals.map((v) => (pick(v) ? { ...v, placement: { ...v.placement, mode: "AUTO" as const } } : v)) };
  const solved = new Map(solve(flipped).map((v) => [v.id, v]));
  return { ...flipped, visuals: flipped.visuals.map((v) => (pick(v) ? { ...v, placement: solved.get(v.id)?.placement ?? v.placement } : v)) };
}

/** Writes solved AUTO placements into the doc (MANUAL untouched) — what gets saved. */
export function withResolvedPlacements(doc: EditorDoc, resolved: TimelineVisual[]): EditorDoc {
  const byId = new Map(resolved.map((v) => [v.id, v]));
  let changed = false;
  const visuals = doc.visuals.map((v) => {
    const r = byId.get(v.id);
    if (!r || v.placement.mode !== "AUTO") return v;
    const p = r.placement;
    // AUTO also owns depth for big type (auto-depth rule) — persist what the engine chose.
    if (p.x === v.placement.x && p.y === v.placement.y && p.scale === v.placement.scale && r.depth === v.depth) return v;
    changed = true;
    return { ...v, depth: r.depth, placement: { ...v.placement, x: p.x, y: p.y, scale: p.scale } };
  });
  return changed ? { ...doc, visuals } : doc;
}

// ---------------------------------------------------------------------------------------
// Motion v2: how a graphic interacts with the footage
// ---------------------------------------------------------------------------------------

/**
 * "Behind me": depth BEHIND_SUBJECT / FRONT. Like dragging, choosing depth by hand pins the
 * graphic where it's DRAWN (`shown` = its solved placement) — in AUTO the engine owns depth for
 * big type (auto-depth), so a hand-picked depth must take it out of AUTO to stick.
 */
export function setVisualDepth(doc: EditorDoc, id: string, behind: boolean, shown?: Pick<TimelineVisual, "placement">): EditorDoc {
  const v = doc.visuals.find((x) => x.id === id);
  if (!v) return doc;
  const at = shown?.placement ?? v.placement;
  return updateVisual(doc, id, {
    depth: behind ? "BEHIND_SUBJECT" : "FRONT",
    placement: { mode: "MANUAL", x: at.x, y: at.y, scale: at.scale },
  });
}

/**
 * "Follow me": anchor to Chris's head with `offset` (anchorOffsetFor at the playhead — keeps it
 * exactly where it is), or back to the screen at `stopAt` (where it's drawn now — no jump).
 * Following is a placement choice by hand, so the graphic becomes MANUAL.
 */
export function setVisualFollow(
  doc: EditorDoc,
  id: string,
  follow: { offsetX: number; offsetY: number } | null,
  stopAt?: { x: number; y: number },
): EditorDoc {
  const v = doc.visuals.find((x) => x.id === id);
  if (!v) return doc;
  const placement = { ...v.placement, mode: "MANUAL" as const, ...(stopAt ? { x: r3(clamp(stopAt.x, 0, 1)), y: r3(clamp(stopAt.y, 0, 1)) } : {}) };
  if (follow) {
    return updateVisual(doc, id, { anchor: { type: "SUBJECT", offsetX: r3(clamp(follow.offsetX, -1, 1)), offsetY: r3(clamp(follow.offsetY, -1, 1)) }, placement });
  }
  return updateVisual(doc, id, { anchor: { type: "SCREEN", offsetX: v.anchor.offsetX, offsetY: v.anchor.offsetY }, placement });
}

/** Dragging a graphic that follows Chris moves its OFFSET from his head (and its fallback spot). */
export function moveAnchoredVisual(doc: EditorDoc, id: string, offset: { offsetX: number; offsetY: number }, at: { x: number; y: number }, scale?: number): EditorDoc {
  const v = doc.visuals.find((x) => x.id === id);
  if (!v) return doc;
  return updateVisual(doc, id, {
    anchor: { type: "SUBJECT", offsetX: r3(clamp(offset.offsetX, -1, 1)), offsetY: r3(clamp(offset.offsetY, -1, 1)) },
    placement: { mode: "MANUAL", x: r3(clamp(at.x, 0, 1)), y: r3(clamp(at.y, 0, 1)), scale: Math.round(clamp(scale ?? v.placement.scale, 0.3, 2.5) * 100) / 100 },
  });
}

/** "Move with camera" 0..1 (stored to 2 decimals). */
export function setCameraCoupling(doc: EditorDoc, id: string, value: number): EditorDoc {
  return updateVisual(doc, id, { cameraCoupling: Math.round(clamp(value, 0, 1) * 100) / 100 });
}

export function setIntegration(doc: EditorDoc, id: string, patch: Partial<TimelineVisual["integration"]>): EditorDoc {
  const v = doc.visuals.find((x) => x.id === id);
  if (!v) return doc;
  return updateVisual(doc, id, { integration: { ...v.integration, ...patch } });
}

/** Emphasis timing: "AUTO" (null — the strongest word in the window), "OFF" (0 — the
 * template's own timing), or a target offset in seconds after the start ("hit near here"). */
export type EmphasisChoice = "AUTO" | "OFF" | number;
export function setEmphasisTiming(doc: EditorDoc, id: string, choice: EmphasisChoice): EditorDoc {
  const v = doc.visuals.find((x) => x.id === id);
  if (!v) return doc;
  const emphasisAt = choice === "AUTO" ? null : choice === "OFF" ? 0 : r3(clamp(choice, 0.05, Math.max(0.05, v.end - v.start)));
  return updateVisual(doc, id, { emphasisAt });
}
export function emphasisChoiceOf(v: Pick<TimelineVisual, "emphasisAt">): EmphasisChoice {
  return v.emphasisAt == null ? "AUTO" : v.emphasisAt === 0 ? "OFF" : v.emphasisAt;
}

/** Per-video motion theme; null = "Auto (from topic)". Invalid input is refused (doc unchanged). */
export function setMotionTheme(doc: EditorDoc, theme: Partial<MotionTheme> | null): EditorDoc {
  if (theme === null) return { ...doc, motionTheme: null };
  const merged = MotionThemeSchema.safeParse({ ...(doc.motionTheme ?? { name: "Custom" }), ...theme });
  return merged.success ? { ...doc, motionTheme: merged.data } : doc;
}

// ---------------------------------------------------------------------------------------
// SFX + music
// ---------------------------------------------------------------------------------------

export function addSfx(doc: EditorDoc, at: number, sound: SfxSound, id: string = newId("sfx")): { doc: EditorDoc; id: string } {
  const D = timelineDuration(doc);
  const s: TimelineSfx = { id, at: r3(clamp(at, 0, Math.max(0, D - 0.05))), sound, volume: 0.6 };
  return { doc: { ...doc, sfx: [...doc.sfx, s].sort((a, b) => a.at - b.at) }, id };
}

export function updateSfx(doc: EditorDoc, id: string, patch: Partial<Omit<TimelineSfx, "id">>): EditorDoc {
  const D = timelineDuration(doc);
  return {
    ...doc,
    sfx: doc.sfx
      .map((s) => (s.id === id ? { ...s, ...patch, at: r3(clamp(patch.at ?? s.at, 0, Math.max(0, D - 0.05))) } : s))
      .sort((a, b) => a.at - b.at),
  };
}

export function deleteSfx(doc: EditorDoc, id: string): EditorDoc {
  return { ...doc, sfx: doc.sfx.filter((s) => s.id !== id) };
}

export function setSfxEnabled(doc: EditorDoc, on: boolean): EditorDoc {
  return { ...doc, audio: { ...doc.audio, sfxEnabled: on } };
}

export const DEFAULT_MUSIC: Omit<TimelineMusic, "musicAssetId"> = {
  trackStart: 0,
  levelDb: -18,
  duckDb: 10,
  fadeInSeconds: 0.6,
  fadeOutSeconds: 1.5,
};

/** Picks (or with null, removes) the music bed. Keeps the mix settings when switching tracks. */
export function setMusic(doc: EditorDoc, musicAssetId: string | null): EditorDoc {
  if (!musicAssetId) return { ...doc, audio: { ...doc.audio, music: null } };
  const prev = doc.audio.music;
  return { ...doc, audio: { ...doc.audio, music: { ...DEFAULT_MUSIC, ...(prev ?? {}), musicAssetId, trackStart: prev?.musicAssetId === musicAssetId ? prev.trackStart : 0 } } };
}

export function updateMusic(doc: EditorDoc, patch: Partial<Omit<TimelineMusic, "musicAssetId">>): EditorDoc {
  const m = doc.audio.music;
  if (!m) return doc;
  return { ...doc, audio: { ...doc.audio, music: { ...m, ...patch } } };
}

/**
 * A Motion Designer rejection, in Chris's words: "Dropped a bar chart: 30,000 isn't in your
 * fact-checked research or script." (The agent's reasons are written for the audit log.)
 */
export function plainRejection(r: { template: string; reason: string }): string {
  const label = isMotionTemplate(r.template) ? TEMPLATE_LABEL[r.template] : r.template.replace(/_/g, " ").toLowerCase();
  const name = /^[A-Z][a-z]/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label;
  const what = `Dropped ${/^[aeiou]/.test(name) ? "an" : "a"} ${name}`;
  const factual = /^FACTUAL:\s*(.+?)\s+not found/.exec(r.reason);
  if (factual) {
    const nums = [...factual[1]!.matchAll(/(-?\d+(?:\.\d+)?)\s*\(/g)].map((m) => Number(m[1]).toLocaleString("en-US"));
    const list = nums.length ? [...new Set(nums)].join(", ") : factual[1];
    return `${what}: ${list} ${nums.length > 1 ? "aren't" : "isn't"} in your fact-checked research or script.`;
  }
  if (/limit of/.test(r.reason)) return `${what}: the video already has as many graphics as its tier allows.`;
  if (/overlap/.test(r.reason)) return `${what}: it would have overlapped another graphic.`;
  if (/after the video ends/.test(r.reason)) return `${what}: it was timed after the video ends.`;
  return `${what}: ${r.reason}.`;
}

export function isMotionTemplate(t: string): t is MotionTemplate {
  return (MOTION_TEMPLATES as readonly string[]).includes(t);
}
