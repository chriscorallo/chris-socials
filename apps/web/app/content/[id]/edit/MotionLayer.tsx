"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { TEMPLATE_FOOTPRINTS, resolveGrade, visualRect, type TimelineVisual, type VisualInteraction } from "@chris/media/timeline";
import { trackAt } from "@chris/motion/pure";
import { PREVIEW_FPS } from "./preview-fps";
// WebGL person cut-out: only edits with behind-you graphics AND a matte ever need it.
const PersonCutout = dynamic(() => import("./PersonCutout").then((m) => m.PersonCutout), { ssr: false, loading: () => null });
import { TEMPLATE_LABEL } from "../../../../lib/editor/visuals";
import { useEditor } from "./context";
import { useIsPlaying, usePlayheadValue } from "./playback";

/**
 * The motion-graphics layer of the preview: `@chris/motion/player`'s <VisualsPreview> — the
 * SAME Remotion components the renderer draws, on a transparent Player slaved to the editor's
 * clock — composited exactly where the renderer puts them: over the graded picture, under
 * texts and captions (and under the platform-UI mock, which is the app's chrome).
 *
 * Loaded client-only and only once the edit actually has graphics (dynamic import, ssr off),
 * so Remotion/three.js never weigh on the editor's first load on an iPhone.
 */
const VisualsPreview = dynamic(() => import("@chris/motion/player").then((m) => m.VisualsPreview), {
  ssr: false,
  loading: () => null,
});

export { PREVIEW_FPS } from "./preview-fps";

/**
 * Depth in the preview (Motion v2): with behind-subject graphics and a person matte, the layer
 * splits into behind graphics → Chris cut out with his matte (PersonCutout, WebGL) → front
 * graphics — the renderer's order. Two Players only while that's needed; if the device can't
 * (no WebGL / cross-origin media / too slow) everything draws in front with a small note.
 */
export function MotionLayer({ w, h }: { w: number; h: number }) {
  const { doc, placement, engine, interactions, assets, bakedIds } = useEditor();
  const playing = useIsPlaying(engine);
  // Graphics the compositor already draws from bakes are not mounted live at all.
  const live = useMemo(() => (bakedIds.size ? placement.visuals.filter((v) => !bakedIds.has(v.id)) : placement.visuals), [placement.visuals, bakedIds]);
  // Frame-quantised and frame-locked: the Player renders exactly the editor's frame (React
  // re-renders at most once per frame). No live graphics → no per-frame re-render at all.
  const t = usePlayheadValue(engine, (x) => (live.length ? Math.round(x * PREVIEW_FPS) / PREVIEW_FPS : 0));
  // Lite (no CSS/SVG filters — WebKit runs them on the CPU) while playing or scrubbing; the full
  // look returns once the playhead has rested for half a second.
  const settled = useSettled(t, playing);
  const timeline = useMemo(
    () => ({ visuals: live, canvas: doc.canvas, clips: doc.clips, motionTheme: doc.motionTheme }),
    [live, doc.canvas, doc.clips, doc.motionTheme],
  );
  const [depthFailed, setDepthFailed] = useState<string | null>(null);
  const behindWindows = useMemo(
    () => placement.visuals.filter((v) => v.depth === "BEHIND_SUBJECT").map((v) => ({ start: v.start, end: v.end })),
    [placement.visuals],
  );
  const anyMatte = assets.some((a) => !!a.matteUrl);
  const g = resolveGrade(doc.grade);
  const gradeOn = g.brightness !== 0 || g.contrast !== 1 || g.saturation !== 1 || g.temperature !== 0;
  if (!live.length) return null;
  // 3D scenes are NOT premounted at open: in WebKit their WebGL setup blocks the page for
  // seconds (measured 2× 4 s right after opening) — bakes replace them instead.
  const common = { timeline, currentTime: t, playing, width: w, height: h, fps: PREVIEW_FPS, fontBaseUrl: "/api/fonts", interactions, lite: !settled, premount3d: false };
  // The compositor has no <video> for the person cut-out: behind-you graphics draw in front.
  const split = behindWindows.length > 0 && anyMatte && !depthFailed && engine.kind === "video";
  const behindNow = behindWindows.some((x) => t >= x.start && t < x.end);
  if (!split) {
    return (
      <>
        <div className="ed-layer pointer-events-none z-[1]" aria-hidden>
          <VisualsPreview {...common} />
        </div>
        {behindNow && (
          <p className="ed-depth-note pointer-events-none" role="note">
            {anyMatte ? "Depth shows in the export" : "Behind-you needs your outline — it's being prepared (shows in the export)"}
          </p>
        )}
      </>
    );
  }
  return (
    <>
      <div className="ed-layer pointer-events-none z-[1]" aria-hidden>
        <VisualsPreview {...common} depthFilter="BEHIND_SUBJECT" />
      </div>
      <PersonCutout w={w} h={h} behindWindows={behindWindows} gradeOn={gradeOn} onUnsupported={(why) => setDepthFailed(why)} />
      <div className="ed-layer pointer-events-none z-[1]" aria-hidden>
        <VisualsPreview {...common} depthFilter="FRONT" />
      </div>
    </>
  );
}

