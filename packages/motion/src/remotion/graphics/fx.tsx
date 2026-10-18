import type { ComponentType } from "react";
import type { GraphicComponent } from "@chris/media/timeline";
import type { GCtx } from "./kit";

/** Library 2 — fx family components. */
export const FX_COMPONENTS: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {};
