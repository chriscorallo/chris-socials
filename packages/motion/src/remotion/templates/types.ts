import type { MotionProps, MotionTemplate } from "@chris/media/timeline";
import type { PlacementBox } from "../../timing";
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
}