/** True once the playhead has rested (paused, unchanged) for `ms`. */
function useSettled(t: number, playing: boolean, ms = 500): boolean {
  const [settledAt, setSettledAt] = useState<number | null>(null);
  useEffect(() => {
    if (playing) return;
    const id = window.setTimeout(() => setSettledAt(t), ms);
    return () => window.clearTimeout(id);
  }, [t, playing, ms]);
  return !playing && settledAt === t;
}

/** Where a visual is DRAWN at output time t: its tracked centre (follow/camera) or its placement. */
export function drawnPlacement(v: TimelineVisual, ix: VisualInteraction | undefined, t: number, canvas: { width: number; height: number }): TimelineVisual["placement"] & { s: number } {
  const frame = Math.round(t * PREVIEW_FPS) - Math.max(0, Math.round(v.start * PREVIEW_FPS));
  const p = trackAt(ix, frame);
  return p ? { ...v.placement, x: p.x / canvas.width, y: p.y / canvas.height, s: p.s } : { ...v.placement, s: 1 };
}

/** Hit area (canvas px) for a visual on the preview: its footprint; a full-frame title card
 * only grabs its middle so taps elsewhere still play/pause. */
export function visualHitRect(v: Pick<TimelineVisual, "template" | "placement">, canvas: { width: number; height: number }) {
  if (TEMPLATE_FOOTPRINTS[v.template].kind === "FULL_FRAME") {
    return { x: canvas.width * 0.15, y: canvas.height * 0.36, width: canvas.width * 0.7, height: canvas.height * 0.28 };
  }
  return visualRect(v, canvas);
}

/**
 * Touch/click targets for the graphics on screen now (the Player itself is pointer-
 * transparent). Elements carry `data-gesture="visual"` / `"visual-resize"` + `data-id`; the
 * canvas's one gesture controller (Preview.tsx) drags them (→ MANUAL placement), pinches
 * them, and taps them. Sits under the text/caption SVG so texts keep priority.
 */
export function VisualHandles({ w, dragging }: { w: number; dragging: string | null }) {
  const { doc, placement, engine, state, touch, interactions } = useEditor();
  const k = w / doc.canvas.width;
  // Graphics that follow Chris / ride the camera: hit areas follow them while paused.
  // Hit areas only matter when Chris can touch them: frame-accurate while paused, frozen while
  // playing (a tap pauses first, which re-syncs them) — no 30 re-renders a second during playback.
  const tq = usePlayheadValue(engine, (x) => (placement.visuals.length && !engine.playing ? Math.round(x * PREVIEW_FPS) / PREVIEW_FPS : -1));
  const key = usePlayheadValue(engine, (t) =>
    placement.visuals
      .filter((v) => t >= v.start && t < v.end)
      .map((v) => v.id)
      .join(","),
  );
  const active = new Set(key ? key.split(",") : []);
  const selectedId = state.selection?.kind === "visual" ? state.selection.id : null;
  const hs = touch ? 26 : 14;
  return (
    <div className="ed-layer pointer-events-none z-[5]">
      {placement.visuals
        .filter((v) => active.has(v.id) || v.id === dragging)
        .map((v) => {
          const d = drawnPlacement(v, interactions[v.id], tq, doc.canvas);
          const r = visualHitRect({ ...v, placement: { ...v.placement, x: d.x, y: d.y, scale: v.placement.scale * d.s } }, doc.canvas);
          const selected = v.id === selectedId;
          const detail = placement.details[v.id];
          return (
            <div key={v.id}>
              {dragging === v.id && detail?.head && (
                <div
                  className="ed-vis-protect"
                  style={{ left: detail.head.x * k, top: detail.head.y * k, width: detail.head.width * k, height: detail.head.height * k }}
                  aria-hidden
                >
                  <span>Face</span>
                </div>
              )}
              <div
                className={`ed-vis-hit ${selected ? "ed-vis-hit-sel" : ""}`}
                style={{ left: r.x * k, top: r.y * k, width: r.width * k, height: r.height * k }}
                data-gesture="visual"
                data-id={v.id}
                role="button"
                aria-label={`Graphic: ${TEMPLATE_LABEL[v.template]}`}
                aria-pressed={selected}
              >
                {selected && (
                  <>
                    <span className="ed-vis-tag">{v.placement.mode === "AUTO" ? "Auto" : "Placed"}</span>
                    <div className="ed-vis-resize" data-gesture="visual-resize" data-id={v.id} style={{ width: hs, height: hs, right: -hs / 2, bottom: -hs / 2 }} aria-label="Resize graphic" />
                  </>
                )}
              </div>
            </div>
          );
        })}
    </div>
  );
}
