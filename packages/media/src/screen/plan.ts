import type { SubjectTrack } from "../subject-track-core";
import { subjectBoxAt } from "../subject-track-core";
import { EditTimelineSchema, locateOutputTime, timelineDuration, type CaptionChunkWindow, type EditTimeline, type TimelineText, type TimelineZoom } from "../timeline";
import type { MeasureText } from "../timeline-layout";
import { mapSourceBoxToCanvas } from "../visual-placement";
import { resolveScreenAnchors, type HeadlineAnchor, type Rect, type ScreenAnchors } from "./anchors";
import { screenEvents } from "./audit";

/**
 * The Screen Orchestrator (docs/PREMIUM_EDITOR_PLAN.md round 5; built 2026-10-21): one editor
 * owns the whole screen. Five lanes on one clock — HEADLINE, GRAPHIC, CAPTION, ZOOM, FACE — with
 * fixed anchors, one NEW thing per beat (a graphic may build under a headline that is already
 * held: the references stack that way), headlines that arrive on the first word of their idea
 * and leave on its last, adaptive captions as support, zooms in-hold-out on beat boundaries and
 * the Editor's emphasis words, and a chosen cover frame. Deterministic; identical in preview and
 * render because it only writes the timeline. The Editor decides WHAT each beat needs; the Motion
 * Designer fills graphic content into the slot opened here; this module decides where, when, how
 * long and how it moves. PURE.
 */
export interface ScreenWord {
  word: string;
  /** Output seconds. */
  start: number;
  end: number;
}

export interface ScreenBeat {
  index: number;
  role: string;
  headline: string | null;
  viewerNeeds: string | null;
  sentenceIds: number[];
  /** Output seconds (first word start → last word end). */
  start: number;
  end: number;
  words: ScreenWord[];
  /** The Editor's emphasis words in this beat (as he said them). */
  emphasis: string[];
  /** A spoken amount in the beat (captions go phrase-wise; the headline carries the number). */
  hasAmount: boolean;
}

export interface ScreenStyle {
  zoomAmount: number;
  zoomEaseInS: number;
  zoomEaseOutS: number;
  /** Longest hold before a zoom eases back out on its own. */
  zoomMaxHoldS: number;
  headlineFontSize: number;
  titleFontSize: number;
  captionFontSize: number;
  captionPreset: EditTimeline["captions"]["preset"];
  /** HELD_HEADLINE: a graphic may build under a headline that arrived ≥ leadGapS earlier
   * (the reference reel's pattern). NONE: strictly one entrance per beat. */
  stacking: "NONE" | "HELD_HEADLINE";
  /** Entrances in one beat are at least this far apart. */
  leadGapS: number;
  /** Nothing changes for longer than this → the cheapest lead (a zoom) is added. */
  maxStaticS: number;
  headlineFadeInS: number;
  headlineFadeOutS: number;
  /** A headline shorter than this is not shown (the beat is a flash). */
  minHeadlineS: number;
}

export const DEFAULT_SCREEN_STYLE: ScreenStyle = {
  zoomAmount: 1.08,
  zoomEaseInS: 0.4,
  zoomEaseOutS: 0.4,
  zoomMaxHoldS: 6,
  headlineFontSize: 60,
  titleFontSize: 72,
  captionFontSize: 44,
  captionPreset: "QUIET",
  stacking: "HELD_HEADLINE",
  leadGapS: 0.6,
  maxStaticS: 5,
  headlineFadeInS: 0.2,
  headlineFadeOutS: 0.12,
  minHeadlineS: 1.4,
};

/** The StyleModel's bands as the orchestrator's presets (structural type: @chris/domain's
 * StyleModel, without importing it). The references move the look inside their band; the
 * rules (one new thing per beat, never the face) never move. */
export interface StyleModelLike {
  captions?: { preset: "ONE_WORD" | "PHRASE" | "NONE" | null; wordsPerChunk?: { p50: number } | null } | null;
  headlineHoldS?: { p25: number; p50: number; p75: number } | null;
  zoomAmount?: { p25: number; p50: number; p75: number } | null;
  zoomsPer10s?: { p50: number } | null;
  zoomInOutShare?: number | null;
  headlinesPer10s?: { p25: number; p75: number } | null;
  referenceCount?: number;
}

