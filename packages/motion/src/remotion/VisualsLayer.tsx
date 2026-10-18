import { useMemo, type ComponentType, type ReactNode } from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { MotionTemplate, MotionTheme, TimelineVisual, VisualInteraction } from "@chris/media/timeline";
import { TEMPLATE_DESIGN_SIZE, parseVisuals, placementBox, visualFrameWindow, type ParsedVisual } from "../timing";
import { MotionAssetsContext, useMotionFonts } from "./fonts";
import { enterExitStyle } from "./motion";
import { MotionThemeProvider, useVisualMotionStyle } from "./motion-theme-context";
import { SceneIntegration, TrackedMotion } from "./integration";
import { BarChart, Comparison, LineChart, PercentRing } from "./templates/charts";
import { ListSteps, TimelineTemplate } from "./templates/lists";
import { Callout, CalloutLeader, Definition, KineticText, NumberCounter, StatCard, TitleCard } from "./templates/text";
import { Icon3D, MoneyStack3D } from "./templates/three";
import type { TemplateComponentProps } from "./templates/types";
import { PreviewQualityContext, type PreviewQuality } from "./preview-quality";

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
  /** Motion theme (EditTimeline.motionTheme) — palette overrides, motion language, icon style. */
  motionTheme?: MotionTheme | null;
  /** Which visuals to draw (the editor preview splits behind/front layers around the person cutout). */
  depthFilter?: "ALL" | "FRONT" | "BEHIND_SUBJECT";
  /** Editor preview only (never set by renders): cheaper 3D while playing. See preview-quality.ts. */
  previewQuality?: PreviewQuality | null;
}

/** Templates drawn with a WebGL (three.js) scene — the expensive ones to mount. */
const THREE_D = new Set<MotionTemplate>(["ICON_3D", "MONEY_STACK_3D"]);
function is3d(pv: ParsedVisual): boolean {
  return THREE_D.has(pv.visual.template) || (pv.visual.template === "BAR_CHART" && !!(pv.visual.props as { depth3d?: unknown } | undefined)?.depth3d);
}

/**
 * Editor preview: how early (frames) to mount a graphic, hidden. 3D scenes (a few per video)
 * mount from the very start — i.e. while the editor opens, paused — so creating their WebGL
 * context never stalls playback; everything else 3 s ahead. Many 3D graphics → 3 s for all, to
 * stay well under the browser's WebGL-context limit.
 */
function premountFrames(pv: ParsedVisual, from: number, fps: number, count3d: number): number {
  const ahead = Math.round(fps * 3);
  return is3d(pv) && count3d <= 3 ? Math.max(ahead, from) : ahead;
}

/** One visual, local frame 0 = its first frame. */
export function VisualItem({
  pv,
  canvas,
  interaction = null,
}: {
  pv: ParsedVisual;
  canvas: { width: number; height: number };
  interaction?: VisualInteraction | null;
}) {
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
    hitAtFrame: interaction?.hitAtFrame ?? null,
    scene: interaction?.scene ?? null,
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
export function VisualsLayer({ visuals, canvas, fontBaseUrl = null, clipMode = false, interactions = null, motionTheme = null, depthFilter = "ALL", previewQuality = null }: VisualsLayerProps) {
  const { fps } = useVideoConfig();
  // The composition re-renders every frame: parse/validate the visuals once per change, not
  // per frame (stable objects also let each VisualItem skip work it doesn't need to redo).
  const parsed = useMemo(() => {
    const all = parseVisuals(visuals).parsed;
    return depthFilter === "ALL" ? all : all.filter((pv) => (pv.visual.depth ?? "FRONT") === depthFilter);
  }, [visuals, depthFilter]);
  const count3d = parsed.filter(is3d).length;
  return (
    <PreviewQualityContext.Provider value={previewQuality}>
    <MotionThemeProvider theme={motionTheme}>
    <MotionAssetsContext.Provider value={{ fontBaseUrl }}>
      <FontGate>
        <AbsoluteFill style={{ backgroundColor: "transparent" }}>
          {parsed.map((pv) => {
            const win = visualFrameWindow(pv.visual, fps);
            return (
              // Editor preview: mount each graphic (WebGL context, environment map, fonts) 3 s
              // BEFORE it appears, hidden — mounting a 3D scene is a ~0.2–0.5 s main-thread task
              // on a laptop, which used to freeze playback exactly when the graphic popped in.
              // Renders don't set previewQuality, so they mount as before.
              // (Premounting needs Remotion's absolute-fill wrapper — the same box as the layer.)
              <Sequence
                key={pv.visual.id}
                from={clipMode ? 0 : win.from}
                durationInFrames={win.durationInFrames}
                {...(previewQuality ? { layout: "absolute-fill" as const, premountFor: premountFrames(pv, win.from, fps, previewQuality.premount3d ? count3d : Infinity) } : { layout: "none" as const })}
              >
                <VisualItem pv={pv} canvas={canvas} interaction={interactions?.[pv.visual.id] ?? null} />
              </Sequence>
            );
          })}
        </AbsoluteFill>
      </FontGate>
    </MotionAssetsContext.Provider>
    </MotionThemeProvider>
    </PreviewQualityContext.Provider>
  );
}
