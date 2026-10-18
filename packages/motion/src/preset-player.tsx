"use client";
/**
 * `@chris/motion/preset-player` — a looping, self-playing preview of ONE library preset (or any
 * visual) for the editor's graphics library: the same VisualsLayer the renderer draws, on a
 * small transparent @remotion/player. Mounted only while a preview is open (never one per
 * gallery card — the gallery uses static posters), so it costs nothing until asked.
 */
import { useMemo } from "react";
import { Player } from "@remotion/player";
import type { MotionTheme, TimelineVisual } from "@chris/media/timeline";
import { VisualsLayer, type VisualsLayerProps } from "./remotion/VisualsLayer";

export interface PresetPlayerProps {
  visual: TimelineVisual;
  width: number;
  height: number;
  motionTheme?: MotionTheme | null;
  fontBaseUrl?: string;
  fps?: number;
}

export function PresetPlayer({ visual, width, height, motionTheme = null, fontBaseUrl = "/api/fonts", fps = 30 }: PresetPlayerProps) {
  const durationInFrames = Math.max(2, Math.round((visual.end - visual.start) * fps) + Math.round(0.6 * fps));
  const inputProps = useMemo<VisualsLayerProps>(
    () => ({ visuals: [{ ...visual, end: visual.end - visual.start, start: 0 }], canvas: { width: 1080, height: 1920 }, fontBaseUrl, clipMode: false, motionTheme }),
    [visual, fontBaseUrl, motionTheme],
  );
  return (
    <Player
      component={VisualsLayer}
      inputProps={inputProps}
      durationInFrames={durationInFrames}
      fps={fps}
      compositionWidth={1080}
      compositionHeight={1920}
      style={{ width, height, backgroundColor: "transparent" }}
      controls={false}
      autoPlay
      loop
      clickToPlay={false}
      doubleClickToFullscreen={false}
      spaceKeyToPlayOrPause={false}
      acknowledgeRemotionLicense
    />
  );
}
