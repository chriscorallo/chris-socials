import {
  GRAPHIC_COMPONENT_SPECS,
  GRAPHIC_LIMITS,
  GraphicPropsSchema,
  applyInteractionDefaults,
  applyQuickEntry,
  applyQuickText,
  footprintOf,
  parseQuickEntry,
  timelineDuration,
  VISUAL_INTERACTION_DEFAULTS,
  type GraphicItem,
  type GraphicPreset,
  type GraphicProps,
  type GraphicSeries,
  type TimelineVisual,
} from "@chris/media/timeline";
import { presetVisualProps } from "@chris/motion/pure";
import { newId } from "./timeline-ops";
import { freeSlotAt, updateVisualProps } from "./visuals";
import type { EditorDoc } from "./types";

/**
 * Graphics library in the editor — PURE document operations (no React): inserting a library
 * preset at the playhead, and every edit the GRAPHIC edit sheet makes to the data model
 * (cells, rows, columns, repeat-fill, quick entry). Each returns a NEW doc → one undo step.
 */

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Inserts a preset as a visual at output time `at` (free gap rules as any graphic). */
export function addPresetVisual(
  doc: EditorDoc,
  preset: GraphicPreset,
  at: number,
  opts: { id?: string; anchorText?: string | null; props?: Record<string, unknown> } = {},
): { doc: EditorDoc; id: string | null } {
  const id = opts.id ?? newId("vis");
  const slot = freeSlotAt(doc.visuals, at, timelineDuration(doc), preset.seconds);
  if (!slot) return { doc, id: null };
  const props = opts.props ?? presetVisualProps(preset);
  const fp = footprintOf(preset.template, props);
  const v: TimelineVisual = applyInteractionDefaults({
    id,
    template: preset.template,
    props,
    start: slot.start,
    end: r3(slot.end),
    ...VISUAL_INTERACTION_DEFAULTS,
    placement: {
      mode: preset.placement?.mode ?? "AUTO",
      x: preset.placement?.x ?? 0.5,
      y: preset.placement?.y ?? (fp.kind === "FULL_FRAME" ? 0.5 : fp.preferY),
      scale: preset.placement?.scale ?? 1,
    },
    palette: preset.palette ?? "BRAND",
    enter: "AUTO",
    exit: "AUTO",
    enterSfx: preset.enterSfx === undefined ? "WHOOSH" : preset.enterSfx,
    anchorText: opts.anchorText ? opts.anchorText.slice(0, 200) : null,
  });
  return { doc: { ...doc, visuals: [...doc.visuals, v] }, id };
}

/** The visual's GRAPHIC props with every default filled (null when they don't parse). */
export function graphicPropsOf(v: Pick<TimelineVisual, "template" | "props">): GraphicProps | null {
  if (v.template !== "GRAPHIC") return null;
  const r = GraphicPropsSchema.safeParse(v.props);
  return r.success ? r.data : null;
}