export function screenStyleFromStyleModel(m: StyleModelLike | null | undefined): Partial<ScreenStyle> {
  if (!m || !(m.referenceCount ?? 0)) return {};
  const out: Partial<ScreenStyle> = {};
  if (m.zoomAmount) out.zoomAmount = Math.min(1.15, Math.max(1.04, m.zoomAmount.p50));
  if (m.headlineHoldS) out.minHeadlineS = Math.min(2, Math.max(1, m.headlineHoldS.p25 * 0.6));
  if (m.zoomsPer10s && m.zoomsPer10s.p50 === 0) out.maxStaticS = 8; // they don't punch in: let the face hold longer
  if (m.captions?.preset === "NONE") out.captionPreset = "QUIET"; // captions stay (accessibility); quiet
  return out;
}

/** Caption chunk size per beat, nudged by the references: one-word captioners get one word on
 * every short line, phrase captioners get phrases everywhere amounts are not the issue. */
export function captionDefaultsFromStyleModel(m: StyleModelLike | null | undefined): { shortLineWords: number; defaultWords: number } {
  if (m?.captions?.preset === "ONE_WORD") return { shortLineWords: 1, defaultWords: 1 };
  if (m?.captions?.preset === "PHRASE") return { shortLineWords: 2, defaultWords: Math.min(3, Math.max(2, Math.round(m.captions.wordsPerChunk?.p50 ?? 2))) };
  return { shortLineWords: 1, defaultWords: 2 };
}

export interface ScreenInput {
  /** Clips, canvas and the base caption look; texts / zooms are written by the plan. */
  timeline: EditTimeline;
  mediaAssetId: string;
  subjectTrack?: SubjectTrack | null;
  sourceSize?: { width: number; height: number } | null;
  measure: MeasureText;
  /** The Editor's beats with output timing, the hook beat first. */
  beats: ScreenBeat[];
  /** The hook title (covers the hook beat); null = no title. */
  title: string | null;
  /** Output time the hook beat ends. */
  hookEnd: number;
  pacing: "LONG_SHOTS_ZOOMS" | "TIGHT_CUTS";
  style?: Partial<ScreenStyle>;
  /** The references' caption habit (captionDefaultsFromStyleModel); default = one word on short
   * emotional lines, two otherwise, three where amounts are spoken. */
  captionDefaults?: { shortLineWords: number; defaultWords: number };
}

export type ScreenLead = "HEADLINE" | "GRAPHIC" | "ZOOM" | "FACE";

export interface ScreenHeadline {
  id: string;
  beatIndex: number;
  text: string;
  start: number;
  end: number;
}

export interface GraphicSlot {
  beatIndex: number;
  need: string;
  start: number;
  end: number;
  /** Where it should build (canvas px), or null = wherever the placement solver finds clear. */
  rect: Rect | null;
}

export interface ScreenZoom {
  id: string;
  beatIndex: number | null;
  start: number;
  end: number;
  zoom: number;
  x: number;
  y: number;
  reason: "BOUNDARY" | "EMPHASIS" | "STATIC";
  word: string | null;
}

