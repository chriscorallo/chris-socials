import type { ComponentType, ReactNode } from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { MotionTemplate, TimelineVisual } from "@chris/media/timeline";
import type { MotionTheme } from "@chris/media/timeline";
import { TEMPLATE_DESIGN_SIZE, parseVisuals, placementBox, visualFrameWindow, type ParsedVisual } from "../timing";
import { MotionAssetsContext, useMotionFonts } from "./fonts";
import { enterExitStyle } from "./motion";
import { MotionThemeProvider, useVisualMotionStyle } from "./motion-theme-context";
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
  /** Motion theme (EditTimeline.motionTheme) — palette overrides, motion language, icon style. */
  motionTheme?: MotionTheme | null;
}

/** One visual, local frame 0 = its first frame. */
export function VisualItem({ pv, canvas }: { pv: ParsedVisual; canvas: { width: number; height: number } }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const v = pv.visual;
  const win = visualFrameWindow(v, fps);
  const box = placementBox(pv.template, v.placement, canvas);
  // Theme styling (motion-themes): palette + motion feel + icon style + themed AUTO transitions.
  const ms = useVisualMotionStyle(pv.template, v);
  const { palette, enter, exit } = ms;
  const style = enterExitStyle(frame, fps, win.durationInFrames, enter, exit, win.enterFrames, win.exitFrames, ms.feel);
  const Comp = TEMPLATES[pv.template];
  const tp: TemplateComponentProps<MotionTemplate> = {
    props: pv.props,
    palette,
    feel: ms.feel,
    iconStyle: ms.iconStyle,
    frame,
    fps,
    durationInFrames: win.durationInFrames,
    enterFrames: win.enterFrames,
    exitFrames: win.exitFrames,
    box,
    canvas,
  };
  const design = TEMPLATE_DESIGN_SIZE[pv.template];
  if (pv.template === "TITLE_CARD") {
    return (
      <AbsoluteFill style={{ opacity: style.opacity, filter: style.filter === "none" ? undefined : style.filter }}>
        <Comp {...tp} />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill>
      {pv.template === "CALLOUT" ? <CalloutLeader {...(tp as TemplateComponentProps<"CALLOUT">)} /> : null}
      <div style={{ position: "absolute", left: box.left, top: box.top, width: design.width, height: design.height, transform: `scale(${box.scale})`, transformOrigin: "0 0" }}>
        <div style={{ position: "absolute", inset: 0, opacity: style.opacity, transform: style.transform, filter: style.filter === "none" ? undefined : style.filter, transformOrigin: "50% 50%" }}>
          <Comp {...tp} />
        </div>
      </div>
    </AbsoluteFill>
  );
}

function FontGate({ children }: { children: ReactNode }) {
  useMotionFonts();
  return <>{children}</>;
}

/** Every visual of a timeline at its time and placement, on a transparent canvas. */
export function VisualsLayer({ visuals, canvas, fontBaseUrl = null, clipMode = false, motionTheme = null }: VisualsLayerProps) {
  const { fps } = useVideoConfig();
  const { parsed } = parseVisuals(visuals);
  return (
    <MotionThemeProvider theme={motionTheme}>
    <MotionAssetsContext.Provider value={{ fontBaseUrl }}>
      <FontGate>
        <AbsoluteFill style={{ backgroundColor: "transparent" }}>
          {parsed.map((pv) => {
            const win = visualFrameWindow(pv.visual, fps);
            return (
              <Sequence key={pv.visual.id} from={clipMode ? 0 : win.from} durationInFrames={win.durationInFrames} layout="none">
                <VisualItem pv={pv} canvas={canvas} />
              </Sequence>
            );
          })}
        </AbsoluteFill>
      </FontGate>
    </MotionAssetsContext.Provider>
    </MotionThemeProvider>
  );
}
