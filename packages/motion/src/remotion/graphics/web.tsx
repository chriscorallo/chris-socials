import type { ComponentType } from "react";
import type { GraphicComponent } from "@chris/media/timeline";
import type { GCtx } from "./kit";

/** Library 2 — web family components. */
export const WEB_COMPONENTS: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {};