export interface ScreenPlan {
  anchors: ScreenAnchors;
  style: ScreenStyle;
  title: ScreenHeadline | null;
  headlines: ScreenHeadline[];
  slots: GraphicSlot[];
  /** Beats the face carries alone (no graphic, no zoom unless the Editor marked emphasis). */
  faceBeats: number[];
  leads: Array<{ beatIndex: number; lead: ScreenLead; at: number }>;
  captions: { preset: EditTimeline["captions"]["preset"]; fontSize: number; y: number; maxWordsPerChunk: number; chunking: CaptionChunkWindow[] };
  zooms: ScreenZoom[];
  coverFrameSeconds: number | null;
  notes: string[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const bare = (w: string) => w.toLowerCase().replace(/[^a-z0-9$%.,]/g, "").replace(/[.,]+$/, "");

/** Caption chunk size for a beat: one word for a short emotional line, phrases where amounts
 * are spoken, two words otherwise. */
export function captionWindowFor(beat: ScreenBeat, defaults: { shortLineWords: number; defaultWords: number } = { shortLineWords: 1, defaultWords: 2 }): number {
  if (beat.hasAmount) return 3;
  const text = beat.words.map((w) => w.word).join(" ");
  const short = beat.words.length <= 7;
  const emotional = /[!?]\s*$/.test(text.trim()) || beat.role === "HOOK" || beat.role === "TURN" || beat.role === "ENDING";
  if (short && emotional) return defaults.shortLineWords;
  return defaults.defaultWords;
}

/** The cover frame: inside the hook beat, once the title has settled, the middle of the longest
 * gap between words (a calm face, mouth closed) — else the middle of the hook beat. */
export function chooseCoverFrame(beat: ScreenBeat | null, titleStart: number, hookEnd: number): number | null {
  if (!beat) return null;
  const from = titleStart + 0.3;
  const to = Math.max(from + 0.2, hookEnd);
  const words = beat.words.filter((w) => w.end > from && w.start < to);
  let best: { at: number; len: number } | null = null;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i]!.start - words[i - 1]!.end;
    if (gap >= 0.15 && (!best || gap > best.len)) best = { at: (words[i]!.start + words[i - 1]!.end) / 2, len: gap };
  }
  if (best) return r3(best.at);
  return r3(Math.min(to, Math.max(from, (from + to) / 2)));
}

function headlineText(anchor: HeadlineAnchor, id: string, text: string, start: number, end: number, style: ScreenStyle): TimelineText {
  return {
    id,
    text,
    start: r3(start),
    end: r3(end),
    preset: "HEADLINE",
    fontId: "inter-display-extrabold",
    fontSize: anchor.fontSize,
    color: "#FFFFFF",
    backgroundColor: "#000000B3",
    strokeColor: null,
    align: anchor.align,
    x: anchor.x,
    y: anchor.y,
    maxWidth: anchor.maxWidth,
    uppercase: true,
    anchor: anchor.zone,
    fadeIn: style.headlineFadeInS,
    fadeOut: style.headlineFadeOutS,
  };
}

/**
 * Phase 1 — before graphics are chosen: anchors, the headline lane (title + beat headlines on
 * their words), the caption lane, the graphic slots and the face beats. Returns the plan with
 * `zooms` empty; `planZooms` fills them once the graphics are placed.
 */
