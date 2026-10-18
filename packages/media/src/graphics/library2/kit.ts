import type { SfxSound } from "../../motion-contract";
import type { GraphicCategory, GraphicComponent, GraphicProps } from "../contract";
import type { GraphicPreset } from "../presets";

/**
 * Builders for library-2 presets (each family file exports an array; presets.ts appends them
 * after the original library, so the first 171 keep their order).
 *
 * Copy rules (brand-safe, Chris's voice): generic "-style" UI only — placeholder people
 * ("Your Name", "@yourhandle", "Alex", "Sam"), neutral app names ("Bank", "Messages", "Mail"),
 * never a real platform/brand name, logo, or verification badge. Sample copy is direct,
 * skeptical and specific (money, LA life, gym, building in public) — and numbers are
 * illustrative placeholders: the Quality Gate refuses any on-screen number that isn't in the
 * fact-checked script.
 */

type DeepPartial<T> = { [K in keyof T]?: T[K] extends Array<infer U> ? Array<DeepPartial<U>> : T[K] extends object | null ? DeepPartial<NonNullable<T[K]>> | null : T[K] };
export type GInput = DeepPartial<GraphicProps>;

export interface PresetOpts {
  seconds?: number;
  featured?: boolean;
  placement?: GraphicPreset["placement"];
  palette?: GraphicPreset["palette"];
  enterSfx?: SfxSound | null;
}

export function preset(
  id: string,
  name: string,
  description: string,
  category: GraphicCategory,
  tags: string[],
  component: GraphicComponent,
  data: GInput,
  opts: PresetOpts = {},
): GraphicPreset {
  return {
    id,
    name,
    description,
    category,
    tags,
    template: "GRAPHIC",
    props: { ...data, component, preset: id },
    seconds: opts.seconds ?? 4,
    placement: opts.placement,
    palette: opts.palette,
    enterSfx: opts.enterSfx === undefined ? "SOFT_POP" : opts.enterSfx,
    featured: opts.featured,
  };
}

/** An item (entry). */
export function I(text: string, value: number | null = null, extra: Record<string, unknown> = {}) {
  return { text, value, ...extra };
}
/** A message from me (right). */
export function ME(text: string, extra: Record<string, unknown> = {}) {
  return { text, side: "ME" as const, ...extra };
}
/** A message from them (left). */
export function THEM(text: string, extra: Record<string, unknown> = {}) {
  return { text, side: "THEM" as const, ...extra };
}
export function S(label: string, values: number[], extra: Record<string, unknown> = {}) {
  return { label, values, ...extra };
}
export const k = (n: number) => n * 1000;
export const USD = { kind: "CURRENCY" as const };
export const PCT = { kind: "PERCENT" as const };

/** A preset on one of the classic templates (e.g. the new ICON_3D objects). */
export function classicPreset(
  id: string,
  name: string,
  description: string,
  category: GraphicCategory,
  tags: string[],
  template: Exclude<GraphicPreset["template"], "GRAPHIC">,
  props: Record<string, unknown>,
  opts: PresetOpts = {},
): GraphicPreset {
  return { id, name, description, category, tags, template, props, seconds: opts.seconds ?? 3.5, placement: opts.placement, enterSfx: opts.enterSfx === undefined ? "WHOOSH" : opts.enterSfx, featured: opts.featured };
}
