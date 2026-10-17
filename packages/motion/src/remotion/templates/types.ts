import type { MotionProps, MotionTemplate, SceneStats } from "@chris/media/timeline";
import type { PlacementBox } from "../../timing";
import { DEFAULT_FEEL, type IconStyle, type MotionFeel } from "../../style";
import type { Palette } from "../theme";

/** What every template component receives. Coordinates inside = the template's designed box. */
export interface TemplateComponentProps<T extends MotionTemplate> {
  props: MotionProps<T>;
  palette: Palette;
  /** Frame local to the visual (0 = its start). */
  frame: number;
  fps: number;
  durationInFrames: number;
  enterFrames: number;
  exitFrames: number;
  /** Where the box landed on the canvas (canvas px) — for templates that draw in canvas space. */
  box: PlacementBox;
  canvas: { width: number; height: number };
  /**
   * Motion v2 timing hook: the local frame where the template's KEY MOMENT should land (counter
   * landing, bar peak, punch word) — the speaker's vocal emphasis. Null/absent = the template's
   * own timing. Templates only ever DELAY/stretch toward it (never rush their build).
   */
  hitAtFrame?: number | null;
  /** Footage stats behind the graphic (for theme-aware styling; null = unknown). */
  scene?: SceneStats | null;
  /** The video's motion language (resolveMotionStyle). Optional: absent = CRISP house style. */
  feel?: MotionFeel;
  /** 3D material family / line icons (resolveMotionStyle). Optional: absent = GOLD_METAL. */
  iconStyle?: IconStyle;
}

export function feelOf(tp: { feel?: MotionFeel }): MotionFeel {
  return tp.feel ?? DEFAULT_FEEL;
}

export function iconStyleOf(tp: { iconStyle?: IconStyle }): IconStyle {
  return tp.iconStyle ?? "GOLD_METAL";
}
