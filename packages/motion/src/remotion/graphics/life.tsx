import type { ComponentType } from "react";
import type { GraphicComponent } from "@chris/media/timeline";
import type { GCtx } from "./kit";

/** Library 2 — life family components. */
export const LIFE_COMPONENTS: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {};
