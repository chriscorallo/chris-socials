import { PLACEMENT_SAFE_ZONE } from "../platform-profiles";
import type { SubjectTrack } from "../subject-track-core";
import type { EditTimeline } from "../timeline";
import { timelineDuration } from "../timeline";
import { layoutTimelineText, type MeasureText } from "../timeline-layout";
import { placementSafeArea, protectedFaceRect, subjectRegionsForWindow } from "../visual-placement";
import { faceOf, type Rect } from "./anchors";

/**
 * The free screen audit (gate G1, docs/PREMIUM_EDITOR_PLAN.md round 2): the orchestration rules
 * checked on the timeline that renders — nothing on the face core, one new thing per beat, the
 * hook text on screen by 1.5 s, no 7 s stretch with nothing changing, captions never louder than
 * the headline. A finding names the stage (SCREEN) and the element, so a fix can move or retime
 * it. No model call. PURE.
 */
export type ScreenFindingKind = "FACE_OVERLAP" | "TWO_LEADS" | "HOOK_TEXT_LATE" | "STATIC_STRETCH" | "CAPTION_LOUDER" | "ZOOM_DURING_GRAPHIC";

export interface ScreenFinding {
  kind: ScreenFindingKind;
  stage: "SCREEN";
  /** The text / zoom / visual id, or null for a stretch. */
  elementId: string | null;
  atS: number;
  detail: string;
}

export const SCREEN_AUDIT_THRESHOLDS = {
  /** Two entrances closer than this (and not at the same instant) compete. */
  leadGapS: 0.5,
  /** The hook text must be on screen by this time when a title exists. */
  hookByS: 1.5,
  /** A stretch with no change longer than this reads as dead. */
  staticS: 7,
} as const;

