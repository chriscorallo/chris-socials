import { clipDuration, clipStartTimes, timelineDuration, type EditTimeline, type TimelineClip, type TimelineText } from "../timeline";
import { MotionPropsSchemas, VISUAL_INTERACTION_DEFAULTS, type MotionTemplate, type TimelineVisual } from "../motion-contract";
import { solveVisualPlacements, subjectRegionsForWindow, visualRect, intersectionArea, type PlacementOptions } from "../visual-placement";
import { footprintOf } from "../visual-footprints";
import { layoutTimelineText, type MeasureText } from "../timeline-layout";
import { faceFromHead } from "./placement";
import { directorPlacementArea } from "./area";
import { GraphicPropsSchema, graphicShownNumbers, formatGraphicValue, GRAPHIC_COMPONENT_SPECS, type GraphicProps } from "../graphics/contract";
import { presetById, presetProps, type GraphicPreset } from "../graphics/presets";
import { applyQuickEntry, applyQuickText, parseQuickEntry, parseQuickNumber } from "../graphics/quick-entry";
import { searchPresets } from "../graphics/search";
import { relevantPresets, DIRECTOR_STAPLE_PRESETS } from "./catalog";
import type { Rect } from "../safe-zones";
import type { DirectorAnswer, DirectorOp, DirectorPlacement, DirectorRegion, DirectorTime } from "./schema";
import { directorRepairMessage } from "./parse";
import { EXPRESSION_SYNONYMS, understandingForTimeline, type Expression, type OutputUnderstanding, type TakeUnderstanding } from "./understanding";
import { REGION_WORD, solveRegionPlacement, obstaclesForWindow } from "./placement";

/**
 * Applies a validated DirectorAnswer to the current edit — PURE and deterministic; the only
 * judgment here is geometric/temporal arithmetic (CLAUDE.md: deterministic where the check is
 * deterministic). Rules:
 * - every time is checked against the CURRENT edit (an answer that points past the end, at an
 *   unknown id, or at a preset that doesn't exist is refused with a fix-up message — nothing
 *   changes); expression references ("when I smile") resolve to the detected onset;
 * - graphics are built from a real library preset through the graphics contract (quick entry /
 *   lines / field overrides, then the same zod validation the editor uses);
 * - requested sides are solved around Chris's face (placement.ts) and saved MANUAL so the
 *   renderer draws them exactly there; explicit x/y that would cover his face are moved;
 * - sound effects and zooms have limits (spacing, strength); cuts/trims run LAST, so every time
 *   in one answer refers to the edit as Chris saw it;
 * - provenance: each graphic this adds/changes is recorded as authored by "Chris via Director
 *   chat" with a hash of its exact data, so the Quality Gate's FACTUAL check can tell his own
 *   numbers from numbers typed later (a later hand edit changes the hash).
 */

export const DIRECTOR_PROVENANCE = "Chris via Director chat" as const;

export interface DirectorOwnerVisual {
  visualId: string;
  /** stableHash of {template, props} at the time Chris applied it. */
  propsHash: string;
  by: typeof DIRECTOR_PROVENANCE;
  messageId: string;
  /** Every number the graphic shows (informational). */
  numbers: number[];
  /** The subset Chris typed himself in his message (the rest came from the answer he applied). */
  chrisSaid: number[];
}

/** What a plan row's `plan.director` holds (JSON) — carried forward by later saves. */
export interface DirectorRecord {
  version: 1;
  /** The answer's own names → item ids ("rent" → "dc-rent"). */
  refs: Record<string, string>;
  /** Director-placed graphics → the region Chris asked for (re-solved on "move"). */
  placements: Record<string, { region: DirectorRegion; size: "S" | "M" | "L" | null }>;
  owner: DirectorOwnerVisual[];
  lastMessageId: string | null;
}

export function readDirectorRecord(plan: unknown): DirectorRecord | null {
  const d = (plan as { director?: unknown } | null)?.director as Partial<DirectorRecord> | undefined;
  if (!d || typeof d !== "object" || d.version !== 1) return null;
  return {
    version: 1,
    refs: d.refs && typeof d.refs === "object" ? (d.refs as Record<string, string>) : {},
    placements: d.placements && typeof d.placements === "object" ? (d.placements as DirectorRecord["placements"]) : {},
    owner: Array.isArray(d.owner) ? (d.owner as DirectorOwnerVisual[]) : [],
    lastMessageId: typeof d.lastMessageId === "string" ? d.lastMessageId : null,
  };
}

export interface DirectorApplyContext {
  placement: PlacementOptions;
  measure?: MeasureText;
  understanding: Record<string, TakeUnderstanding | null | undefined>;
  record: DirectorRecord | null;
  /** DirectorMessage id of the answer being applied (provenance). */
  messageId: string;
  /** Chris's own message(s) in this turn — expression words + the numbers he typed. */
  chrisText: string;
}

export type DirectorChangeKind = "ADDED" | "REMOVED" | "MOVED" | "CHANGED" | "CUT" | "CAPTIONS" | "NOTE" | "SKIPPED";

export interface DirectorChange {
  kind: DirectorChangeKind;
  /** "Added: Payment received +$2,400 at 0.8 s (left)" */
  text: string;
  id?: string;
}

export type DirectorApplyResult =
  | {
      ok: true;
      timeline: EditTimeline;
      changes: DirectorChange[];
      /** Things Chris should know (moved off his face, snapped to his smile, clamped…). */
      notes: string[];
      record: DirectorRecord;
      /** True when nothing in the edit changed (only notes). */
      noop: boolean;
    }
  | { ok: false; errors: string[]; repairMessage: string };

// ---------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fmtT = (n: number) => `${(Math.round(n * 10) / 10).toFixed(1)} s`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

