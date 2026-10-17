"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { TEMPLATE_FOOTPRINTS, visualRect, type TimelineVisual } from "@chris/media/timeline";
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

export const PREVIEW_FPS = 30;

export function MotionLayer({ w, h }: { w: number; h: number }) {
  const { doc, placement, engine } = useEditor();
  const playing = useIsPlaying(engine);
  // Frame-quantised: the Player seeks exactly while paused and only re-syncs on drift while
  // playing, so whole frames are all it needs (and React re-renders at most once per frame).
  const t = usePlayheadValue(engine, (x) => Math.round(x * PREVIEW_FPS) / PREVIEW_FPS);
  const timeline = useMemo(() => ({ visuals: placement.visuals, canvas: doc.canvas, clips: doc.clips }), [placement.visuals, doc.canvas, doc.clips]);
  if (!doc.visuals.length) return null;
  return (
    <div className="ed-layer pointer-events-none z-[1]" aria-hidden>
      <VisualsPreview timeline={timeline} currentTime={t} playing={playing} width={w} height={h} fps={PREVIEW_FPS} fontBaseUrl="/api/fonts" />
    </div>
  );
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
  const { doc, placement, engine, state, touch } = useEditor();
  const k = w / doc.canvas.width;
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
          const r = visualHitRect(v, doc.canvas);
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
