"use client";
/**
 * `@chris/motion/player` — client-only browser preview of the motion layer for the finishing
 * editor. Renders `timeline.visuals` with the SAME React components the renderer uses, on a
 * transparent @remotion/player sized to the preview canvas, slaved to the editor's clock.
 *
 * Usage (apps/web, client component):
 *
 *   import { VisualsPreview } from "@chris/motion/player";
 *   <div style={{ position: "relative", width: w, height: h }}>
 *     <video ... />                      // or the editor's existing preview surface
 *     <VisualsPreview timeline={timeline} currentTime={t} playing={isPlaying}
 *                     width={w} height={h} fontBaseUrl="/api/fonts" />
 *   </div>
 *
 * - The editor owns time: pass `currentTime` (seconds) every tick. While `playing`, the Player
 *   runs on its own and is re-synced only when it drifts > 2 frames; while paused it seeks
 *   exactly to `currentTime`.
 * - `fontBaseUrl` = where the web app serves packages/media/assets/fonts (it already serves
 *   them at /api/fonts/<file> for text preview).
 * - It is pointer-transparent; place it absolutely over the video.
 */
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import type { EditTimeline } from "@chris/media/timeline";
import { VisualsLayer, type VisualsLayerProps } from "./remotion/VisualsLayer";

export interface VisualsPreviewProps {
  timeline: Pick<EditTimeline, "visuals" | "canvas" | "clips">;
  /** Seconds on the OUTPUT timeline. */
  currentTime: number;
  playing: boolean;
  /** Preview size in CSS px (the composition is scaled to fit). */
  width: number;
  height: number;
  /** Default 30. Use the render's fps for frame-exact parity. */
  fps?: number;
  fontBaseUrl?: string;
  style?: CSSProperties;
}

export function previewDurationFrames(timeline: Pick<EditTimeline, "visuals" | "clips">, fps: number): number {
  const clipsEnd = timeline.clips.reduce((a, c) => a + Math.max(0, c.sourceEnd - c.sourceStart), 0);
  const visEnd = timeline.visuals.reduce((a, v) => Math.max(a, v.end), 0);
  return Math.max(1, Math.ceil(Math.max(clipsEnd, visEnd) * fps));
}

export function VisualsPreview({ timeline, currentTime, playing, width, height, fps = 30, fontBaseUrl = "/api/fonts", style }: VisualsPreviewProps) {
  const ref = useRef<PlayerRef>(null);
  const canvas = timeline.canvas ?? { width: 1080, height: 1920 };
  const durationInFrames = previewDurationFrames(timeline, fps);
  const inputProps = useMemo<VisualsLayerProps>(
    () => ({ visuals: timeline.visuals, canvas, fontBaseUrl, clipMode: false }),
    [timeline.visuals, canvas, fontBaseUrl],
  );
  const target = Math.max(0, Math.min(durationInFrames - 1, Math.round(currentTime * fps)));

  useEffect(() => {
    const p = ref.current;
    if (!p) return;
    if (playing) {
      if (!p.isPlaying()) {
        p.seekTo(target);
        p.play();
      } else if (Math.abs(p.getCurrentFrame() - target) > 2) {
        p.seekTo(target);
      }
    } else {
      if (p.isPlaying()) p.pause();
      if (p.getCurrentFrame() !== target) p.seekTo(target);
    }
  }, [playing, target]);

  return (
    <div style={{ position: "absolute", inset: 0, width, height, pointerEvents: "none", ...style }}>
      <Player
        ref={ref}
        component={VisualsLayer}
        inputProps={inputProps}
        durationInFrames={durationInFrames}
        fps={fps}
        compositionWidth={canvas.width}
        compositionHeight={canvas.height}
        style={{ width, height, backgroundColor: "transparent" }}
        controls={false}
        loop={false}
        clickToPlay={false}
        doubleClickToFullscreen={false}
        spaceKeyToPlayOrPause={false}
        acknowledgeRemotionLicense
      />
    </div>
  );
}