export function planScreen(input: ScreenInput): ScreenPlan {
  const style: ScreenStyle = { ...DEFAULT_SCREEN_STYLE, ...(input.style ?? {}) };
  const notes: string[] = [];
  const dur = timelineDuration(input.timeline);
  const beats = input.beats;
  const anchors = resolveScreenAnchors({
    timeline: input.timeline,
    mediaAssetId: input.mediaAssetId,
    subjectTrack: input.subjectTrack,
    sourceSize: input.sourceSize,
    measure: input.measure,
    headlines: beats.map((b) => b.headline ?? "").filter(Boolean),
    title: input.title,
    hookEnd: input.hookEnd,
    headlineFontSize: style.headlineFontSize,
    titleFontSize: style.titleFontSize,
    captionFontSize: style.captionFontSize,
  });
  notes.push(...anchors.notes);

  // ---- HEADLINE lane: the title covers the hook beat; each later idea's headline arrives on its
  // first word and leaves on its last (+0.2 s); consecutive identical headlines are one.
  const headlines: ScreenHeadline[] = [];
  const leads: ScreenPlan["leads"] = [];
  let title: ScreenHeadline | null = null;
  const hookBeat = beats[0] ?? null;
  if (input.title && anchors.title) {
    const end = Math.min(dur, Math.max(1.6, input.hookEnd + 0.2));
    title = { id: "fe-hook-title", beatIndex: 0, text: input.title, start: 0, end: r3(end) };
    leads.push({ beatIndex: 0, lead: "HEADLINE", at: 0 });
  }
  if (anchors.headline) {
    for (let i = 1; i < beats.length; i++) {
      const b = beats[i]!;
      if (!b.headline || !b.words.length) continue;
      const prev = headlines[headlines.length - 1];
      const start = Math.max(0, b.words[0]!.start - 0.05);
      const end = Math.min(dur, b.words[b.words.length - 1]!.end + 0.2);
      if (prev && prev.text === b.headline && start - prev.end < 1.5) {
        prev.end = r3(end);
        continue;
      }
      if (end - start < style.minHeadlineS) {
        notes.push(`beat ${i} ("${b.headline}") is ${(end - start).toFixed(1)} s — too short to hold a headline`);
        continue;
      }
      headlines.push({ id: `fe-beat-${i}`, beatIndex: i, text: b.headline, start: r3(start), end: r3(end) });
      leads.push({ beatIndex: i, lead: "HEADLINE", at: r3(start) });
    }
    // Exits never overlap entrances: the previous headline (or the title) leaves 0.1 s before
    // the next arrives.
    const all = [...(title ? [title] : []), ...headlines];
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1]!;
      const b = all[i]!;
      if (a.end > b.start - 0.1) a.end = r3(Math.max(a.start + 0.3, b.start - 0.1));
    }
  }

  // ---- GRAPHIC slots + FACE beats: a slot where the Editor named a need (never on the ending);
  // under a held headline it waits leadGapS after the headline arrived.
  const slots: GraphicSlot[] = [];
  const faceBeats: number[] = [];
  beats.forEach((b, i) => {
    if (b.role === "ENDING") {
      faceBeats.push(i);
      if (!leads.some((l) => l.beatIndex === i)) leads.push({ beatIndex: i, lead: "FACE", at: r3(b.start) });
      return;
    }
    if (!b.viewerNeeds) return;
    if (b.end - b.start < 1.5) {
      notes.push(`beat ${i}: too short (${(b.end - b.start).toFixed(1)} s) for the graphic it asked for`);
      return;
    }
    const headlineAt = leads.find((l) => l.beatIndex === i && l.lead === "HEADLINE")?.at ?? null;
    if (headlineAt != null && style.stacking === "NONE") {
      notes.push(`beat ${i}: headline is the lead — graphic skipped (stacking off)`);
      return;
    }
    const start = r3(headlineAt != null ? Math.max(b.start, headlineAt + style.leadGapS) : b.start + 0.1);
    if (b.end - start < 1.2) return;
    slots.push({ beatIndex: i, need: b.viewerNeeds, start, end: r3(b.end), rect: anchors.graphic });
    leads.push({ beatIndex: i, lead: "GRAPHIC", at: start });
  });

  // ---- CAPTION lane: quiet support at one spot near the speaker; chunk size per beat.
  const chunking: CaptionChunkWindow[] = [];
  for (const b of beats) {
    if (!b.words.length) continue;
    const maxWords = captionWindowFor(b, input.captionDefaults);
    const start = r3(b.words[0]!.start);
    const end = r3(Math.min(dur, b.words[b.words.length - 1]!.end + 0.01));
    const prev = chunking[chunking.length - 1];
    if (prev && prev.maxWords === maxWords && start - prev.end < 0.5) prev.end = end;
    else if (end > start) chunking.push({ start, end, maxWords });
  }
  const captions = { preset: style.captionPreset, fontSize: style.captionFontSize, y: anchors.caption.y, maxWordsPerChunk: input.captionDefaults?.defaultWords ?? 2, chunking };

  const coverFrameSeconds = chooseCoverFrame(hookBeat, title ? title.start : 0, input.hookEnd);
  return { anchors, style, title, headlines, slots, faceBeats, leads: leads.sort((a, b) => a.at - b.at), captions, zooms: [], coverFrameSeconds, notes };
}

