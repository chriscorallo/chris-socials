import type { ComponentType } from "react";
import type { GraphicComponent } from "@chris/media/timeline";
import type { GCtx } from "./kit";

/** Library 2 — phone family components. */
export const PHONE_COMPONENTS: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {};
