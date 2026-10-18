import { Composition, type CalculateMetadataFunction } from "remotion";
import { GRAPHIC_PRESETS, MOTION_TEMPLATES } from "@chris/media/timeline";
import { presetVisual, sampleVisual } from "../samples";
import { VisualsLayer, type VisualsLayerProps } from "./VisualsLayer";

export type LayerInputProps = VisualsLayerProps;

const DEFAULTS: LayerInputProps = {
  visuals: [],
  canvas: { width: 1080, height: 1920 },
  fontBaseUrl: null,
  clipMode: false,
  fps: 30,
  durationInFrames: 30,
};

const fromProps: CalculateMetadataFunction<LayerInputProps> = ({ props }) => ({
  fps: props.fps ?? 30,
  durationInFrames: Math.max(1, Math.round(props.durationInFrames ?? 30)),
  width: props.canvas.width,
  height: props.canvas.height,
});

/** Composition ids. `VisualsLayer` = whole timeline; `VisualClip` = one visual from frame 0. */
export const COMPOSITION_IDS = {
  layer: "VisualsLayer",
  clip: "VisualClip",
  preview: (t: string) => `Preview-${t.replace(/_/g, "-")}`,
  /** One composition per library preset (posters, contact sheet, quality loop). */
  preset: (id: string) => `Preset-${id}`,
} as const;

export function Root() {
  return (
    <>
      <Composition id={COMPOSITION_IDS.layer} component={VisualsLayer} defaultProps={DEFAULTS} calculateMetadata={fromProps} width={1080} height={1920} fps={30} durationInFrames={30} />
      <Composition id={COMPOSITION_IDS.clip} component={VisualsLayer} defaultProps={{ ...DEFAULTS, clipMode: true }} calculateMetadata={fromProps} width={1080} height={1920} fps={30} durationInFrames={30} />
      {MOTION_TEMPLATES.map((t) => (
        <Composition
          key={t}
          id={COMPOSITION_IDS.preview(t)}
          component={VisualsLayer}
          defaultProps={{ ...DEFAULTS, visuals: [sampleVisual(t, 0, 4)], fps: 30, durationInFrames: 120 }}
          calculateMetadata={fromProps}
          width={1080}
          height={1920}
          fps={30}
          durationInFrames={120}
        />
      ))}
      {GRAPHIC_PRESETS.map((p) => (
        <Composition
          key={p.id}
          id={COMPOSITION_IDS.preset(p.id)}
          component={VisualsLayer}
          defaultProps={{ ...DEFAULTS, visuals: [presetVisual(p, 0, p.seconds)], fps: 30, durationInFrames: Math.round(p.seconds * 30) }}
          calculateMetadata={fromProps}
          width={1080}
          height={1920}
          fps={30}
          durationInFrames={Math.round(p.seconds * 30)}
        />
      ))}
    </>
  );
}