function headCentreAt(input: ScreenInput, timeline: EditTimeline, t: number): { x: number; y: number } | null {
  if (!input.subjectTrack?.length) return null;
  const loc = locateOutputTime(timeline, t);
  if (!loc) return null;
  const clip = timeline.clips[loc.clipIndex]!;
  const box = subjectBoxAt(input.subjectTrack, loc.sourceTime);
  if (!box) return null;
  const r = mapSourceBoxToCanvas(box, input.sourceSize ?? timeline.canvas, timeline.canvas, clip.crop, { zoom: 1, x: 0.5, y: 0.5 });
  if (!r) return null;
  return { x: r3((r.x + r.width / 2) / timeline.canvas.width), y: r3((r.y + r.height / 2) / timeline.canvas.height) };
}

/**
 * Phase 2 — after the graphics are placed: the ZOOM lane. In-hold-out punch-ins on the Editor's
 * emphasis words, at idea boundaries (alternating wide/tight on a continuous take), never on a
 * beat with a graphic, never two leads closer than leadGapS; then a zoom wherever nothing has
 * changed for longer than maxStaticS. Returns the zooms and the plan with them.
 */
export function planZooms(plan: ScreenPlan, timeline: EditTimeline, input: ScreenInput): ScreenPlan {
  const style = plan.style;
  const dur = timelineDuration(timeline);
  const zooms: ScreenZoom[] = [];
  const notes = [...plan.notes];
  const leads = [...plan.leads];
  const graphicWindows = timeline.visuals.map((v) => ({ start: v.start, end: v.end }));
  const freeOfGraphics = (s: number, e: number) => !graphicWindows.some((g) => g.start < e + 0.3 && s < g.end + 0.3);
  const freeOfZooms = (s: number, e: number) => !zooms.some((z) => z.start < e + 0.5 && s < z.end + 0.5);
  const focal = (t: number) => headCentreAt(input, timeline, t) ?? { x: 0.5, y: 0.4 };
  const entrancesIn = (i: number) => leads.filter((l) => l.beatIndex === i && l.lead !== "FACE").map((l) => l.at);
  const push = (z: Omit<ScreenZoom, "id">) => {
    const id = `fe-z-${zooms.length + 1}`;
    zooms.push({ ...z, id, start: r3(z.start), end: r3(z.end) });
    leads.push({ beatIndex: z.beatIndex ?? -1, lead: "ZOOM", at: r3(z.start) });
  };

  if (input.pacing === "LONG_SHOTS_ZOOMS") {
    let prevTight = false;
    input.beats.forEach((b, i) => {
      const len = b.end - b.start;
      const hasSlot = plan.slots.some((s) => s.beatIndex === i);
      if (hasSlot || !freeOfGraphics(b.start, b.end)) {
        prevTight = false;
        return;
      }
      // Emphasis: the punch lands on the word.
      const emph = b.emphasis.map(bare).filter(Boolean);
      const word = emph.length ? b.words.find((w) => emph.includes(bare(w.word))) ?? null : null;
      if (word) {
        const other = entrancesIn(i);
        let start = word.start;
        // The headline arrived at the beat start: a punch within leadGapS of it is the same beat
        // change (one lead); otherwise it waits its gap.
        const near = other.find((at) => Math.abs(at - start) < style.leadGapS && at !== start);
        if (near != null) start = Math.abs(near - b.start) < 0.1 && start - near < style.leadGapS ? near : near + style.leadGapS;
        const end = Math.min(dur, b.end + 0.1, start + style.zoomMaxHoldS);
        if (end - start >= 1.2 && freeOfZooms(start, end)) {
          const f = focal(start);
          push({ beatIndex: i, start, end, zoom: style.zoomAmount, x: f.x, y: f.y, reason: "EMPHASIS", word: word.word });
          prevTight = true;
          return;
        }
      }
      // Boundary: alternate wide / tight across ideas on a continuous take (not the hook, not
      // the face beats unless marked).
      if (i > 0 && !prevTight && len >= 2 && !plan.faceBeats.includes(i)) {
        // The punch and the headline change are ONE beat change: same instant.
        const start = leads.find((l) => l.beatIndex === i && l.lead === "HEADLINE")?.at ?? b.start;
        const end = Math.min(dur, b.end + 0.1, start + style.zoomMaxHoldS);
        if (end - start >= 1.5 && freeOfZooms(start, end)) {
          const f = focal(start);
          push({ beatIndex: i, start, end, zoom: style.zoomAmount, x: f.x, y: f.y, reason: "BOUNDARY", word: null });
          prevTight = true;
          return;
        }
      }
      prevTight = false;
    });
  }

  // Nothing changes for longer than maxStaticS → the cheapest lead, a slow push-in, never a graphic.
  let withZooms = EditTimelineSchema.parse({ ...timeline, zooms: toTimelineZooms(zooms, style) });
  for (let iter = 0; iter < 6; iter++) {
    const worst = screenEvents(withZooms).stretches.filter((s) => s.len > style.maxStaticS).sort((a, b) => b.len - a.len)[0];
    if (!worst) break;
    // The push-in lands a third of the way into the stretch (never on its first second, never
    // in a rhythm), and a beat gets at most one of them.
    const start = worst.start + Math.min(3, worst.len / 3);
    const end = Math.min(worst.end - 0.2, start + Math.min(style.zoomMaxHoldS, 4));
    const beat = input.beats.findIndex((b) => b.start <= start && start < b.end);
    if (end - start < 1.5 || !freeOfGraphics(start, end) || !freeOfZooms(start, end) || (beat >= 0 && zooms.some((z) => z.beatIndex === beat && z.reason === "STATIC"))) {
      notes.push(`${worst.len.toFixed(1)} s with nothing changing from ${worst.start}s — left to the face`);
      break;
    }
    const f = focal(start);
    push({ beatIndex: beat >= 0 ? beat : null, start, end, zoom: style.zoomAmount, x: f.x, y: f.y, reason: "STATIC", word: null });
    withZooms = EditTimelineSchema.parse({ ...timeline, zooms: toTimelineZooms(zooms, style) });
  }
  return { ...plan, zooms: zooms.sort((a, b) => a.start - b.start), leads: leads.sort((a, b) => a.at - b.at), notes };
}