function fnv(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let h2 = 5381;
  for (let i = 0; i < s.length; i++) h2 = (Math.imul(h2, 33) ^ s.charCodeAt(i)) >>> 0;
  return (h >>> 0).toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** Hash of exactly what a graphic shows — the provenance key for Director-chat numbers. */
export function directorPropsHash(template: string, props: unknown): string {
  return fnv(stableStringify({ template, props }));
}

/**
 * Visuals whose numbers are owner-provided: added/changed through the Director chat by Chris
 * and NOT edited since (their props still hash to what he applied). The Quality Gate's FACTUAL
 * check treats their numbers as his own (provenance "Chris via Director chat"); a later hand
 * edit changes the hash and the normal research/script check applies again. Pure.
 */
export function directorOwnedVisualIds(plan: unknown, visuals: Array<Pick<TimelineVisual, "id" | "template" | "props">>): Set<string> {
  const rec = readDirectorRecord(plan);
  const out = new Set<string>();
  if (!rec) return out;
  for (const v of visuals) {
    const o = rec.owner.find((x) => x.visualId === v.id);
    if (o && o.by === DIRECTOR_PROVENANCE && o.propsHash === directorPropsHash(v.template, v.props)) out.add(v.id);
  }
  return out;
}

/** Numbers a visual puts on screen (GRAPHIC: graphicShownNumbers + digits in its texts). */
export function visualShownNumbers(template: string, props: Record<string, unknown>): number[] {
  const out: number[] = [];
  const digits = (s: string) => {
    for (const m of s.matchAll(/[-−+]?\$?\d[\d,]*(?:\.\d+)?\s*[kKmM%]?/g)) {
      const n = parseQuickNumber(m[0]);
      if (n) out.push(n.value);
    }
  };
  if (template === "GRAPHIC") {
    const r = GraphicPropsSchema.safeParse(props);
    if (!r.success) return out;
    const s = graphicShownNumbers(r.data);
    for (const n of s.numbers) out.push(n.value);
    for (const t of s.texts) digits(t.text);
  } else {
    for (const [k, v] of Object.entries(props)) {
      if (typeof v === "number" && !["decimals"].includes(k)) out.push(v);
      if (typeof v === "string") digits(v);
    }
  }
  return [...new Set(out.map((n) => Math.round(n * 100) / 100))];
}

function numbersInText(s: string): number[] {
  const out: number[] = [];
  for (const m of s.matchAll(/[-−+]?\$?\d[\d,]*(?:\.\d+)?\s*[kKmM%]?/g)) {
    const n = parseQuickNumber(m[0]);
    if (n) out.push(Math.abs(n.value));
  }
  return out;
}

/** Short, human description of a visual for the change list. */
export function describeVisual(v: Pick<TimelineVisual, "template" | "props">, preset?: GraphicPreset | null): string {
  const p = v.props as Record<string, unknown>;
  if (v.template === "GRAPHIC") {
    const r = GraphicPropsSchema.safeParse(p);
    if (!r.success) return preset?.name ?? "Graphic";
    const g = r.data;
    if (g.items.length > 1 && !g.series.length) {
      // a list (notifications, a feed, steps): name each entry with its money/number if it has one
      const entries = g.items.slice(0, 4).map((it) => {
        const money = it.value !== null ? formatGraphicValue(it.value, g.format) : (/[-−+]?\$[\d,]+(?:\.\d+)?/.exec(`${it.sub ?? ""} ${it.text}`)?.[0] ?? "").replace(/\.00$/, "");
        return `${it.text.slice(0, 28)}${money && !it.text.includes(money) ? ` ${money}` : ""}`;
      });
      return `${g.title ? `${g.title.slice(0, 30)}: ` : ""}${entries.join(", ")}${g.items.length > 4 ? ` +${g.items.length - 4} more` : ""}`;
    }
    const main = g.title ?? g.items[0]?.text ?? g.body ?? GRAPHIC_COMPONENT_SPECS[g.component].label;
    const nums = graphicShownNumbers(g).numbers.slice(0, 3).map((n) => {
      const s = formatGraphicValue(n.value, g.format);
      return n.value > 0 && /RECEIVED|BANNER/.test(String(g.variant ?? "")) ? `+${s}` : s;
    });
    const subs = g.items.slice(0, 3).map((it) => it.sub).filter((s): s is string => !!s);
    const extra = nums.length ? ` ${nums.join(", ")}` : subs.length ? ` — ${subs.join(" · ").slice(0, 60)}` : "";
    const list = g.items.length > 1 && !nums.length ? ` (${g.items.length} entries)` : "";
    return `${main.slice(0, 48)}${extra}${list}`;
  }
  if (v.template === "NUMBER_COUNTER") {
    const pre = String(p.prefix ?? "");
    const fmt = (n: unknown) => `${pre}${Number(n).toLocaleString("en-US")}${String(p.suffix ?? "")}`;
    return `${p.label ? `${String(p.label)}: ` : ""}${fmt(p.from ?? 0)} → ${fmt(p.value)}`;
  }
  const text = p.text ?? p.title ?? p.label ?? p.value;
  return `${preset?.name ?? v.template}${text ? ` “${String(text).slice(0, 40)}”` : ""}`;
}

// ---------------------------------------------------------------------------------------
// text styles
// ---------------------------------------------------------------------------------------

const TEXT_STYLE: Record<string, Omit<TimelineText, "id" | "text" | "start" | "end" | "x" | "y"> & { sizes: [number, number, number] }> = {
  HEADLINE: { preset: "HEADLINE", fontId: "inter-display-extrabold", fontSize: 68, sizes: [56, 68, 80], color: "#FFFFFF", backgroundColor: "#000000B3", strokeColor: null, align: "center", maxWidth: 0.8, uppercase: false },
  PUNCH: { preset: "CUSTOM", fontId: "montserrat-black", fontSize: 110, sizes: [84, 110, 140], color: "#FFFFFF", backgroundColor: null, strokeColor: "#000000", align: "center", maxWidth: 0.9, uppercase: true },
  CAPTION: { preset: "CAPTION", fontId: "inter-display-bold", fontSize: 52, sizes: [44, 52, 62], color: "#FFFFFF", backgroundColor: null, strokeColor: "#000000", align: "center", maxWidth: 0.84, uppercase: false },
  LOWER_THIRD: { preset: "LOWER_THIRD", fontId: "inter-semibold", fontSize: 46, sizes: [40, 46, 54], color: "#FFFFFF", backgroundColor: "#111111CC", strokeColor: null, align: "center", maxWidth: 0.72, uppercase: false },
  NUMBER: { preset: "NUMBER_CALLOUT", fontId: "archivo-black", fontSize: 130, sizes: [96, 130, 170], color: "#FFD54A", backgroundColor: null, strokeColor: "#000000", align: "center", maxWidth: 0.9, uppercase: false },
};

function textRectOf(t: TimelineText, canvas: { width: number; height: number }, measure?: MeasureText): Rect {
  if (measure) {
    try {
      return layoutTimelineText(t, canvas, measure).rect;
    } catch {
      /* estimate */
    }
  }
  const k = canvas.width / 1080;
  const fontPx = t.fontSize * k;
  const maxW = t.maxWidth * canvas.width;
  const textW = t.text.length * fontPx * 0.56;
  const lines = Math.max(1, Math.ceil(textW / maxW));
  const pad = t.backgroundColor ? fontPx * 0.5 : fontPx * 0.1;
  const w = Math.min(maxW, textW) + 2 * pad;
  const h = lines * fontPx * 1.2 + 2 * pad;
  return { x: t.x * canvas.width - w / 2, y: t.y * canvas.height - h / 2, width: w, height: h };
}

// ---------------------------------------------------------------------------------------
// cut / trim (ripple)
// ---------------------------------------------------------------------------------------

/** Removes output range [a, b) and slides everything after it earlier. Pure. */
export function cutRange(doc: EditTimeline, a: number, b: number, newId: (p: string) => string): { doc: EditTimeline; removed: string[] } {
  const len = b - a;
  const starts = clipStartTimes(doc);
  const clips: TimelineClip[] = [];
  doc.clips.forEach((c, i) => {
    const cs = starts[i]!;
    const ce = cs + clipDuration(c);
    if (ce <= a + 1e-6 || cs >= b - 1e-6) {
      clips.push(c);
      return;
    }
    if (cs < a - 0.05) clips.push({ ...c, sourceEnd: r3(c.sourceStart + (a - cs)) });
    if (ce > b + 0.05) clips.push({ ...c, id: cs < a - 0.05 ? newId("clip") : c.id, sourceStart: r3(c.sourceStart + (b - cs)) });
  });
  const f = (t: number) => (t <= a ? t : t >= b ? t - len : a);
  const removed: string[] = [];
  const span = <T extends { id: string; start: number; end: number }>(xs: T[]): T[] =>
    xs.flatMap((x) => {
      const s = r3(f(x.start));
      const e = r3(f(x.end));
      if (e - s < 0.2) {
        removed.push(x.id);
        return [];
      }
      return [{ ...x, start: s, end: e }];
    });
  return {
    doc: {
      ...doc,
      clips,
      texts: span(doc.texts),
      visuals: span(doc.visuals),
      zooms: span(doc.zooms),
      sfx: doc.sfx.flatMap((s) => {
        if (s.at >= a && s.at < b) {
          removed.push(s.id);
          return [];
        }
        return [{ ...s, at: r3(f(s.at)) }];
      }),
      coverFrameSeconds: doc.coverFrameSeconds == null ? null : r3(f(doc.coverFrameSeconds)),
    },
    removed,
  };
}

// ---------------------------------------------------------------------------------------
// the applier
// ---------------------------------------------------------------------------------------

type ItemKind = "visual" | "text" | "zoom" | "sfx";

export function applyDirectorAnswer(timeline: EditTimeline, answer: DirectorAnswer, ctx: DirectorApplyContext): DirectorApplyResult {
  const D = timelineDuration(timeline);
  const canvas = timeline.canvas;
  const ou: OutputUnderstanding = understandingForTimeline(timeline, ctx.understanding);
  const errors: string[] = [];
  const notes: string[] = [];
  const changes: DirectorChange[] = [];
  const prev = ctx.record;
  const refs: Record<string, string> = { ...(prev?.refs ?? {}) };
  const placements: DirectorRecord["placements"] = { ...(prev?.placements ?? {}) };
  let doc: EditTimeline = structuredClone(timeline);
  const touched = new Set<string>();
  /** visual id → requested placement to solve after all ops. */
  const toPlace = new Map<string, { region: DirectorRegion; size: "S" | "M" | "L" | null; label: string; explicit?: { x: number; y: number; scale: number } }>();
  const presetOf = new Map<string, GraphicPreset | null>();
  let seq = 0;
  const newId = (p: string) => `dc-${p}-${(++seq).toString(36)}`;

  const mentioned = new Set<Expression>();
  for (const w of ctx.chrisText.toLowerCase().match(/[a-z]+/g) ?? []) {
    const e = EXPRESSION_SYNONYMS[w];
    if (e && e !== "neutral") mentioned.add(e);
  }

  const opLabel = (i: number, op: DirectorOp) => `operations[${i}] (${op.op}${"ref" in op ? ` "${op.ref}"` : "target" in op ? ` "${op.target}"` : ""})`;

  // ---- time resolution -------------------------------------------------------------
  const onsets = (e: Expression) => {
    const on = ou.events.filter((ev) => ev.kind === "EXPRESSION_ONSET" && ev.expression === e).map((ev) => ev.t);
    if (on.length) return on;
    const ch = ou.events.filter((ev) => ev.kind === "EXPRESSION_CHANGE" && ev.expression === e).map((ev) => ev.t);
    if (ch.length) return ch;
    const first = ou.points.find((p) => p.expression === e && p.confidence >= 0.45);
    return first ? [first.t] : [];
  };
  const resolveTime = (t: DirectorTime | undefined, where: string, fallback: number | null): number | null => {
    if (t === undefined) return fallback;
    if (t === "end") return D;
    if (typeof t === "number") {
      if (t > D + 0.5) {
        errors.push(`${where}: ${t} s is after the end of the video (it's ${fmtT(D)} long right now)`);
        return null;
      }
      return clamp(t, 0, D);
    }
    let base: number | null = null;
    if (t.event) {
      const ev = ou.events.find((e) => e.id === t.event);
      if (!ev) {
        errors.push(`${where}: there's no event "${t.event}" (events: ${ou.events.map((e) => e.id).join(", ") || "none"})`);
        return null;
      }
      base = ev.t;
    } else if (t.expression) {
      const list = onsets(t.expression);
      if (!list.length) {
        errors.push(`${where}: no "${t.expression}" moment was detected in this video — use a number of seconds instead`);
        return null;
      }
      if (t.near !== undefined) base = list.reduce((a, b) => (Math.abs(b - t.near!) < Math.abs(a - t.near!) ? b : a));
      else if (t.nth !== undefined) {
        if (t.nth > list.length) {
          errors.push(`${where}: only ${list.length} "${t.expression}" moment(s) were detected — "nth": ${t.nth} doesn't exist`);
          return null;
        }
        base = list[t.nth - 1]!;
      } else base = list[0]!;
    }
    return clamp(r3((base ?? 0) + (t.offset ?? 0)), 0, D);
  };
  /** A numeric start right next to the onset of an expression this op talks about snaps to it. */
  const snap = (start: number, op: { why?: string; start?: DirectorTime; at?: DirectorTime }, label: string): number => {
    const raw = "at" in op && op.at !== undefined ? op.at : op.start;
    if (typeof raw !== "number") return start;
    const words = (op.why ?? "").toLowerCase().match(/[a-z]+/g) ?? [];
    const exps = new Set<Expression>(words.map((w) => EXPRESSION_SYNONYMS[w]).filter((e): e is Expression => !!e && e !== "neutral"));
    if (exps.size === 0) return start;
    let best: { t: number; e: Expression } | null = null;
    for (const e of exps) for (const t of onsets(e)) if (!best || Math.abs(t - start) < Math.abs(best.t - start)) best = { t, e };
    if (best && Math.abs(best.t - start) <= 0.6 && Math.abs(best.t - start) >= 0.05) {
      notes.push(`${label}: snapped from ${fmtT(start)} to ${fmtT(best.t)} — when your face turns ${best.e}`);
      return r3(best.t);
    }
    return start;
  };

  const span = (op: { start?: DirectorTime; end?: DirectorTime; duration?: number; why?: string }, where: string, defaultLen: number, snapIt = false): { start: number; end: number } | null => {
    let start = resolveTime(op.start, `${where} start`, 0);
    if (start === null) return null;
    if (snapIt) start = snap(start, op, where);
    if (start >= D - 0.2) {
      errors.push(`${where}: starts at ${fmtT(start)}, but the video ends at ${fmtT(D)}`);
      return null;
    }
    let end = op.end !== undefined ? resolveTime(op.end, `${where} end`, null) : r3(start + (op.duration ?? defaultLen));
    if (end === null) return null;
    if (end > D) {
      if (end - D > 0.05) notes.push(`${where}: ends at the end of the video (${fmtT(D)}) instead of ${fmtT(end)}`);
      end = D;
    }
    if (end - start < 0.3) {
      errors.push(`${where}: ends (${fmtT(end)}) before it starts (${fmtT(start)}) — or is shorter than 0.3 s`);
      return null;
    }
    return { start: r3(start), end: r3(end) };
  };

  // ---- targets ---------------------------------------------------------------------
  const findItem = (target: string): { kind: ItemKind; id: string } | null => {
    const id = refs[target] ?? refs[target.replace(/^dc-/, "")] ?? target;
    if (doc.visuals.some((v) => v.id === id)) return { kind: "visual", id };
    if (doc.texts.some((t) => t.id === id)) return { kind: "text", id };
    if (doc.zooms.some((z) => z.id === id)) return { kind: "zoom", id };
    if (doc.sfx.some((s) => s.id === id)) return { kind: "sfx", id };
    return null;
  };
  const knownIds = () =>
    [...Object.keys(refs).filter((r) => findItem(r)), ...doc.visuals.map((v) => v.id), ...doc.texts.map((t) => t.id)].slice(0, 20).join(", ") || "none yet";

  // ---- graphic data ----------------------------------------------------------------
  const buildProps = (
    where: string,
    preset: GraphicPreset,
    base: Record<string, unknown> | null,
    data: { props?: Record<string, unknown>; quick?: string; lines?: string; speed?: number },
  ): Record<string, unknown> | null => {
    const start = base ? structuredClone(base) : presetProps(preset);
    if (preset.template !== "GRAPHIC") {
      const merged: Record<string, unknown> = { ...start, ...(data.props ?? {}) };
      if (data.quick && preset.template === "NUMBER_COUNTER") {
        const n = parseQuickNumber(data.quick);
        if (n) merged.value = n.value;
      }
      if (data.lines && preset.template === "KINETIC_TEXT") merged.text = data.lines.split(/\n/)[0]!.slice(0, 120);
      const r = MotionPropsSchemas[preset.template as Exclude<MotionTemplate, "GRAPHIC">].safeParse(merged);
      if (!r.success) {
        for (const i of r.error.issues.slice(0, 3)) errors.push(`${where} props.${i.path.join(".") || "(data)"}: ${i.message}`);
        return null;
      }
      return r.data as Record<string, unknown>;
    }
    const props: Record<string, unknown> = { ...start };
    const patch = data.props ?? {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === "component") continue;
      if ((k === "format" || k === "animation") && v && typeof v === "object") props[k] = { ...((props[k] as object) ?? {}), ...(v as object) };
      else if ((k === "items" || k === "series") && Array.isArray(v)) {
        const prevList = Array.isArray(start[k]) ? (start[k] as Array<Record<string, unknown>>) : [];
        props[k] = v.map((x, i) => {
          if (!x || typeof x !== "object") return x;
          const look: Record<string, unknown> = {};
          const p = prevList[i] ?? prevList[prevList.length - 1];
          if (p) for (const f of k === "items" ? ["icon", "color", "meta", "side", "op", "state"] : ["icon", "color"]) if (p[f] !== undefined) look[f] = p[f];
          return { ...look, ...(x as object) };
        });
      } else props[k] = v;
    }
    let parsed = GraphicPropsSchema.safeParse(props);
    if (!parsed.success) {
      for (const i of parsed.error.issues.slice(0, 3)) errors.push(`${where} props.${i.path.join(".") || "(data)"}: ${i.message}`);
      return null;
    }
    let g: GraphicProps = parsed.data;
    if (data.quick) {
      const q = parseQuickEntry(data.quick);
      g = applyQuickEntry(g, q).props;
      for (const w of q.warnings) notes.push(`${where}: ${w}`);
    }
    if (data.lines) {
      const r = applyQuickText(g, data.lines);
      const u = GRAPHIC_COMPONENT_SPECS[g.component].uses;
      if (r) {
        g = r.props;
        for (const w of r.warnings) notes.push(`${where}: ${w}`);
      } else if (u.items) {
        // Any list-shaped component: one entry per line, "Title — detail" / "Title: detail"
        // (the preset's icons/colours/app names are kept entry by entry).
        const lines = data.lines.split(/\n|\|/).map((l) => l.trim()).filter(Boolean).slice(0, u.items.count[1]);
        g = {
          ...g,
          items: lines.map((l, i) => {
            const m = /^(.*?)\s+(?:—|–|-{1,2}|:)\s+(.*)$/.exec(l);
            const prev = g.items[i] ?? g.items[g.items.length - 1];
            const base = prev ? { ...prev } : { text: "", sub: null, value: null, icon: null, color: "AUTO" as const, op: "NONE" as const, state: "NONE" as const, side: "NONE" as const, meta: null };
            return { ...base, text: (m ? m[1]! : l).slice(0, 120), sub: u.items!.sub ? (m ? m[2]!.slice(0, 100) : null) : null, value: u.items!.value ? null : base.value };
          }),
        };
      } else {
        errors.push(`${where}: "${preset.id}" doesn't take "lines" — use "props" or "quick" for it`);
        return null;
      }
    }
    if (data.speed) g = { ...g, animation: { ...g.animation, speed: data.speed } };
    parsed = GraphicPropsSchema.safeParse(g);
    if (!parsed.success) {
      for (const i of parsed.error.issues.slice(0, 3)) errors.push(`${where} props.${i.path.join(".") || "(data)"}: ${i.message}`);
      return null;
    }
    return parsed.data as unknown as Record<string, unknown>;
  };

  const lookupPreset = (id: string, where: string): GraphicPreset | null => {
    const p = presetById(id);
    if (p) return p;
    let near = searchPresets(id.replace(/[-_]/g, " "), { limit: 3 }).map((h) => h.preset.id);
    if (!near.length) near = relevantPresets(id.replace(/[-_]/g, " "), 11).filter((p) => !DIRECTOR_STAPLE_PRESETS.includes(p.id as never)).slice(0, 3).map((p) => p.id);
    errors.push(`${where}: "${id}" isn't a graphic in the library${near.length ? ` — closest: ${near.join(", ")}` : ""}`);
    return null;
  };

  const placementRequest = (pl: DirectorPlacement | undefined, size: "S" | "M" | "L" | undefined): { region: DirectorRegion; size: "S" | "M" | "L" | null; explicit?: { x: number; y: number; scale: number } } | null => {
    if (pl === undefined) return size ? { region: "AUTO", size } : null;
    if (typeof pl === "string") return { region: pl, size: size ?? null };
    return { region: "AUTO", size: size ?? null, explicit: { x: pl.x, y: pl.y, scale: pl.scale ?? 1 } };
  };

  // ---- pass 1: everything except cut/trim ------------------------------------------
  const deferred: Array<{ op: Extract<DirectorOp, { op: "cut" | "trim" }>; where: string }> = [];
  answer.operations.forEach((op, i) => {
    const where = opLabel(i, op);
    switch (op.op) {
      case "note":
        changes.push({ kind: "NOTE", text: op.text });
        return;
      case "cut":
      case "trim":
        deferred.push({ op, where });
        return;
      case "setCaptions": {
        doc = { ...doc, captions: { ...doc.captions, enabled: op.enabled, preset: op.style ?? doc.captions.preset } };
        changes.push({ kind: "CAPTIONS", text: `Captions ${op.enabled ? `on${op.style ? ` (${op.style.toLowerCase().replace(/_/g, " ")})` : ""}` : "off"}` });
        return;
      }
      case "addGraphic": {
        const preset = lookupPreset(op.presetId, where);
        if (!preset) return;
        const s = span(op, where, preset.seconds, true);
        const props = buildProps(where, preset, null, op);
        if (!s || !props) return;
        const id = refs[op.ref] && !findItem(op.ref) ? refs[op.ref]! : findItem(op.ref) ? newId(op.ref) : `dc-${op.ref}`;
        if (!op.props && !op.quick && !op.lines) notes.push(`${where}: shows the library's example data — tell me what it should say`);
        const v: TimelineVisual = {
          id,
          template: preset.template,
          props,
          start: s.start,
          end: s.end,
          placement: { mode: "AUTO", x: preset.placement?.x ?? 0.5, y: preset.placement?.y ?? 0.3, scale: 1 },
          palette: preset.palette ?? "BRAND",
          enter: op.enter ?? "AUTO",
          exit: op.exit ?? "AUTO",
          enterSfx: op.sfx === undefined ? (preset.enterSfx === undefined ? "WHOOSH" : preset.enterSfx) : op.sfx,
          anchorText: `${DIRECTOR_PROVENANCE}${op.why ? `: ${op.why}` : ""}`.slice(0, 200),
          ...structuredClone(VISUAL_INTERACTION_DEFAULTS),
        };
        doc = { ...doc, visuals: [...doc.visuals, v] };
        refs[op.ref] = id;
        presetOf.set(id, preset);
        touched.add(id);
        const req = placementRequest(op.placement, op.size);
        if (req) toPlace.set(id, { ...req, label: where });
        changes.push({ kind: "ADDED", id, text: `Added: ${describeVisual(v, preset)} at ${fmtT(s.start)}–${fmtT(s.end)}` });
        return;
      }
      case "addText": {
        const s = span(op, where, 2.5, true);
        if (!s) return;
        const style = TEXT_STYLE[op.style ?? "HEADLINE"]!;
        const { sizes, ...look } = style;
        const id = findItem(op.ref) ? newId(op.ref) : `dc-${op.ref}`;
        const t: TimelineText = {
          id,
          text: op.text,
          start: s.start,
          end: s.end,
          ...look,
          fontSize: sizes[op.size === "S" ? 0 : op.size === "L" ? 2 : 1],
          color: op.color ?? look.color,
          uppercase: op.uppercase ?? look.uppercase,
          x: 0.5,
          y: 0.3,
        };
        const placed = placeText(doc, t, typeof op.placement === "string" ? op.placement : "AUTO", typeof op.placement === "object" ? op.placement : null, ctx);
        doc = { ...doc, texts: [...doc.texts, placed.text] };
        refs[op.ref] = id;
        touched.add(id);
        if (placed.note) notes.push(`“${op.text.slice(0, 30)}”: ${placed.note}`);
        changes.push({ kind: "ADDED", id, text: `Added text: “${op.text}” at ${fmtT(s.start)}–${fmtT(s.end)} (${REGION_WORD[placed.used]})` });
        return;
      }
      case "addZoom": {
        const s = span(op, where, 1.2, true);
        if (!s) return;
        let amount = op.amount;
        if (amount > 1.6) {
          notes.push(`${where}: a ${amount}× zoom crops your face hard — used 1.6×`);
          amount = 1.6;
        }
        const clash = doc.zooms.find((z) => z.start < s.end && z.end > s.start);
        if (clash) {
          changes.push({ kind: "SKIPPED", text: `Skipped a zoom at ${fmtT(s.start)} — another zoom is already on then (${clash.id})` });
          return;
        }
        let x = 0.5;
        let y = 0.4;
        if (op.focus && typeof op.focus === "object") ({ x, y } = op.focus);
        else if (op.focus !== "center") {
          const sub = subjectRegionsForWindow(doc, s.start, Math.min(D, s.start + 0.3), ctx.placement);
          if (sub.head) {
            const f = faceFromHead(sub.head);
            x = clamp((f.x + f.width / 2) / canvas.width, 0, 1);
            y = clamp((f.y + f.height / 2) / canvas.height, 0, 1);
          }
        }
        const id = findItem(op.ref) ? newId(op.ref) : `dc-${op.ref}`;
        doc = { ...doc, zooms: [...doc.zooms, { id, start: s.start, end: s.end, zoom: amount, x: r3(x), y: r3(y), mode: op.mode ?? "CUT", easeSeconds: 0.4 }] };
        refs[op.ref] = id;
        touched.add(id);
        changes.push({ kind: "ADDED", id, text: `Added: ${op.mode === "EASE" ? "slow push-in" : "punch-in"} ${amount}× on your face at ${fmtT(s.start)}–${fmtT(s.end)}` });
        return;
      }
      case "addSfx": {
        let at = resolveTime(op.at, `${where} at`, null);
        if (at === null) return;
        at = snap(at, op, where);
        if (at >= D) at = Math.max(0, D - 0.1);
        const near = [...doc.sfx.map((x) => x.at), ...doc.visuals.filter((v) => v.enterSfx).map((v) => v.start)].find((t) => Math.abs(t - at!) < 0.25);
        if (near !== undefined) {
          changes.push({ kind: "SKIPPED", text: `Skipped the extra ${op.sound.toLowerCase().replace(/_/g, " ")} at ${fmtT(at)} — another sound plays then` });
          return;
        }
        if (doc.sfx.length >= 24) {
          changes.push({ kind: "SKIPPED", text: `Skipped ${op.sound.toLowerCase()} — the video already has plenty of sound effects` });
          return;
        }
        const id = findItem(op.ref) ? newId(op.ref) : `dc-${op.ref}`;
        doc = { ...doc, sfx: [...doc.sfx, { id, at: r3(at), sound: op.sound, volume: op.volume ?? 0.7 }] };
        refs[op.ref] = id;
        touched.add(id);
        changes.push({ kind: "ADDED", id, text: `Added sound: ${op.sound === "CASH" ? "cha-ching" : op.sound.toLowerCase().replace(/_/g, " ")} at ${fmtT(at)}` });
        return;
      }
      case "remove": {
        const it = findItem(op.target);
        if (!it) {
          errors.push(`${where}: there's nothing called "${op.target}" in the edit (known: ${knownIds()})`);
          return;
        }
        const label =
          it.kind === "visual"
            ? describeVisual(doc.visuals.find((v) => v.id === it.id)!)
            : it.kind === "text"
              ? `text “${doc.texts.find((t) => t.id === it.id)!.text.slice(0, 40)}”`
              : it.kind === "zoom"
                ? "zoom"
                : "sound";
        doc = {
          ...doc,
          visuals: doc.visuals.filter((v) => v.id !== it.id),
          texts: doc.texts.filter((t) => t.id !== it.id),
          zooms: doc.zooms.filter((z) => z.id !== it.id),
          sfx: doc.sfx.filter((s) => s.id !== it.id),
        };
        delete placements[it.id];
        changes.push({ kind: "REMOVED", id: it.id, text: `Removed: ${label}` });
        return;
      }
      case "move": {
        const it = findItem(op.target);
        if (!it) {
          errors.push(`${where}: there's nothing called "${op.target}" in the edit (known: ${knownIds()})`);
          return;
        }
        const parts: string[] = [];
        if (it.kind === "sfx") {
          const at = resolveTime(op.start, `${where} start`, null);
          if (at === null) return;
          doc = { ...doc, sfx: doc.sfx.map((s) => (s.id === it.id ? { ...s, at: r3(Math.min(at, D - 0.05)) } : s)) };
          changes.push({ kind: "MOVED", id: it.id, text: `Moved the sound to ${fmtT(at)}` });
          return;
        }
        const cur = (it.kind === "visual" ? doc.visuals : it.kind === "text" ? doc.texts : doc.zooms).find((x) => x.id === it.id)!;
        let start = cur.start;
        let end = cur.end;
        if (op.start !== undefined || op.end !== undefined || op.duration !== undefined) {
          const len = op.duration ?? cur.end - cur.start;
          const s = resolveTime(op.start, `${where} start`, cur.start);
          if (s === null) return;
          const e = op.end !== undefined ? resolveTime(op.end, `${where} end`, null) : r3(s + len);
          if (e === null) return;
          start = r3(s);
          end = r3(Math.min(D, e));
          if (end - start < 0.3) {
            errors.push(`${where}: would be shorter than 0.3 s`);
            return;
          }
          parts.push(`${fmtT(start)}–${fmtT(end)}`);
        }
        if (it.kind === "visual") {
          doc = { ...doc, visuals: doc.visuals.map((v) => (v.id === it.id ? { ...v, start, end } : v)) };
          const req = placementRequest(op.placement, op.size);
          const prevReq = placements[it.id];
          if (req) toPlace.set(it.id, { ...req, label: where });
          else if (prevReq && (start !== cur.start || end !== cur.end)) toPlace.set(it.id, { ...prevReq, label: where });
          if (req) parts.push(req.explicit ? "to the spot you gave" : REGION_WORD[req.region]);
          touched.add(it.id);
        } else if (it.kind === "text") {
          let t = doc.texts.find((x) => x.id === it.id)!;
          t = { ...t, start, end };
          if (op.size) t = { ...t, fontSize: Math.round(t.fontSize * (op.size === "S" ? 0.8 : op.size === "L" ? 1.2 : 1)) };
          if (op.placement !== undefined) {
            const placed = placeText({ ...doc, texts: doc.texts.filter((x) => x.id !== it.id) }, t, typeof op.placement === "string" ? op.placement : "AUTO", typeof op.placement === "object" ? op.placement : null, ctx);
            t = placed.text;
            parts.push(REGION_WORD[placed.used]);
            if (placed.note) notes.push(`“${t.text.slice(0, 30)}”: ${placed.note}`);
          }
          doc = { ...doc, texts: doc.texts.map((x) => (x.id === it.id ? t : x)) };
          touched.add(it.id);
        } else {
          doc = { ...doc, zooms: doc.zooms.map((z) => (z.id === it.id ? { ...z, start, end } : z)) };
        }
        changes.push({ kind: "MOVED", id: it.id, text: `Moved ${it.kind === "visual" ? describeVisual(doc.visuals.find((v) => v.id === it.id)!) : it.kind === "text" ? `“${(cur as TimelineText).text.slice(0, 30)}”` : "the zoom"}${parts.length ? ` → ${parts.join(", ")}` : ""}` });
        return;
      }
      case "update": {
        const it = findItem(op.target);
        if (!it) {
          errors.push(`${where}: there's nothing called "${op.target}" in the edit (known: ${knownIds()})`);
          return;
        }
        if (it.kind === "visual") {
          const cur = doc.visuals.find((v) => v.id === it.id)!;
          const presetId = op.presetId ?? (cur.template === "GRAPHIC" ? String((cur.props as { preset?: string }).preset ?? "") : "");
          let preset = presetId ? presetById(presetId) : null;
          if (op.presetId && !preset) {
            lookupPreset(op.presetId, where);
            return;
          }
          let props: Record<string, unknown> | null = cur.props as Record<string, unknown>;
          if (op.presetId || op.props || op.quick || op.lines || op.speed) {
            if (!preset) {
              // a non-library graphic: synthesize a pseudo preset from its own props
              preset = { id: presetId || cur.template, name: "Graphic", description: "", category: "MONEY", tags: [], template: cur.template, props: cur.props as Record<string, unknown>, seconds: cur.end - cur.start };
            }
            props = buildProps(where, preset, op.presetId ? null : (cur.props as Record<string, unknown>), op);
            if (!props) return;
          }
          const next: TimelineVisual = {
            ...cur,
            template: preset?.template ?? cur.template,
            props,
            enter: op.enter ?? cur.enter,
            exit: op.exit ?? cur.exit,
            enterSfx: op.sfx === undefined ? cur.enterSfx : op.sfx,
          };
          doc = { ...doc, visuals: doc.visuals.map((v) => (v.id === it.id ? next : v)) };
          if (op.presetId || op.props || op.quick || op.lines) {
            const prevReq = placements[it.id];
            if (prevReq && !toPlace.has(it.id)) toPlace.set(it.id, { ...prevReq, label: where });
          }
          touched.add(it.id);
          const bits = [op.presetId ? `now ${preset?.name}` : null, op.props || op.quick || op.lines ? "new data" : null, op.speed ? `${op.speed}× speed` : null, op.enter ? `enters ${op.enter.toLowerCase()}` : null, op.sfx !== undefined ? (op.sfx ? `sound ${op.sfx.toLowerCase()}` : "silent") : null].filter(Boolean);
          changes.push({ kind: "CHANGED", id: it.id, text: `Changed: ${describeVisual(next, preset)}${bits.length ? ` (${bits.join(", ")})` : ""}` });
          return;
        }
        if (it.kind === "text") {
          let t = doc.texts.find((x) => x.id === it.id)!;
          if (op.style) {
            const { sizes, ...look } = TEXT_STYLE[op.style]!;
            t = { ...t, ...look, fontSize: sizes[1] };
          }
          if (op.text) t = { ...t, text: op.text };
          if (op.color) t = { ...t, color: op.color };
          doc = { ...doc, texts: doc.texts.map((x) => (x.id === it.id ? t : x)) };
          touched.add(it.id);
          changes.push({ kind: "CHANGED", id: it.id, text: `Changed text: “${t.text.slice(0, 50)}”` });
          return;
        }
        if (it.kind === "zoom") {
          if (op.amount) doc = { ...doc, zooms: doc.zooms.map((z) => (z.id === it.id ? { ...z, zoom: Math.min(1.6, op.amount!) } : z)) };
          changes.push({ kind: "CHANGED", id: it.id, text: `Changed the zoom${op.amount ? ` to ${Math.min(1.6, op.amount)}×` : ""}` });
          return;
        }
        if (op.volume) doc = { ...doc, sfx: doc.sfx.map((s) => (s.id === it.id ? { ...s, volume: op.volume! } : s)) };
        changes.push({ kind: "CHANGED", id: it.id, text: "Changed the sound" });
        return;
      }
    }
  });

  if (errors.length) return { ok: false, errors, repairMessage: directorRepairMessage(errors) };

  // ---- handovers: one graphic leaving as the next arrives (overlap < 0.4 s) ------------
  // A brief overlap is a hand-off, not "both on screen": the earlier one ends as the later one
  // starts, so neither has to dodge the other (and they never collide mid-transition).
  {
    const vs = [...doc.visuals].sort((a, b) => a.start - b.start);
    for (let i = 0; i < vs.length; i++) {
      for (let j = i + 1; j < vs.length; j++) {
        const a = vs[i]!;
        const b = vs[j]!;
        if (!touched.has(a.id) && !touched.has(b.id)) continue;
        const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
        if (overlap > 0 && overlap < 0.4 && a.end < b.end && b.start - a.start >= 0.8) {
          doc = { ...doc, visuals: doc.visuals.map((v) => (v.id === a.id ? { ...v, end: r3(b.start) } : v)) };
          vs[i] = { ...a, end: r3(b.start) };
          notes.push(`${describeVisual(a, presetOf.get(a.id))}: ends at ${fmtT(b.start)} as the next graphic comes in (hand-off)`);
        }
      }
    }
  }

  // ---- pass 2: placement (in time order, each solved around the face) ----------------
  if (toPlace.size) {
    const solved = solveVisualPlacements(doc, ctx.placement);
    const rects = new Map(solved.visuals.map((v) => [v.id, { rect: visualRect(v, canvas), v }]));
    const order = [...toPlace.keys()].sort((a, b) => (doc.visuals.find((v) => v.id === a)?.start ?? 0) - (doc.visuals.find((v) => v.id === b)?.start ?? 0));
    const placedNow = new Set<string>();
    for (const id of order) {
      const req = toPlace.get(id)!;
      const v = doc.visuals.find((x) => x.id === id);
      if (!v) continue;
      const others = [...rects.values()]
        .filter((o) => o.v.id !== id && (!toPlace.has(o.v.id) || placedNow.has(o.v.id)))
        .map((o) => ({ id: o.v.id, rect: o.rect, start: o.v.start, end: o.v.end, fullFrame: footprintOf(o.v.template, o.v.props).kind === "FULL_FRAME" }));
      let placement: TimelineVisual["placement"];
      let note: string | null = null;
      let usedRegion: DirectorRegion = req.region;
      if (req.explicit) {
        const trial: TimelineVisual = { ...v, placement: { mode: "MANUAL", ...req.explicit } };
        const obs = obstaclesForWindow(doc, id, v.start, v.end, others, { options: ctx.placement, measure: ctx.measure });
        const rect = visualRect(trial, canvas);
        if (obs.face && intersectionArea(rect, obs.face) > 0) {
          const cx = req.explicit.x;
          const cy = req.explicit.y;
          const faceCx = (obs.face.x + obs.face.width / 2) / canvas.width;
          const faceCy = (obs.face.y + obs.face.height / 2) / canvas.height;
          const rg: DirectorRegion = Math.abs(cx - faceCx) > Math.abs(cy - faceCy) * 0.6 ? (cx < faceCx ? "LEFT" : "RIGHT") : cy < faceCy ? "TOP" : "BOTTOM";
          const r = solveRegionPlacement(doc, v, rg, req.size, others, { options: ctx.placement, measure: ctx.measure });
          placement = { mode: "MANUAL", x: r.x, y: r.y, scale: r.scale };
          usedRegion = r.used;
          note = `the spot you gave covered your face — moved it ${REGION_WORD[r.used]}`;
        } else placement = { mode: "MANUAL", ...req.explicit };
      } else if (req.region === "AUTO" && !req.size) {
        placement = { ...v.placement, mode: "AUTO" };
      } else {
        const r = solveRegionPlacement(doc, v, req.region, req.size, others, { options: ctx.placement, measure: ctx.measure });
        placement = { mode: "MANUAL", x: r.x, y: r.y, scale: r.scale };
        usedRegion = r.used;
        note = r.note;
      }
      const next = { ...v, placement };
      doc = { ...doc, visuals: doc.visuals.map((x) => (x.id === id ? next : x)) };
      rects.set(id, { rect: visualRect(next, canvas), v: next });
      placedNow.add(id);
      if (!req.explicit) placements[id] = { region: req.region, size: req.size };
      const ch = changes.find((c) => c.id === id && (c.kind === "ADDED" || c.kind === "MOVED" || c.kind === "CHANGED"));
      if (ch && ch.kind === "ADDED") ch.text += ` (${req.explicit ? "your spot" : REGION_WORD[usedRegion]}${placement.mode === "MANUAL" && placement.scale < 0.95 ? `, ${Math.round(placement.scale * 100)}% size` : ""})`;
      if (note) notes.push(`${describeVisual(v, presetOf.get(id))}: ${note}`);
    }
  }
  // Graphics added without a region keep AUTO (the engine's own face/caption-aware solve).
  for (const c of changes) if (c.kind === "ADDED" && c.id && !toPlace.has(c.id) && doc.visuals.some((v) => v.id === c.id)) c.text += " (auto-placed around your face)";

  // ---- pass 3: cuts / trims (last; every time refers to the edit as it was) ----------
  if (deferred.length) {
    const ranges: Array<{ a: number; b: number; where: string }> = [];
    for (const { op, where } of deferred) {
      if (op.op === "cut") {
        const a = resolveTime(op.start, `${where} start`, null);
        const b = resolveTime(op.end, `${where} end`, null);
        if (a === null || b === null) continue;
        if (b - a < 0.1) {
          errors.push(`${where}: the cut ends before it starts`);
          continue;
        }
        ranges.push({ a, b, where });
      } else {
        const a = resolveTime(op.start, `${where} start`, 0) ?? 0;
        const b = resolveTime(op.end, `${where} end`, D) ?? D;
        if (b - a < 0.5) {
          errors.push(`${where}: would leave less than half a second`);
          continue;
        }
        if (b < D - 0.05) ranges.push({ a: b, b: D, where });
        if (a > 0.05) ranges.push({ a: 0, b: a, where });
      }
    }
    if (errors.length) return { ok: false, errors, repairMessage: directorRepairMessage(errors) };
    ranges.sort((x, y) => y.a - x.a);
    let total = 0;
    for (const r of ranges) {
      const res = cutRange(doc, r.a, r.b, (p) => newId(p));
      if (res.doc.clips.length === 0) {
        errors.push(`${r.where}: that would cut the whole video`);
        break;
      }
      doc = res.doc;
      total += r.b - r.a;
      for (const id of res.removed) delete placements[id];
      changes.push({ kind: "CUT", text: `Cut ${fmtT(r.a)}–${fmtT(r.b)}${res.removed.length ? ` (and ${res.removed.length} item${res.removed.length === 1 ? "" : "s"} that were only in that part)` : ""}` });
    }
    if (errors.length) return { ok: false, errors, repairMessage: directorRepairMessage(errors) };
    if (total > 0) notes.push(`The video is now ${fmtT(timelineDuration(doc))} long.`);
  }

  // ---- provenance --------------------------------------------------------------------
  const chrisNums = numbersInText(ctx.chrisText);
  const owner = (prev?.owner ?? []).filter((o) => doc.visuals.some((v) => v.id === o.visualId) && !touched.has(o.visualId));
  for (const v of doc.visuals) {
    if (!touched.has(v.id)) continue;
    const nums = visualShownNumbers(v.template, v.props as Record<string, unknown>);
    owner.push({
      visualId: v.id,
      propsHash: directorPropsHash(v.template, v.props),
      by: DIRECTOR_PROVENANCE,
      messageId: ctx.messageId,
      numbers: nums,
      chrisSaid: nums.filter((n) => chrisNums.some((c) => Math.abs(Math.abs(n) - c) < 0.01)),
    });
  }
  for (const id of Object.keys(refs)) if (!findItem(id)) delete refs[id];

  const noop = changes.every((c) => c.kind === "NOTE" || c.kind === "SKIPPED");
  return {
    ok: true,
    timeline: doc,
    changes,
    notes,
    record: { version: 1, refs, placements, owner, lastMessageId: ctx.messageId },
    noop,
  };
}

