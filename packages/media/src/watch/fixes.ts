import { z } from "zod";
import { EditTimelineSchema, type EditTimeline } from "../timeline";

/**
 * Typed fixes (docs/PREMIUM_EDITOR_PLAN.md round 2): the watch-back names at most five
 * machine-applicable operations, never prose. SCREEN and SPLICE fixes are applied here to the
 * timeline, deterministically and bounded; EDITOR fixes are returned as Full-edit choices for
 * the cut to be re-made (the caller re-cuts). PURE.
 */
export const WatchFixSchema = z.discriminatedUnion("stage", [
  z.object({
    stage: z.literal("EDITOR"),
    op: z.enum(["DROP_LINE", "RESTORE_LINE", "MOVE_ENDING"]),
    sentenceId: z.number().int(),
    why: z.string(),
  }),
  z.object({
    stage: z.literal("SCREEN"),
    op: z.enum(["MOVE", "SHRINK", "DROP", "RETIME"]),
    /** A text id (fe-hook-title, fe-beat-N), a visual id or a zoom id. */
    elementId: z.string().min(1),
    /** MOVE: the zone to move to. */
    to: z.enum(["TOP", "SIDE_L", "SIDE_R", "NEAR_SPEAKER"]).nullable().optional(),
    /** RETIME: seconds to shift start and end by (±3 s max). */
    deltaS: z.number().min(-3).max(3).nullable().optional(),
    why: z.string(),
  }),
  z.object({
    stage: z.literal("SPLICE"),
    op: z.literal("RETIME"),
    /** The cut between clip `cutIndex` and `cutIndex + 1`. */
    cutIndex: z.number().int().nonnegative(),
    /** Milliseconds: negative = tighten (cut-out earlier / cut-in later), positive = loosen. */
    deltaMs: z.number().int().min(-250).max(250),
    side: z.enum(["OUT", "IN", "BOTH"]).default("BOTH"),
    why: z.string(),
  }),
]);
export type WatchFix = z.infer<typeof WatchFixSchema>;

