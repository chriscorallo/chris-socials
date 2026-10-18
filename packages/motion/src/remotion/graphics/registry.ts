import type { ComponentType } from "react";
import type { GraphicComponent } from "@chris/media/timeline";
import type { GCtx } from "./kit";
import { CHARTS_COMPONENTS } from "./charts";
import { COMPARE_COMPONENTS } from "./compare";
import { TEXT_COMPONENTS } from "./text";

/** Base components beyond the money family (charts, comparisons + lists, text + callouts). */
export const GRAPHIC_EXTRA_COMPONENTS: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {
  ...CHARTS_COMPONENTS,
  ...COMPARE_COMPONENTS,
  ...TEXT_COMPONENTS,
};
