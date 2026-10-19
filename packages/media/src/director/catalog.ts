import { GRAPHIC_PRESETS, presetById, type GraphicPreset } from "../graphics/presets";
import { GRAPHIC_COMPONENT_SPECS, GRAPHIC_ICONS, type GraphicComponent } from "../graphics/contract";
import { searchPresets, tokenize } from "../graphics/search";
import { SFX_SOUNDS } from "../motion-contract";

/**
 * The editing vocabulary the Director chat may use — PURE. A compact, relevance-ranked slice
 * of the graphics library (ids + what each shows + its data, so ChatGPT edits a real preset
 * instead of inventing one), a field guide for the components those presets use, the quick-entry
 * dialects, text styles, sounds, zoom and caption options. Any other library id is still
 * accepted by the validator; this list only keeps the message short.
 */

/** Presets that are useful in almost any reaction/storytime edit (always listed). */
export const DIRECTOR_STAPLE_PRESETS = [
  "notif-banner-received",
  "notif-stack-payday",
  "pay-received-500",
  "pay-feed-week",
  "pay-declined-rent",
  "notif-banner-low-balance",
  "classic-counter",
  "classic-kinetic",
] as const;

const STOP = new Set(["i", "me", "my", "the", "a", "an", "and", "or", "then", "it", "is", "to", "of", "in", "on", "at", "for", "that", "this", "with", "so", "be", "was", "were", "just", "like", "get", "got", "getting", "make", "want", "when", "while", "after", "before", "there", "their", "they", "you", "your", "screen", "side", "video", "edit", "seconds", "second"]);

/** Chris's words → the library's words (his "check" is a paycheck, "bills" are payments…). */
const WORD_HINTS: Record<string, string[]> = {
  check: ["paycheck", "payday", "deposit"],
  paycheck: ["payday", "deposit"],
  paid: ["payday", "payment"],
  bills: ["payment", "bills", "subscriptions"],
  bill: ["payment", "bills"],
  utilities: ["bills", "payment"],
  car: ["car", "payment"],
  rent: ["rent", "payment"],
  money: ["payment", "money"],
  disappears: ["balance", "declined"],
  broke: ["low balance", "declined", "broke"],
  balance: ["balance", "low balance"],
};

/** Relevance-ranked presets for what Chris wrote (+ staples), deduplicated, capped. A preset
 * matching MORE of his distinct words ranks above one that matches a single word strongly. */
