import {
  clipDuration,
  clipStartTimes,
  locateOutputTime,
  timelineDuration,
  GRADE_PRESET_VALUES,
  DEFAULT_TEXT_FONT_ID,
  type TimelineClip,
  type TimelineText,
  type TimelineZoom,
  type TimelineCaptions,
  type TimelineGrade,
  type GRADE_PRESETS,
} from "@chris/media/timeline";
import { MIN_ITEM_SECONDS, type EditorDoc } from "./types";

/**
 * Pure document operations for the finishing editor. Every function takes an EditorDoc and
 * returns a NEW one (never mutates), so the reducer's undo history is just a list of docs.
 * Overlay tracks (texts, zooms, captions) live on the OUTPUT timeline and are NOT linked to
 * clips: a ripple edit on the video track moves the video under them, and `normalizeDoc`
 * keeps them inside the new duration.
 */

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Durations of each source take, keyed by MediaAsset id — used to clamp trims. */
export type AssetDurations = Record<string, number>;

// ---------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------

function clampSpan<T extends { start: number; end: number }>(item: T, duration: number): T {
  const len = Math.max(MIN_ITEM_SECONDS, item.end - item.start);
  let start = Math.max(0, item.start);
  let end = start + len;
  if (end > duration) {
    end = duration;
    start = Math.max(0, end - Math.min(len, duration));
  }
  if (end - start < MIN_ITEM_SECONDS) end = Math.min(duration, start + MIN_ITEM_SECONDS);
  return start === item.start && end === item.end ? item : { ...item, start: r3(start), end: r3(end) };
}

/**
 * Keeps the doc valid against EditTimelineSchema's invariants and the editor's own rules:
 * clips inside their take and at least MIN_ITEM_SECONDS long (clips are contiguous by
 * construction — output order = array order), overlays and the cover inside the duration.
 */
export function normalizeDoc(doc: EditorDoc, durations: AssetDurations = {}): EditorDoc {
  const clips = doc.clips.map((c) => {
    const max = durations[c.mediaAssetId];
    let start = Math.max(0, c.sourceStart);
    let end = max != null && max > 0 ? Math.min(max, c.sourceEnd) : c.sourceEnd;
    if (end - start < MIN_ITEM_SECONDS) {
      if (max != null && start + MIN_ITEM_SECONDS > max) start = Math.max(0, max - MIN_ITEM_SECONDS);
      end = start + MIN_ITEM_SECONDS;
    }
    return start === c.sourceStart && end === c.sourceEnd ? c : { ...c, sourceStart: r3(start), sourceEnd: r3(end) };
  });
  const D = timelineDuration({ clips });
  const texts = doc.texts.map((t) => clampSpan(t, D));
  const zooms = doc.zooms.map((z) => clampSpan(z, D));
  let cover = doc.coverFrameSeconds;
  if (cover != null) cover = r3(clamp(cover, 0, Math.max(0, D - 0.04)));
  const changed =
    clips.some((c, i) => c !== doc.clips[i]) ||
    texts.some((t, i) => t !== doc.texts[i]) ||
    zooms.some((z, i) => z !== doc.zooms[i]) ||
    cover !== doc.coverFrameSeconds;
  if (!changed) return doc;
  return { ...doc, clips, texts, zooms, ...(cover !== undefined ? { coverFrameSeconds: cover } : {}) };
}

// ---------------------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------------------

export function clipIndexById(doc: EditorDoc, id: string): number {
  return doc.clips.findIndex((c) => c.id === id);
}

/** Splits the clip under output time `t`. No-op when `t` is within MIN_ITEM_SECONDS of an edge. */
export function splitAt(doc: EditorDoc, t: number): { doc: EditorDoc; newClipId: string | null } {
  const loc = locateOutputTime(doc, t);
  if (!loc) return { doc, newClipId: null };
  const clip = doc.clips[loc.clipIndex]!;
  const s = loc.sourceTime;
  if (s - clip.sourceStart < MIN_ITEM_SECONDS || clip.sourceEnd - s < MIN_ITEM_SECONDS) {
    return { doc, newClipId: null };
  }
  const left: TimelineClip = { ...clip, sourceEnd: r3(s) };
  const right: TimelineClip = { ...clip, id: newId("clip"), sourceStart: r3(s) };
  const clips = [...doc.clips];
  clips.splice(loc.clipIndex, 1, left, right);
  return { doc: { ...doc, clips }, newClipId: right.id };
}