export function toTimelineZooms(zooms: ScreenZoom[], style: ScreenStyle): TimelineZoom[] {
  return zooms.map((z) => ({ id: z.id, start: z.start, end: z.end, zoom: z.zoom, x: z.x, y: z.y, mode: "EASE" as const, easeSeconds: style.zoomEaseInS, easeOutSeconds: Math.min(style.zoomEaseOutS, Math.max(0, (z.end - z.start) / 2)) }));
}

/** Writes the headline lane, the caption lane and the cover frame onto the timeline (zooms via
 * `toTimelineZooms` once planned). Existing texts with other ids are kept. */
export function applyScreenPlan(timeline: EditTimeline, plan: ScreenPlan): EditTimeline {
  const texts: TimelineText[] = [];
  if (plan.title && plan.anchors.title) texts.push(headlineText(plan.anchors.title, plan.title.id, plan.title.text, plan.title.start, plan.title.end, plan.style));
  if (plan.anchors.headline) for (const h of plan.headlines) texts.push(headlineText(plan.anchors.headline, h.id, h.text, h.start, h.end, plan.style));
  const ids = new Set(texts.map((t) => t.id));
  return EditTimelineSchema.parse({
    ...timeline,
    texts: [...texts, ...timeline.texts.filter((t) => !ids.has(t.id) && !t.id.startsWith("fe-beat-") && t.id !== "fe-hook-title")],
    captions: { ...timeline.captions, preset: plan.captions.preset, fontSize: plan.captions.fontSize, y: plan.captions.y, maxWordsPerChunk: plan.captions.maxWordsPerChunk, chunking: plan.captions.chunking, backgroundColor: null },
    zooms: toTimelineZooms(plan.zooms, plan.style),
    coverFrameSeconds: plan.coverFrameSeconds,
  });
}
