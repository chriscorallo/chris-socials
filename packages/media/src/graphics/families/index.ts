import type { GraphicComponentSpec, GraphicProps, Library2GraphicComponent } from "../contract";
import { FX_SPECS, fxSize } from "./fx";
import { LIFE_SPECS, lifeSize } from "./life";
import { PHONE_SPECS, phoneSize } from "./phone";
import { SOCIAL_SPECS, socialSize } from "./social";
import type { Size } from "./types";
import { WEB_SPECS, webSize } from "./web";

/** Library 2's base components (2026-10-18): specs merged into GRAPHIC_COMPONENT_SPECS. */
export const LIBRARY2_SPECS: Record<Library2GraphicComponent, GraphicComponentSpec> = {
  ...SOCIAL_SPECS,
  ...PHONE_SPECS,
  ...WEB_SPECS,
  ...LIFE_SPECS,
  ...FX_SPECS,
};

const SIZERS = [socialSize, phoneSize, webSize, lifeSize, fxSize];

/** Design box of a library-2 component (px at a 1080-wide canvas, scale 1). */
export function library2DesignSize(p: GraphicProps, variant: string, head: number): Size {
  for (const f of SIZERS) {
    const s = f(p, variant, head);
    if (s) return { width: Math.min(1080, Math.round(s.width)), height: Math.min(1920, Math.round(s.height)) };
  }
  return { width: 960, height: 760 };
}