// ---------------------------------------------------------------------------------------
// text placement
// ---------------------------------------------------------------------------------------

function placeText(
  doc: EditTimeline,
  t: TimelineText,
  region: DirectorRegion,
  explicit: { x: number; y: number } | null,
  ctx: DirectorApplyContext,
): { text: TimelineText; used: DirectorRegion; note: string | null } {
  const canvas = doc.canvas;
  const W = canvas.width;
  const H = canvas.height;
  const area = directorPlacementArea(canvas);
  const safe = area.bounds;
  const others = doc.visuals.map((v) => ({ id: v.id, rect: visualRect(v, canvas), start: v.start, end: v.end, fullFrame: footprintOf(v.template, v.props).kind === "FULL_FRAME" }));
  const obs = obstaclesForWindow(doc, t.id, t.start, t.end, others, { options: ctx.placement, measure: ctx.measure });
  const hard = [...obs.hard, ...area.ui, ...(obs.face ? [obs.face] : [])];
  const clearOf = (cand: TimelineText) => {
    const r = textRectOf(cand, canvas, ctx.measure);
    if (r.y < safe.y || r.y + r.height > safe.y + safe.height || r.x < 0 || r.x + r.width > W) return false;
    return hard.every((o) => intersectionArea(r, o) === 0);
  };
  if (explicit) {
    const cand = { ...t, x: r3(explicit.x), y: r3(explicit.y) };
    if (clearOf(cand)) return { text: cand, used: "AUTO", note: null };
  }
  const face = obs.face;
  const faceTop = face ? face.y / H : 0.2;
  const faceBottom = face ? (face.y + face.height) / H : 0.45;
  const plan = (rg: DirectorRegion): Array<{ x: number; maxWidth: number; ys: number[] }> => {
    const ysDown = (from: number, to: number) => {
      const out: number[] = [];
      for (let y = from; y <= to; y += 0.01) out.push(r3(y));
      return out;
    };
    const ysUp = (from: number, to: number) => ysDown(to, from).reverse();
    const below = ysDown(faceBottom + 0.03, 0.86);
    const above = ysUp(0.08, faceTop - 0.03);
    const besideMid = face ? ysDown(faceTop, 0.86) : ysDown(0.3, 0.86);
    switch (rg) {
      case "TOP":
        return [{ x: 0.5, maxWidth: t.maxWidth, ys: above }];
      case "BOTTOM":
      case "AUTO":
      case "CENTER":
        return [{ x: 0.5, maxWidth: t.maxWidth, ys: rg === "CENTER" ? ysDown(0.45, 0.86) : below }];
      case "LEFT":
        return [0.28, 0.32, 0.36, 0.4].map((x) => ({ x, maxWidth: 0.44, ys: besideMid }));
      case "RIGHT":
        return [0.72, 0.68, 0.64, 0.6].map((x) => ({ x, maxWidth: 0.44, ys: besideMid }));
      case "TOP_LEFT":
        return [{ x: 0.3, maxWidth: 0.5, ys: above }];
      case "TOP_RIGHT":
        return [{ x: 0.7, maxWidth: 0.5, ys: above }];
      case "BOTTOM_LEFT":
        return [{ x: 0.3, maxWidth: 0.5, ys: below }];
      case "BOTTOM_RIGHT":
        return [{ x: 0.7, maxWidth: 0.5, ys: below }];
    }
  };
  const fallbacks: Record<DirectorRegion, DirectorRegion[]> = {
    LEFT: ["LEFT", "BOTTOM_LEFT", "BOTTOM", "TOP"],
    RIGHT: ["RIGHT", "BOTTOM_RIGHT", "BOTTOM", "TOP"],
    TOP: ["TOP", "BOTTOM"],
    BOTTOM: ["BOTTOM", "TOP"],
    CENTER: ["CENTER", "BOTTOM", "TOP"],
    AUTO: ["BOTTOM", "TOP", "CENTER"],
    TOP_LEFT: ["TOP_LEFT", "TOP", "BOTTOM_LEFT"],
    TOP_RIGHT: ["TOP_RIGHT", "TOP", "BOTTOM_RIGHT"],
    BOTTOM_LEFT: ["BOTTOM_LEFT", "BOTTOM", "LEFT"],
    BOTTOM_RIGHT: ["BOTTOM_RIGHT", "BOTTOM", "RIGHT"],
  };
  for (const scale of [1, 0.85, 0.72]) {
    for (const rg of fallbacks[region]) {
      for (const p of plan(rg)) {
        const ideal = rg.startsWith("TOP") ? (0.08 + faceTop) / 2 : rg === "LEFT" || rg === "RIGHT" ? (faceTop + faceBottom) / 2 + 0.1 : rg === "CENTER" ? 0.5 : 0.74;
        for (const y of [...p.ys].sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))) {
          const cand = { ...t, x: r3(p.x), y, maxWidth: p.maxWidth, fontSize: Math.round(t.fontSize * scale) };
          if (clearOf(cand)) {
            const notes: string[] = [];
            if (rg !== region && region !== "AUTO") notes.push(`no room ${REGION_WORD[region]} of your face — put it ${REGION_WORD[rg]}`);
            if (scale < 1) notes.push("made it a bit smaller to fit");
            return { text: cand, used: rg, note: notes.length ? notes.join("; ") : null };
          }
        }
      }
    }
  }
  return { text: { ...t, x: 0.5, y: 0.8 }, used: "BOTTOM", note: "no clear spot — put it near the bottom; check it" };
}
