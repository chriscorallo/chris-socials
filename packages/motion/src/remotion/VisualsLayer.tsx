import type { ComponentType, ReactNode } from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { MotionTemplate, MotionTheme, TimelineVisual, VisualInteraction } from "@chris/media/timeline";
import { TEMPLATE_DESIGN_SIZE, parseVisuals, placementBox, resolveTransition, visualFrameWindow, type ParsedVisual } from "../timing";
import { MotionAssetsContext, useMotionFonts } from "./fonts";
import { enterExitStyle } from "./motion";
import { SceneIntegration, TrackedMotion } from "./integration";
import { paletteFor } from "./theme";
import { BarChart, Comparison, LineChart, PercentRing } from "./templates/charts";
import { ListSteps, TimelineTemplate } from "./templates/lists";
import { Callout, CalloutLeader, Definition, KineticText, NumberCounter, StatCard, TitleCard } from "./templates/text";
import { Icon3D, MoneyStack3D } from "./templates/three";
import type { TemplateComponentProps } from "./templates/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TEMPLATES: Record<MotionTemplate, ComponentType<TemplateComponentProps<any>>> = {
  KINETIC_TEXT: KineticText,
  NUMBER_COUNTER: NumberCounter,
  STAT_CARD: StatCard,
  BAR_CHART: BarChart,
  LINE_CHART: LineChart,
  COMPARISON: Comparison,
  PERCENT_RING: PercentRing,
  LIST_STEPS: ListSteps,
  ICON_3D: Icon3D,
  MONEY_STACK_3D: MoneyStack3D,
  CALLOUT: Callout,
  TIMELINE: TimelineTemplate,
  DEFINITION: Definition,
  TITLE_CARD: TitleCard,
};

export interface VisualsLayerProps extends Record<string, unknown> {
  visuals: TimelineVisual[];
  canvas: { width: number; height: number };
  /** Browser preview: where font files are served (e.g. "/api/fonts"). Null in renders. */
  fontBaseUrl?: string | null;
  /**
   * Render a single visual starting at frame 0 (per-visual clip renders). When set, `visuals`
   * holds exactly that visual and its timing is shifted so start = 0.
   */
  clipMode?: boolean;
  /** Render metadata (calculateMetadata): output fps and length in frames. */
  fps?: number;
  durationInFrames?: number;
  /**
   * Motion v2: per-visual interaction data (subject-anchor / camera-coupling track, emphasis
   * hit frame, scene look) from @chris/media's `buildVisualInteractions` — the worker and the
   * editor preview compute it with the same pure functions. Absent → v1 behaviour.
   */
  interactions?: Record<string, VisualInteraction> | null;
  /** Per-video motion theme (timeline.motionTheme), passed through to templates. */
  motionTheme?: MotionTheme | null;
  /** Which visuals to draw (the editor preview splits behind/front layers around the person cutout). */
  depthFilter?: "ALL" | "FRONT" | "BEHIND_SUBJECT";
}

/** One visual, local frame 0 = its first frame. */
export function VisualItem({
  pv,
  canvas,
  interaction = null,
  motionTheme = null,
}: {
  pv: ParsedVisual;
  canvas: { width: number; height: number };
  interaction?: VisualInteraction | null;
  motionTheme?: MotionTheme | null;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const v = pv.visual;
  const win = visualFrameWindow(v, fps);
  const box = placementBox(pv.template, v.placement, canvas);
  const palette = paletteFor(v.palette);
  const enter = resolveTransition(pv.template, "enter", v.enter);
  const exit = resolveTransition(pv.template, "exit", v.exit);
  const style = enterExitStyle(frame, fps, win.durationInFrames, enter, exit, win.enterFrames, win.exitFrames);
  const Comp = TEMPLATES[pv.template];
  const tp: TemplateComponentProps<MotionTemplate> = {
    props: pv.props,
    palette,
    frame,
    fps,
    durationInFrames: win.durationInFrames,
    enterFrames: win.enterFrames,
    exitFrames: win.exitFrames,
    box,
    canvas,
    hitAtFrame: interaction?.hitAtFrame ?? null,
    scene: interaction?.scene ?? null,
    theme: motionTheme,
  };
  const design = TEMPLATE_DESIGN_SIZE[pv.template];
  const look = interaction?.look;
  if (pv.template === "TITLE_CARD") {
    return (
      <AbsoluteFill style={{ opacity: style.opacity, filter: style.filter === "none" ? undefined : style.filter }}>
        <SceneIntegration id={v.id} template={pv.template} integration={{ ...v.integration, shadow: false }} look={look}>
          <Comp {...tp} />
        </SceneIntegration>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill>
      <TrackedMotion ix={interaction} frame={frame} box={box}>
        {pv.template === "CALLOUT" ? <CalloutLeader {...(tp as TemplateComponentProps<"CALLOUT">)} /> : null}
        <div style={{ position: "absolute", left: box.left, top: box.top, width: design.width, height: design.height, transform: `scale(${box.scale})`, transformOrigin: "0 0" }}>
          <div style={{ position: "absolute", inset: 0, opacity: style.opacity, transform: style.transform, filter: style.filter === "none" ? undefined : style.filter, transformOrigin: "50% 50%" }}>
            <SceneIntegration id={v.id} template={pv.template} integration={v.integration} look={look}>
              <Comp {...tp} />
            </SceneIntegration>
          </div>
        </div>
      </TrackedMotion>
    </AbsoluteFill>
  );
}

function FontGate({ children }: { children: ReactNode }) {
  useMotionFonts();
  return <>{children}</>;
}

/** Every visual of a timeline at its time and placement, on a transparent canvas. */
export function VisualsLayer({ visuals, canvas, fontBaseUrl = null, clipMode = false, interactions = null, motionTheme = null, depthFilter = "ALL" }: VisualsLayerProps) {
  const { fps } = useVideoConfig();
  const { parsed: all } = parseVisuals(visuals);
  const parsed = depthFilter === "ALL" ? all : all.filter((pv) => (pv.visual.depth ?? "FRONT") === depthFilter);
  return (
    <MotionAssetsContext.Provider value={{ fontBaseUrl }}>
      <FontGate>
        <AbsoluteFill style={{ backgroundColor: "transparent" }}>
          {parsed.map((pv) => {
            const win = visualFrameWindow(pv.visual, fps);
            return (
              <Sequence key={pv.visual.id} from={clipMode ? 0 : win.from} durationInFrames={win.durationInFrames} layout="none">
                <VisualItem pv={pv} canvas={canvas} interaction={interactions?.[pv.visual.id] ?? null} motionTheme={motionTheme} />
              </Sequence>
            );
          })}
        </AbsoluteFill>
      </FontGate>
    </MotionAssetsContext.Provider>
  );
}