/** Moves one edge of a clip (in SOURCE seconds), clamped to the take and a minimum length. */
export function trimClip(
  doc: EditorDoc,
  clipId: string,
  edge: "start" | "end",
  sourceValue: number,
  assetDuration?: number,
): EditorDoc {
  const i = clipIndexById(doc, clipId);
  if (i < 0) return doc;
  const c = doc.clips[i]!;
  const next =
    edge === "start"
      ? { ...c, sourceStart: r3(clamp(sourceValue, 0, c.sourceEnd - MIN_ITEM_SECONDS)) }
      : {
          ...c,
          sourceEnd: r3(
            clamp(sourceValue, c.sourceStart + MIN_ITEM_SECONDS, assetDuration && assetDuration > 0 ? assetDuration : Infinity),
          ),
        };
  const clips = [...doc.clips];
  clips[i] = next;
  return { ...doc, clips };
}

/** Reorders: moves the clip at `from` so it ends up at index `to` (in the resulting array). */
export function moveClip(doc: EditorDoc, from: number, to: number): EditorDoc {
  if (from === to || from < 0 || from >= doc.clips.length) return doc;
  const clips = [...doc.clips];
  const [c] = clips.splice(from, 1);
  clips.splice(clamp(to, 0, clips.length), 0, c!);
  return { ...doc, clips };
}

/** Ripple delete — later clips close the gap. The last remaining clip can't be deleted. */
export function deleteClip(doc: EditorDoc, clipId: string): EditorDoc {
  if (doc.clips.length <= 1) return doc;
  const clips = doc.clips.filter((c) => c.id !== clipId);
  return clips.length === doc.clips.length ? doc : { ...doc, clips };
}

export function duplicateClip(doc: EditorDoc, clipId: string): { doc: EditorDoc; newClipId: string | null } {
  const i = clipIndexById(doc, clipId);
  if (i < 0) return { doc, newClipId: null };
  const copy = { ...doc.clips[i]!, id: newId("clip") };
  const clips = [...doc.clips];
  clips.splice(i + 1, 0, copy);
  return { doc: { ...doc, clips }, newClipId: copy.id };
}

export function insertClip(
  doc: EditorDoc,
  index: number,
  clip: { mediaAssetId: string; sourceStart: number; sourceEnd: number },
): { doc: EditorDoc; newClipId: string } {
  const c: TimelineClip = {
    id: newId("clip"),
    mediaAssetId: clip.mediaAssetId,
    sourceStart: r3(clip.sourceStart),
    sourceEnd: r3(clip.sourceEnd),
    crop: { zoom: 1, panX: 0, panY: 0 },
    volume: 1,
  };
  const clips = [...doc.clips];
  clips.splice(clamp(index, 0, clips.length), 0, c);
  return { doc: { ...doc, clips }, newClipId: c.id };
}

/** Index a new clip should be inserted at so it lands right after the clip under `t`. */
export function insertionIndexAt(doc: EditorDoc, t: number): number {
  const starts = clipStartTimes(doc);
  for (let i = 0; i < doc.clips.length; i++) {
    const mid = starts[i]! + clipDuration(doc.clips[i]!) / 2;
    if (t < mid) return i;
  }
  return doc.clips.length;
}

export function updateClip(doc: EditorDoc, clipId: string, patch: Partial<Omit<TimelineClip, "id">>): EditorDoc {
  return { ...doc, clips: doc.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) };
}

/** Swaps a clip to another take, keeping its in/out when they fit (else clamping). */
export function switchClipSource(doc: EditorDoc, clipId: string, mediaAssetId: string, assetDuration: number): EditorDoc {
  const c = doc.clips.find((x) => x.id === clipId);
  if (!c) return doc;
  const len = clipDuration(c);
  let start = Math.min(c.sourceStart, Math.max(0, assetDuration - len));
  const end = Math.min(assetDuration, start + len);
  if (end - start < MIN_ITEM_SECONDS) start = Math.max(0, end - MIN_ITEM_SECONDS);
  return updateClip(doc, clipId, { mediaAssetId, sourceStart: r3(start), sourceEnd: r3(end) });
}

// ---------------------------------------------------------------------------------------
// Texts / zooms
// ---------------------------------------------------------------------------------------