export interface AppliedFixes {
  timeline: EditTimeline;
  /** Full-edit choices the EDITOR fixes translate to (empty = no re-cut needed). */
  editor: { forceDrop: number[]; forceKeep: number[]; moveEnding: number | null };
  applied: string[];
  skipped: string[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The y of each zone on a 9:16 canvas when the orchestrator's anchors are not at hand. */
const ZONE_Y: Record<string, { x: number; y: number; align: "left" | "center" | "right"; maxWidth: number }> = {
  TOP: { x: 0.5, y: 0.2, align: "center", maxWidth: 0.8 },
  SIDE_L: { x: 0.26, y: 0.42, align: "left", maxWidth: 0.42 },
  SIDE_R: { x: 0.74, y: 0.42, align: "right", maxWidth: 0.42 },
  NEAR_SPEAKER: { x: 0.5, y: 0.6, align: "center", maxWidth: 0.8 },
};

export function applyWatchFixes(timeline: EditTimeline, fixes: WatchFix[]): AppliedFixes {
  let t: EditTimeline = EditTimelineSchema.parse(timeline);
  const applied: string[] = [];
  const skipped: string[] = [];
  const editor = { forceDrop: [] as number[], forceKeep: [] as number[], moveEnding: null as number | null };
  for (const f of fixes.slice(0, 5)) {
    if (f.stage === "EDITOR") {
      if (f.op === "DROP_LINE") editor.forceDrop.push(f.sentenceId);
      else if (f.op === "RESTORE_LINE") editor.forceKeep.push(f.sentenceId);
      else editor.moveEnding = f.sentenceId;
      applied.push(`EDITOR ${f.op} line ${f.sentenceId}`);
      continue;
    }
    if (f.stage === "SPLICE") {
      const a = t.clips[f.cutIndex];
      const b = t.clips[f.cutIndex + 1];
      if (!a || !b || a.mediaAssetId !== b.mediaAssetId) {
        skipped.push(`SPLICE RETIME cut ${f.cutIndex}: no such cut`);
        continue;
      }
      const d = f.deltaMs / 1000;
      // Loosen = more air (cut-out later / cut-in earlier); tighten = the opposite. Never past
      // the other clip's edge, never a clip shorter than 0.2 s.
      const outS = f.side === "IN" ? a.sourceEnd : r3(Math.max(a.sourceStart + 0.2, a.sourceEnd + (f.side === "BOTH" ? d / 2 : d)));
      const inS = f.side === "OUT" ? b.sourceStart : r3(Math.min(b.sourceEnd - 0.2, b.sourceStart - (f.side === "BOTH" ? d / 2 : d)));
      if (inS < outS && Math.abs(inS - outS) < 0.05) {
        skipped.push(`SPLICE RETIME cut ${f.cutIndex}: the two sides would cross`);
        continue;
      }
      t = { ...t, clips: t.clips.map((c, i) => (i === f.cutIndex ? { ...c, sourceEnd: outS } : i === f.cutIndex + 1 ? { ...c, sourceStart: inS } : c)) };
      applied.push(`SPLICE RETIME cut ${f.cutIndex} ${f.deltaMs > 0 ? "+" : ""}${f.deltaMs} ms`);
      continue;
    }
    // SCREEN
    const text = t.texts.find((x) => x.id === f.elementId);
    const visual = t.visuals.find((v) => v.id === f.elementId);
    const zoom = t.zooms.find((z) => z.id === f.elementId);
    if (!text && !visual && !zoom) {
      skipped.push(`SCREEN ${f.op} ${f.elementId}: no such element`);
      continue;
    }
    if (f.op === "DROP") {
      t = { ...t, texts: t.texts.filter((x) => x.id !== f.elementId), visuals: t.visuals.filter((v) => v.id !== f.elementId), zooms: t.zooms.filter((z) => z.id !== f.elementId) };
    } else if (f.op === "SHRINK") {
      if (text) t = { ...t, texts: t.texts.map((x) => (x.id === f.elementId ? { ...x, fontSize: Math.max(32, Math.round(x.fontSize * 0.8)) } : x)) };
      else if (visual) t = { ...t, visuals: t.visuals.map((v) => (v.id === f.elementId ? { ...v, placement: { ...v.placement, scale: Math.max(0.5, r3(v.placement.scale * 0.8)) } } : v)) };
      else if (zoom) t = { ...t, zooms: t.zooms.map((z) => (z.id === f.elementId ? { ...z, zoom: Math.max(1.02, r3(1 + (z.zoom - 1) * 0.6)) } : z)) };
    } else if (f.op === "MOVE") {
      const zone = f.to ? ZONE_Y[f.to] : null;
      if (!zone) {
        skipped.push(`SCREEN MOVE ${f.elementId}: no zone given`);
        continue;
      }
      if (text) t = { ...t, texts: t.texts.map((x) => (x.id === f.elementId ? { ...x, x: zone.x, y: zone.y, align: zone.align, maxWidth: zone.maxWidth, anchor: f.to! } : x)) };
      else if (visual) t = { ...t, visuals: t.visuals.map((v) => (v.id === f.elementId ? { ...v, placement: { ...v.placement, mode: "MANUAL", x: zone.x, y: zone.y } } : v)) };
      else {
        skipped.push(`SCREEN MOVE ${f.elementId}: a zoom has no zone`);
        continue;
      }
    } else {
      const d = f.deltaS ?? 0;
      const dur = t.clips.reduce((s, c) => s + c.sourceEnd - c.sourceStart, 0);
      const shift = <X extends { start: number; end: number }>(x: X): X => ({ ...x, start: r3(Math.max(0, x.start + d)), end: r3(Math.min(dur, Math.max(x.start + d + 0.3, x.end + d))) });
      if (text) t = { ...t, texts: t.texts.map((x) => (x.id === f.elementId ? shift(x) : x)) };
      else if (visual) t = { ...t, visuals: t.visuals.map((v) => (v.id === f.elementId ? shift(v) : v)) };
      else if (zoom) t = { ...t, zooms: t.zooms.map((z) => (z.id === f.elementId ? shift(z) : z)) };
    }
    applied.push(`SCREEN ${f.op} ${f.elementId}${f.to ? ` → ${f.to}` : ""}${f.deltaS ? ` ${f.deltaS > 0 ? "+" : ""}${f.deltaS} s` : ""}`);
  }
  return { timeline: EditTimelineSchema.parse(t), editor, applied, skipped };
}
