import type { ComponentType } from "react";
import type { GraphicComponent } from "@chris/media/timeline";
import type { GCtx } from "./kit";
import { CHARTS_COMPONENTS } from "./charts";
import { COMPARE_COMPONENTS } from "./compare";
import { FX_COMPONENTS } from "./fx";
import { LIFE_COMPONENTS } from "./life";
import { PHONE_COMPONENTS } from "./phone";
import { SOCIAL_COMPONENTS } from "./social";
import { TEXT_COMPONENTS } from "./text";
import { WEB_COMPONENTS } from "./web";

/** Base components beyond the money family (charts, comparisons + lists, text + callouts) and
 * library 2's families (social posts, phone & apps, search/web/news/media, life, hooks/FX). */
export const GRAPHIC_EXTRA_COMPONENTS: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {
  ...CHARTS_COMPONENTS,
  ...COMPARE_COMPONENTS,
  ...TEXT_COMPONENTS,
  ...SOCIAL_COMPONENTS,
  ...PHONE_COMPONENTS,
  ...WEB_COMPONENTS,
  ...LIFE_COMPONENTS,
  ...FX_COMPONENTS,
};