export function addText(doc: EditorDoc, at: number, partial: Partial<TimelineText> = {}): { doc: EditorDoc; id: string } {
  const D = timelineDuration(doc);
  const start = r3(clamp(at, 0, Math.max(0, D - MIN_ITEM_SECONDS)));
  const t: TimelineText = {
    id: newId("text"),
    text: "Your text",
    start,
    end: r3(Math.min(D, start + 2.5)),
    preset: "CUSTOM",
    fontId: DEFAULT_TEXT_FONT_ID,
    fontSize: 72,
    color: "#FFFFFF",
    backgroundColor: null,
    strokeColor: "#000000",
    align: "center",
    x: 0.5,
    y: 0.3,
    maxWidth: 0.84,
    uppercase: false,
    ...partial,
  };
  return { doc: { ...doc, texts: [...doc.texts, t] }, id: t.id };
}

export function updateText(doc: EditorDoc, id: string, patch: Partial<Omit<TimelineText, "id">>): EditorDoc {
  return { ...doc, texts: doc.texts.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

export function deleteText(doc: EditorDoc, id: string): EditorDoc {
  return { ...doc, texts: doc.texts.filter((t) => t.id !== id) };
}

export function duplicateText(doc: EditorDoc, id: string): { doc: EditorDoc; id: string | null } {
  const t = doc.texts.find((x) => x.id === id);
  if (!t) return { doc, id: null };
  const copy = { ...t, id: newId("text"), y: clamp(t.y + 0.06, 0, 1) };
  return { doc: { ...doc, texts: [...doc.texts, copy] }, id: copy.id };
}

export function addZoom(doc: EditorDoc, at: number): { doc: EditorDoc; id: string } {
  const D = timelineDuration(doc);
  const start = r3(clamp(at, 0, Math.max(0, D - MIN_ITEM_SECONDS)));
  const z: TimelineZoom = {
    id: newId("zoom"),
    start,
    end: r3(Math.min(D, start + 1.5)),
    zoom: 1.2,
    x: 0.5,
    y: 0.4,
    mode: "CUT",
    easeSeconds: 0.4,
  };
  return { doc: { ...doc, zooms: [...doc.zooms, z] }, id: z.id };
}

export function updateZoom(doc: EditorDoc, id: string, patch: Partial<Omit<TimelineZoom, "id">>): EditorDoc {
  return { ...doc, zooms: doc.zooms.map((z) => (z.id === id ? { ...z, ...patch } : z)) };
}

export function deleteZoom(doc: EditorDoc, id: string): EditorDoc {
  return { ...doc, zooms: doc.zooms.filter((z) => z.id !== id) };
}

/** Moves a text/zoom in time keeping its length (clamped to the timeline). */
export function moveSpan<T extends { start: number; end: number }>(item: T, newStart: number, duration: number): T {
  const len = item.end - item.start;
  const start = clamp(newStart, 0, Math.max(0, duration - len));
  return { ...item, start: r3(start), end: r3(start + len) };
}

/** Trims one edge of a text/zoom span (output seconds), keeping MIN_ITEM_SECONDS. */
export function trimSpan<T extends { start: number; end: number }>(item: T, edge: "start" | "end", value: number, duration: number): T {
  if (edge === "start") return { ...item, start: r3(clamp(value, 0, item.end - MIN_ITEM_SECONDS)) };
  return { ...item, end: r3(clamp(value, item.start + MIN_ITEM_SECONDS, duration)) };
}

// ---------------------------------------------------------------------------------------
// Captions / grade / cover
// ---------------------------------------------------------------------------------------

export function updateCaptions(doc: EditorDoc, patch: Partial<TimelineCaptions>): EditorDoc {
  return { ...doc, captions: { ...doc.captions, ...patch } };
}

/** Sets (or with `null`, clears) a caption word correction. `""` hides the word. */
export function setWordEdit(doc: EditorDoc, key: string, value: string | null): EditorDoc {
  const wordEdits = { ...doc.captions.wordEdits };
  if (value === null) delete wordEdits[key];
  else wordEdits[key] = value;
  return { ...doc, captions: { ...doc.captions, wordEdits } };
}

/** Picking a look writes its concrete values (GRADE_PRESET_VALUES) — the sliders then start there. */
export function applyGradePreset(doc: EditorDoc, preset: (typeof GRADE_PRESETS)[number]): EditorDoc {
  return { ...doc, grade: { preset, ...GRADE_PRESET_VALUES[preset] } };
}

export function updateGrade(doc: EditorDoc, patch: Partial<Omit<TimelineGrade, "preset">>): EditorDoc {
  return { ...doc, grade: { ...doc.grade, ...patch } };
}

export function setCover(doc: EditorDoc, seconds: number | null): EditorDoc {
  return { ...doc, coverFrameSeconds: seconds == null ? null : r3(Math.max(0, seconds)) };
}