export interface ScreenAuditInput {
  mediaAssetId: string;
  subjectTrack?: SubjectTrack | null;
  sourceSize?: { width: number; height: number } | null;
  measure: MeasureText;
  /** True when the video is expected to open with a title (the Editor's cut, or a chosen title). */
  hookExpected: boolean;
  t?: typeof SCREEN_AUDIT_THRESHOLDS;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Every moment something new appears for the viewer (clip change, text, zoom, visual) and the
 * stretches between them. */
export function screenEvents(t: EditTimeline): { entrances: Array<{ at: number; lane: "CUT" | "TEXT" | "ZOOM" | "VISUAL"; id: string | null }>; stretches: Array<{ start: number; end: number; len: number }> } {
  const dur = timelineDuration(t);
  const entrances: Array<{ at: number; lane: "CUT" | "TEXT" | "ZOOM" | "VISUAL"; id: string | null }> = [];
  let acc = 0;
  t.clips.forEach((c, i) => {
    if (i > 0) entrances.push({ at: r3(acc), lane: "CUT", id: c.id });
    acc += c.sourceEnd - c.sourceStart;
  });
  for (const x of t.texts) entrances.push({ at: r3(x.start), lane: "TEXT", id: x.id });
  for (const z of t.zooms) entrances.push({ at: r3(z.start), lane: "ZOOM", id: z.id });
  for (const v of t.visuals) entrances.push({ at: r3(v.start), lane: "VISUAL", id: v.id });
  const points = new Set<number>([0, r3(dur)]);
  for (const e of entrances) points.add(e.at);
  for (const x of t.texts) points.add(r3(x.end));
  for (const z of t.zooms) points.add(r3(z.end));
  for (const v of t.visuals) points.add(r3(v.end));
  const pts = [...points].filter((x) => x >= 0 && x <= dur).sort((a, b) => a - b);
  const stretches: Array<{ start: number; end: number; len: number }> = [];
  for (let i = 1; i < pts.length; i++) stretches.push({ start: pts[i - 1]!, end: pts[i]!, len: r3(pts[i]! - pts[i - 1]!) });
  return { entrances: entrances.sort((a, b) => a.at - b.at), stretches };
}

export function auditScreen(timeline: EditTimeline, input: ScreenAuditInput): ScreenFinding[] {
  const t = input.t ?? SCREEN_AUDIT_THRESHOLDS;
  const out: ScreenFinding[] = [];
  const canvas = timeline.canvas;
  const safe = placementSafeArea(canvas, PLACEMENT_SAFE_ZONE);
  const opts = { subjectTracks: { [input.mediaAssetId]: input.subjectTrack ?? null }, sourceDimensions: { [input.mediaAssetId]: input.sourceSize ?? null } };
  const dur = timelineDuration(timeline);

  // 1. Nothing on the face core while it is up.
  for (const x of timeline.texts) {
    const subject = subjectRegionsForWindow(timeline, x.start, x.end, opts);
    if (!subject.head) continue;
    const core = subject.tracked ? protectedFaceRect(subject.head, safe) : faceOf(subject.head);
    let rect: Rect;
    try {
      rect = layoutTimelineText(x, canvas, input.measure).rect;
    } catch {
      continue;
    }
    if (overlaps(rect, core)) out.push({ kind: "FACE_OVERLAP", stage: "SCREEN", elementId: x.id, atS: r3(x.start), detail: `"${x.text.slice(0, 40)}" sits on the face from ${r3(x.start)}s` });
  }

  // 2. One new thing at a time: entrances of different lanes closer than leadGapS (a cut is not
  //    a lead; a title and a zoom at the same instant are one beat change).
  const { entrances, stretches } = screenEvents(timeline);
  const leads = entrances.filter((e) => e.lane !== "CUT");
  for (let i = 1; i < leads.length; i++) {
    const a = leads[i - 1]!;
    const b = leads[i]!;
    const gap = b.at - a.at;
    if (gap > 0.02 && gap < t.leadGapS && a.lane !== b.lane) {
      out.push({ kind: "TWO_LEADS", stage: "SCREEN", elementId: b.id, atS: b.at, detail: `${b.lane.toLowerCase()} ${b.id ?? ""} arrives ${Math.round(gap * 1000)} ms after ${a.lane.toLowerCase()} ${a.id ?? ""}` });
    }
  }
  // 2b. Never a zoom and a graphic building on the same beat.
  for (const z of timeline.zooms) {
    const v = timeline.visuals.find((v) => v.start < z.end && z.start < v.end);
    if (v) out.push({ kind: "ZOOM_DURING_GRAPHIC", stage: "SCREEN", elementId: z.id, atS: r3(z.start), detail: `zoom ${z.id} runs while graphic ${v.id} is up (${r3(Math.max(z.start, v.start))}s)` });
  }

  // 3. The hook text is on screen by hookByS.
  if (input.hookExpected && dur > t.hookByS) {
    const early = timeline.texts.some((x) => x.start <= t.hookByS && x.end > t.hookByS * 0.5);
    if (!early) out.push({ kind: "HOOK_TEXT_LATE", stage: "SCREEN", elementId: null, atS: 0, detail: `no title on screen by ${t.hookByS}s` });
  }

  // 4. No stretch longer than staticS with nothing changing.
  for (const s of stretches) {
    if (s.len > t.staticS) out.push({ kind: "STATIC_STRETCH", stage: "SCREEN", elementId: null, atS: s.start, detail: `${s.len.toFixed(1)} s with nothing changing from ${s.start}s` });
  }

  // 5. Captions never louder than the headline.
  if (timeline.captions.enabled && timeline.texts.length) {
    const smallest = Math.min(...timeline.texts.map((x) => x.fontSize));
    if (timeline.captions.fontSize > smallest) {
      out.push({ kind: "CAPTION_LOUDER", stage: "SCREEN", elementId: null, atS: 0, detail: `captions at ${timeline.captions.fontSize} px are bigger than a ${smallest} px headline` });
    }
  }
  return out;
}
