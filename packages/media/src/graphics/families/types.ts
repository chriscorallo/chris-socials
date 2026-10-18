import type { GraphicCategory, GraphicComponentSpec, GraphicProps, Library2GraphicComponent } from "../contract";

/**
 * Library 2 family plumbing (PURE, type-only imports from the contract so there is no import
 * cycle at runtime): each family file declares its components' specs and design sizes.
 */
export type Spec = GraphicComponentSpec;
export type Size = { width: number; height: number };
export type FamilySizer = (p: GraphicProps, variant: string, head: number) => Size | null;

export function spec(
  id: Library2GraphicComponent,
  label: string,
  blurb: string,
  category: GraphicCategory,
  variants: ReadonlyArray<readonly [string, string]>,
  uses: Spec["uses"],
  opts: { preferY?: number; kind?: Spec["kind"]; toneDefault?: Spec["toneDefault"]; backdrop?: Spec["backdrop"] } = {},
): Spec {
  return { id, label, blurb, category, variants, uses, kind: opts.kind ?? "BOX", preferY: opts.preferY ?? 0.38, toneDefault: opts.toneDefault, backdrop: opts.backdrop };
}

/** Characters of the longest string (for size estimates). */
export function longest(xs: Array<string | null | undefined>): number {
  return xs.reduce((a, x) => Math.max(a, (x ?? "").length), 0);
}

/** Estimated wrapped line count of `text` at ~`perLine` characters per line. */
export function lines(text: string | null | undefined, perLine: number, max = 99): number {
  const t = (text ?? "").trim();
  if (!t) return 0;
  const words = t.split(/\s+/);
  let n = 1;
  let cur = 0;
  for (const w of words) {
    if (cur && cur + 1 + w.length > perLine) {
      n++;
      cur = w.length;
    } else cur += (cur ? 1 : 0) + w.length;
  }
  return Math.min(max, n);
}