export function setGraphic(doc: EditorDoc, id: string, next: GraphicProps): EditorDoc {
  return updateVisualProps(doc, id, next as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------- data-model edits (pure)

export function blankSeries(label: string, n: number): GraphicSeries {
  return { label, values: Array(n).fill(0), icon: null, color: "AUTO", note: null, texts: [] };
}
export function blankItem(text: string, value: number | null = null): GraphicItem {
  return { text, value, sub: null, icon: null, color: "AUTO", op: "NONE", state: "NONE", side: "NONE", meta: null };
}

export function setCell(p: GraphicProps, row: number, col: number, value: number): GraphicProps {
  return {
    ...p,
    series: p.series.map((s, i) => {
      if (i !== row) return s;
      const values = [...s.values];
      while (values.length <= col) values.push(0);
      values[col] = value;
      // A typed number replaces a text cell.
      const texts = s.texts.length > col ? s.texts.map((t, j) => (j === col ? "" : t)) : s.texts;
      return { ...s, values, texts };
    }),
  };
}

export function setSeries(p: GraphicProps, row: number, patch: Partial<GraphicSeries>): GraphicProps {
  return { ...p, series: p.series.map((s, i) => (i === row ? { ...s, ...patch } : s)) };
}

/** Adds a row (entity) sized like the longest existing row. */
export function addRow(p: GraphicProps): GraphicProps {
  const spec = GRAPHIC_COMPONENT_SPECS[p.component].uses.series;
  const max = spec ? spec.count[1] : GRAPHIC_LIMITS.maxSeries;
  if (p.series.length >= max) return p;
  const n = Math.max(1, ...p.series.map((s) => s.values.length));
  const label = spec?.label === "ENTITY" ? `Person ${p.series.length + 1}` : `Row ${p.series.length + 1}`;
  return { ...p, series: [...p.series, blankSeries(label, n)] };
}

export function removeRow(p: GraphicProps, row: number): GraphicProps {
  const min = GRAPHIC_COMPONENT_SPECS[p.component].uses.series?.count[0] ?? 0;
  if (p.series.length <= min) return p;
  const highlight = p.highlight === null ? null : p.highlight === row ? null : p.highlight > row && GRAPHIC_COMPONENT_SPECS[p.component].uses.highlight === "SERIES" ? p.highlight - 1 : p.highlight;
  return { ...p, series: p.series.filter((_, i) => i !== row), highlight };
}

/** Adds a column (one more value in every row, + a category label when the component has them). */
export function addColumn(p: GraphicProps): GraphicProps {
  const max = GRAPHIC_COMPONENT_SPECS[p.component].uses.series?.values[1] ?? GRAPHIC_LIMITS.maxValues;
  const n = Math.max(0, ...p.series.map((s) => s.values.length));
  if (n >= max) return p;
  const usesCats = !!GRAPHIC_COMPONENT_SPECS[p.component].uses.categories;
  return {
    ...p,
    series: p.series.map((s) => ({ ...s, values: [...s.values, ...Array(Math.max(0, n + 1 - s.values.length)).fill(0)] })),
    categories: usesCats && p.categories.length === n && n > 0 ? [...p.categories, ""] : p.categories,
  };
}

export function removeColumn(p: GraphicProps, col: number): GraphicProps {
  const min = GRAPHIC_COMPONENT_SPECS[p.component].uses.series?.values[0] ?? 0;
  const n = Math.max(0, ...p.series.map((s) => s.values.length));
  if (n <= min) return p;
  return {
    ...p,
    series: p.series.map((s) => ({ ...s, values: s.values.filter((_, j) => j !== col), texts: s.texts.filter((_, j) => j !== col) })),
    categories: p.categories.filter((_, j) => j !== col),
  };
}

/** "Fill" helper on one row: any quick-entry value list ("4k x12", "1, 2, 3"). */
export function fillRow(p: GraphicProps, row: number, text: string): { props: GraphicProps; ok: boolean } {
  const q = parseQuickEntry(text.includes(":") ? text : `R: ${text}`);
  const values = q.series[0]?.values ?? [];
  if (!values.length) return { props: p, ok: false };
  const max = GRAPHIC_COMPONENT_SPECS[p.component].uses.series?.values[1] ?? GRAPHIC_LIMITS.maxValues;
  return { props: setSeries(p, row, { values: values.slice(0, max), texts: [] }), ok: true };
}

export function setItem(p: GraphicProps, i: number, patch: Partial<GraphicItem>): GraphicProps {
  return { ...p, items: p.items.map((it, k) => (k === i ? { ...it, ...patch } : it)) };
}

export function addItem(p: GraphicProps): GraphicProps {
  const u = GRAPHIC_COMPONENT_SPECS[p.component].uses.items;
  const max = u ? u.count[1] : GRAPHIC_LIMITS.maxItems;
  if (p.items.length >= max) return p;
  const last = p.items[p.items.length - 1];
  const op = p.component === "FORMULA" ? "PLUS" : "NONE";
  // Conversations alternate sides; other entries copy the last one's state.
  const side = u?.side ? (last?.side === "ME" ? "THEM" : "ME") : "NONE";
  const text = u?.side ? (side === "ME" ? "New message" : "Reply") : `Item ${p.items.length + 1}`;
  const it: GraphicItem = { ...blankItem(text, u?.value ? 0 : null), op, state: last?.state ?? "NONE", side, meta: u?.meta ? (last?.meta ?? null) : null, icon: u?.icon && !u.side ? (last?.icon ?? null) : null };
  // FORMULA: insert before the result term.
  if (p.component === "FORMULA") {
    const res = p.items.findIndex((x) => x.op === "EQUALS");
    if (res >= 0) return { ...p, items: [...p.items.slice(0, res), it, ...p.items.slice(res)] };
  }
  return { ...p, items: [...p.items, it] };
}

export function removeItem(p: GraphicProps, i: number): GraphicProps {
  const min = GRAPHIC_COMPONENT_SPECS[p.component].uses.items?.count[0] ?? 0;
  if (p.items.length <= min) return p;
  const highlight = p.highlight === null ? null : p.highlight === i ? null : p.highlight > i ? p.highlight - 1 : p.highlight;
  return { ...p, items: p.items.filter((_, k) => k !== i), highlight };
}

export function moveItem(p: GraphicProps, i: number, dir: -1 | 1): GraphicProps {
  const j = i + dir;
  if (j < 0 || j >= p.items.length) return p;
  const items = [...p.items];
  [items[i], items[j]] = [items[j]!, items[i]!];
  return { ...p, items };
}

/** Quick entry box → props (+ a one-line summary for the UI). */
export function quickEntryInto(p: GraphicProps, text: string): { props: GraphicProps; summary: string; warnings: string[]; changed: boolean } {
  // Library 2: conversations / ranked lines / query + entries have their own dialect.
  if (GRAPHIC_COMPONENT_SPECS[p.component].uses.quick) {
    const r = text.trim() ? applyQuickText(p, text) : null;
    if (!r || (!r.props.items.length && r.props.title === p.title)) return { props: p, summary: quickHint(p), warnings: r?.warnings ?? [], changed: false };
    return { props: r.props, summary: r.summary, warnings: r.warnings, changed: GraphicPropsSchema.safeParse(r.props).success };
  }
  const q = parseQuickEntry(text);
  if (!q.series.length && !q.items.length) return { props: p, summary: "Type values like “Employee: 4k x12 | Freelance: 2k, 6k, 0”", warnings: q.warnings, changed: false };
  const r = applyQuickEntry(p, q);
  const ok = GraphicPropsSchema.safeParse(r.props).success;
  return { props: r.props, summary: r.summary, warnings: q.warnings, changed: ok };
}

/** Placeholder / hint for the quick-entry box, per dialect. */
export function quickHint(p: Pick<GraphicProps, "component">): string {
  const u = GRAPHIC_COMPONENT_SPECS[p.component].uses;
  if (u.quick === "CHAT") return "Me: running late | Mom: again?? | Me: rent went up $300";
  if (u.quick === "LINES") return "1. Rent prices 120K | 2. #budget — Trending in Finance 48K";
  if (u.quick === "QUERY") return p.component === "SEARCH_BAR" ? "is a 401k worth it | is a 401k worth it reddit | is a 401k a scam" : "Question? | Option A 62 | Option B 38";
  return u.series ? "Employee: 4k x12 | Freelance: 2k, 6k, 0, 8k | Owner: 0, 5k, -15k, 100k" : "Rent 1800, Food 650, Car 520";
}

/** What a component edits (drives which sections the edit sheet shows). */
export function graphicUses(p: Pick<GraphicProps, "component">) {
  return GRAPHIC_COMPONENT_SPECS[p.component].uses;
}