export function relevantPresets(text: string, limit = 40): GraphicPreset[] {
  const base = [...new Set(tokenize(text).filter((w) => w.length > 2 && !STOP.has(w)))];
  const words = [...new Set([...base, ...base.flatMap((w) => WORD_HINTS[w] ?? [])])];
  const score = new Map<string, number>();
  const hits = new Map<string, number>();
  for (const w of words) {
    searchPresets(w, { limit: 14 }).forEach((h, rank) => {
      score.set(h.preset.id, (score.get(h.preset.id) ?? 0) + h.score / (1 + rank * 0.15));
      hits.set(h.preset.id, (hits.get(h.preset.id) ?? 0) + 1);
    });
  }
  const ranked = [...score.entries()]
    .sort((a, b) => (hits.get(b[0]) ?? 0) - (hits.get(a[0]) ?? 0) || b[1] - a[1])
    .map(([id]) => presetById(id)!)
    .filter(Boolean);
  const staples = DIRECTOR_STAPLE_PRESETS.map((id) => presetById(id)).filter((p): p is GraphicPreset => !!p);
  const out: GraphicPreset[] = [];
  const seen = new Set<string>();
  for (const p of [...staples, ...ranked.slice(0, Math.max(0, limit - staples.length))]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  // Fill with featured presets when the message gave little to search with.
  for (const p of GRAPHIC_PRESETS) {
    if (out.length >= limit) break;
    if (p.featured && !seen.has(p.id)) {
      seen.add(p.id);
      out.push(p);
    }
  }
  return out.slice(0, limit);
}

/** The data a preset carries, compactly (what to change). */
export function presetDataSummary(p: GraphicPreset, maxChars = 220): string {
  const pr = p.props as Record<string, unknown>;
  const keep: Record<string, unknown> = {};
  for (const k of ["variant", "title", "subtitle", "body", "meta", "tone"]) if (pr[k] != null && pr[k] !== "AUTO") keep[k] = pr[k];
  if (Array.isArray(pr.items) && pr.items.length) {
    keep.items = (pr.items as Array<Record<string, unknown>>).slice(0, 4).map((it) => {
      const o: Record<string, unknown> = {};
      for (const k of ["text", "sub", "value", "meta", "icon", "side", "state"]) if (it[k] != null && it[k] !== "NONE") o[k] = it[k];
      return o;
    });
  }
  if (Array.isArray(pr.series) && pr.series.length) keep.series = (pr.series as Array<Record<string, unknown>>).slice(0, 3).map((s) => ({ label: s.label, values: Array.isArray(s.values) ? (s.values as unknown[]).slice(0, 6) : [] }));
  if (p.template !== "GRAPHIC") Object.assign(keep, pr);
  const s = JSON.stringify(keep);
  return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
}

function baseOf(p: GraphicPreset): string {
  return p.template === "GRAPHIC" ? String((p.props as { component?: string }).component) : p.template;
}

const CLASSIC_FIELDS: Record<string, string> = {
  NUMBER_COUNTER: "props: value (number it lands on), from (number it starts at — counts DOWN if bigger), prefix \"$\", suffix, decimals, label",
  KINETIC_TEXT: "props: text (≤120 chars), emphasis [words], style PUNCH|TYPEWRITER|SLIDE_UP",
  STAT_CARD: "props: value (string), label, sublabel, trend UP|DOWN|NONE",
  ICON_3D: "props: icon, caption",
  MONEY_STACK_3D: "props: amount, label",
  TITLE_CARD: "props: title, subtitle (full screen)",
};

/** One line per component: layouts + which fields it reads. */
export function componentGuide(component: string): string {
  if (CLASSIC_FIELDS[component]) return `${component}: ${CLASSIC_FIELDS[component]}`;
  const spec = GRAPHIC_COMPONENT_SPECS[component as GraphicComponent];
  if (!spec) return component;
  const u = spec.uses;
  const L = u.labels ?? {};
  const parts: string[] = [];
  if (spec.variants.length > 1) parts.push(`variant ${spec.variants.map(([id]) => id).join("|")}`);
  if (u.title) parts.push(`title${L.title ? ` (${L.title})` : ""}`);
  if (u.subtitle) parts.push(`subtitle${L.subtitle ? ` (${L.subtitle})` : ""}`);
  if (u.body) parts.push(`body${L.body ? ` (${L.body})` : ""}`);
  if (u.meta) parts.push(`meta (${u.meta})`);
  if (u.items) {
    const f = [`text${L.text ? `=${L.text}` : ""}`];
    if (u.items.sub) f.push(`sub${L.sub ? `=${L.sub}` : ""}`);
    if (u.items.value) f.push(`value${L.value ? `=${L.value}` : ""}`);
    if (u.items.icon) f.push("icon");
    if (u.items.meta) f.push(`meta=${u.items.meta}`);
    if (u.items.side) f.push("side ME|THEM");
    if (u.items.state) f.push("state DONE|TODO|NO");
    if (u.items.op) f.push("op PLUS|MINUS|EQUALS");
    parts.push(`items ${u.items.count[0]}–${u.items.count[1]} [${f.join(", ")}]`);
  }
  if (u.series) parts.push(`series ${u.series.count[0]}–${u.series.count[1]} [label, values ${u.series.values[0]}–${u.series.values[1]}]`);
  if (u.categories) parts.push("categories");
  if (u.tone) parts.push("tone DARK|LIGHT");
  if (u.quick) parts.push(`quick=${u.quick}`);
  return `${component} (${spec.label}): ${parts.join(" · ")}`;
}

export const QUICK_ENTRY_GUIDE = `QUICK ENTRY ("quick" field — numbers, parsed by the app):
  "Rent -1450, Car -520, Utilities -230"  → entries with values (label + number pairs)
  "Income: 4k x12 | Rent: 1.8k x12"        → named series (charts)
  "$2,400" · "45%" · "1.2M" · "(15k)" = -15000
"lines" field — CHAT: "Me: … | Them: …"; LINES / notifications / lists: one entry per line ("Title — message" or "Title: message").`;

export const TEXT_STYLE_GUIDE = `TEXT STYLES (addText.style): HEADLINE (bold white on a dark plate — titles, the ending line) · PUNCH (huge bold, no plate — one-word reactions) · CAPTION (smaller white with outline) · LOWER_THIRD (name/label bar) · NUMBER (big gold number). size S|M|L.`;

/** The whole vocabulary block for a pack. `focusText` = Chris's message (+ recent turns). */
export function directorCatalogText(focusText: string, limit = 40): string {
  const presets = relevantPresets(focusText, limit);
  const comps = [...new Set(presets.map(baseOf))];
  const lines = presets.map((p) => `- ${p.id} · ${p.name} — ${p.description} [${baseOf(p)}${(p.props as { variant?: string }).variant ? `/${(p.props as { variant?: string }).variant}` : ""}, ${p.seconds}s] data: ${presetDataSummary(p)}`);
  return [
    `GRAPHICS (most relevant to this video; every id from the app's ${GRAPHIC_PRESETS.length}-graphic library also works). Use "props"/"quick"/"lines" to put YOUR data in — never leave the example data on screen:`,
    ...lines,
    "",
    "FIELDS per component:",
    ...comps.map((c) => `- ${componentGuide(c)}`),
    `Item colors: AUTO|PRIMARY|SECONDARY|POSITIVE (green)|NEGATIVE (red)|INK|MUTED. Icons (items[].icon): ${GRAPHIC_ICONS.slice(0, 60).join(" ")} …`,
    `Money format: "format": {"kind":"CURRENCY","compact":"NONE"} (full digits) · negative values show red with a minus.`,
    "",
    QUICK_ENTRY_GUIDE,
    "",
    TEXT_STYLE_GUIDE,
    `SOUNDS (sfx / addSfx.sound): ${SFX_SOUNDS.join(" ")} (CASH = cha-ching).`,
    `ZOOM: amount 1.1–1.3 = punch-in on his face ("mode":"CUT" for a snap, "EASE" for a slow push).`,
    `CAPTIONS: setCaptions enabled true/false, style CLEAN|BOLD_HIGHLIGHT|BOXED|KARAOKE (only matters when he speaks).`,
  ].join("\n");
}
