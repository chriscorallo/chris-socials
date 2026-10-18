"use client";

import { useMemo, useState } from "react";
import {
  GRAPHIC_COLORS,
  GRAPHIC_COMPONENT_SPECS,
  GRAPHIC_EMPHASES,
  GRAPHIC_ENTRANCES,
  GRAPHIC_EXITS,
  GRAPHIC_ICONS,
  GRAPHIC_LIMITS,
  GRAPHIC_OPS,
  GRAPHIC_ORDERS,
  GRAPHIC_STATES,
  formatGraphicValue,
  parseQuickEntry,
  parseQuickNumber,
  presetById,
  toQuickEntry,
  type GraphicFormat,
  type GraphicProps,
  type TimelineVisual,
} from "@chris/media/timeline";
import {
  addColumn,
  addItem,
  addRow,
  fillRow,
  graphicPropsOf,
  moveItem,
  quickEntryInto,
  removeColumn,
  removeItem,
  removeRow,
  setCell,
  setGraphic,
  setItem,
  setSeries,
} from "../../../../lib/editor/graphics";
import { useEditor } from "./context";
import { Section, Seg, Slider, Toggle } from "./Inspector";
import { Icon } from "./icons";
import "./graphics.css";

/**
 * The edit sheet for a library graphic (template GRAPHIC), generated from its component's
 * spec (which parts of the data model it reads): quick entry (type "Employee: 4k x12 | …"),
 * a data table (rows = people/series × columns = values; add/remove rows and columns, repeat
 * fill "4k x12", text cells for tables), list entries, text, format (currency/percent, k/M,
 * decimals, signs, red negatives, prefix/suffix), layout, full-screen, and animation (entrance
 * style, order, stagger, speed, count-up, emphasis, exit). Every change is one undo step and
 * the preview updates live — it's the same renderer.
 */
export function GraphicEditor({ v, onNumbersTouched }: { v: TimelineVisual; onNumbersTouched: () => void }) {
  const { apply } = useEditor();
  const p = graphicPropsOf(v);
  if (!p) {
    return <p className="ed-ai-error">This graphic&apos;s data can&apos;t be read — remove it and add it again from the library.</p>;
  }
  const spec = GRAPHIC_COMPONENT_SPECS[p.component];
  const u = spec.uses;
  const set = (next: GraphicProps, key: string, number = false) => {
    if (number) onNumbersTouched();
    apply((d) => setGraphic(d, v.id, next), { coalesce: `g:${v.id}:${key}` });
  };
  const preset = presetById(p.preset);
  return (
    <>
      <Section title={preset ? `Layout · ${spec.label}` : spec.label}>
        {spec.variants.length > 1 && (
          <Chips label="Layout" value={p.variant ?? spec.variants[0]![0]} options={spec.variants.map(([id, l]) => [id, l])} onChange={(variant) => set({ ...p, variant }, "variant")} />
        )}
        {spec.kind !== "FULL_FRAME" && (
          <div>
            <span className="ed-label">Screen</span>
            <Seg label="Screen" value={p.screen} options={[["OVERLAY", "Over the video"], ["FULL", "Full screen"]]} onChange={(screen) => set({ ...p, screen }, "screen")} />
          </div>
        )}
      </Section>

      {(u.series || u.items) && <QuickEntry key={v.id} p={p} onApply={(next) => set(next, "quick", true)} />}

      {(u.title || u.subtitle || u.body) && (
        <Section title="Text">
          {u.title && <TextInput label={p.component === "KINETIC" ? "Key word(s)" : u.titleRequired ? "Title" : "Title (optional)"} value={p.title} max={GRAPHIC_LIMITS.title} onChange={(title) => set({ ...p, title }, "title", true)} />}
          {u.subtitle && <TextInput label="Subtitle (optional)" value={p.subtitle} max={GRAPHIC_LIMITS.subtitle} onChange={(subtitle) => set({ ...p, subtitle }, "subtitle", true)} />}
          {u.body && <TextInput label="Text" value={p.body} max={GRAPHIC_LIMITS.body} multiline onChange={(body) => set({ ...p, body }, "body", true)} />}
        </Section>
      )}

      {u.series && <DataTable p={p} set={set} />}
      {u.items && <ItemsList p={p} set={set} />}

      {(u.highlight || u.total || u.range) && (
        <Section title="Options">
          {u.highlight && <HighlightPick p={p} onChange={(highlight) => set({ ...p, highlight }, "highlight")} />}
          {u.total && <Toggle label="Show totals" checked={p.showTotal} onChange={(showTotal) => set({ ...p, showTotal }, "total", true)} />}
          {u.range && <RangeFields p={p} onChange={(range) => set({ ...p, range }, "range", true)} />}
        </Section>
      )}

      {(u.series || u.items?.value || p.component === "STICKER") && <FormatSection p={p} onChange={(format) => set({ ...p, format }, "format")} />}
      <AnimationSection p={p} onChange={(animation) => set({ ...p, animation }, "anim")} />
    </>
  );
}

// --------------------------------------------------------------------------- small controls

function Chips<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div>
      <span className="ed-label">{label}</span>
      <div className="ed-chips" role="group" aria-label={label}>
        {options.map(([o, l]) => (
          <button key={o} type="button" className="ed-chip-btn" aria-pressed={value === o} onClick={() => onChange(o)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

function TextInput({ label, value, max, multiline, onChange }: { label: string; value: string | null; max: number; multiline?: boolean; onChange: (v: string | null) => void }) {
  const v = value ?? "";
  const handle = (s: string) => onChange(s.trim() === "" ? null : s.slice(0, max));
  return (
    <label className="block">
      <span className="ed-label">
        <span className="flex justify-between gap-2">
          <span>{label}</span>
          <span className="tabular-nums text-[var(--color-text-faint)]">
            {v.length}/{max}
          </span>
        </span>
      </span>
      {multiline ? (
        <textarea className="ed-input" rows={2} value={v} maxLength={max} aria-label={label} onChange={(e) => handle(e.target.value.replace(/\n/g, " "))} />
      ) : (
        <input className="ed-input" value={v} maxLength={max} aria-label={label} onChange={(e) => handle(e.target.value)} enterKeyHint="done" />
      )}
    </label>
  );
}

function shortNum(n: number): string {
  const a = Math.abs(n);
  const s = a >= 1e6 && (a / 1e6) * 10 === Math.round((a / 1e6) * 10) ? `${a / 1e6}m` : a >= 1e3 && (a / 1e3) * 10 === Math.round((a / 1e3) * 10) ? `${a / 1e3}k` : String(a);
  return n < 0 ? `-${s}` : s;
}

/** A value cell: type "4k", "-$15k", "1,200", "45%" — commits on blur / Enter. */
function ValueInput({ value, label, onCommit, className }: { value: number | null; label: string; onCommit: (n: number | null) => void; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? "" : shortNum(value));
  const commit = () => {
    if (draft === null) return;
    const t = draft.trim();
    setDraft(null);
    if (t === "") return onCommit(null);
    const n = parseQuickNumber(t);
    if (n) onCommit(n.value);
  };
  const bad = draft !== null && draft.trim() !== "" && !parseQuickNumber(draft);
  return (
    <input
      className={`ed-input gl-cell ${bad ? "gl-cell-bad" : ""} ${value !== null && value < 0 ? "gl-cell-neg" : ""} ${className ?? ""}`}
      inputMode="text"
      value={shown}
      aria-label={label}
      aria-invalid={bad}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

const ICON_OPTIONS: Array<[string, string]> = [["", "No icon"], ...GRAPHIC_ICONS.map((i) => [i, i.toLowerCase().replace(/_/g, " ")] as [string, string])];

function IconSelect({ value, label, onChange }: { value: string | null; label: string; onChange: (v: string | null) => void }) {
  return (
    <select className="ed-input gl-select" value={value ?? ""} aria-label={label} onChange={(e) => onChange(e.target.value || null)}>
      {ICON_OPTIONS.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

const COLOR_LABEL: Record<(typeof GRAPHIC_COLORS)[number], string> = { AUTO: "Auto colour", PRIMARY: "Gold", SECONDARY: "Violet", POSITIVE: "Green", NEGATIVE: "Red", INK: "White", MUTED: "Grey" };

function ColorSelect({ value, label, onChange }: { value: (typeof GRAPHIC_COLORS)[number]; label: string; onChange: (v: (typeof GRAPHIC_COLORS)[number]) => void }) {
  return (
    <select className="ed-input gl-select" value={value} aria-label={label} onChange={(e) => onChange(e.target.value as (typeof GRAPHIC_COLORS)[number])}>
      {GRAPHIC_COLORS.map((c) => (
        <option key={c} value={c}>
          {COLOR_LABEL[c]}
        </option>
      ))}
    </select>
  );
}

// --------------------------------------------------------------------------- quick entry

function QuickEntry({ p, onApply }: { p: GraphicProps; onApply: (next: GraphicProps) => void }) {
  const [text, setText] = useState(() => toQuickEntry(p));
  const preview = useMemo(() => quickEntryInto(p, text), [p, text]);
  const parsed = useMemo(() => parseQuickEntry(text), [text]);
  const example = GRAPHIC_COMPONENT_SPECS[p.component].uses.series ? "Employee: 4k x12 | Freelance: 2k, 6k, 0, 8k | Owner: 0, 5k, -15k, 100k" : "Rent 1800, Food 650, Car 520";
  return (
    <Section title="Quick entry">
      <textarea
        className="ed-input gl-quick"
        rows={3}
        value={text}
        placeholder={example}
        aria-label="Quick entry"
        spellCheck={false}
        autoCapitalize="off"
        onChange={(e) => setText(e.target.value)}
      />
      <p className="gl-quick-hint">
        {parsed.series.length || parsed.items.length ? (
          <>
            <Icon name="check" size={12} /> {preview.summary}
          </>
        ) : (
          <>Separate people with “|”, values with commas. “4k x12” repeats; “-15k” or “(15k)” is negative; $ and % set the format.</>
        )}
      </p>
      {preview.warnings.length > 0 && <p className="gl-quick-warn">{preview.warnings.slice(0, 2).join(" ")}</p>}
      <button type="button" className="btn btn-primary !py-2 !text-[13px]" disabled={!preview.changed} onClick={() => onApply(preview.props)}>
        Apply to graphic
      </button>
    </Section>
  );
}

// --------------------------------------------------------------------------- data table

function DataTable({ p, set }: { p: GraphicProps; set: (next: GraphicProps, key: string, number?: boolean) => void }) {
  const u = GRAPHIC_COMPONENT_SPECS[p.component].uses;
  const sp = u.series!;
  const cols = Math.max(0, ...p.series.map((s) => s.values.length));
  const [fill, setFill] = useState<Record<number, string>>({});
  const rowWord = sp.label === "ENTITY" ? "person" : sp.label === "ROW" ? "row" : "series";
  return (
    <Section title={`Data · ${p.series.length} ${rowWord}${p.series.length === 1 ? "" : sp.label === "ENTITY" ? "s" : p.series.length === 1 ? "" : "s"} × ${cols}`}>
      <div className="gl-table-wrap">
        <table className="gl-table">
          {u.categories && (
            <thead>
              <tr>
                <th className="gl-th-label">Labels</th>
                {Array.from({ length: cols }, (_, j) => (
                  <th key={j}>
                    <input
                      className="ed-input gl-cell gl-cat"
                      value={p.categories[j] ?? ""}
                      placeholder={`#${j + 1}`}
                      maxLength={GRAPHIC_LIMITS.category}
                      aria-label={`Column ${j + 1} label`}
                      onChange={(e) => {
                        const categories = [...p.categories];
                        while (categories.length <= j) categories.push("");
                        categories[j] = e.target.value.slice(0, GRAPHIC_LIMITS.category);
                        set({ ...p, categories }, `cat${j}`);
                      }}
                    />
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {p.series.map((s, i) => (
              <tr key={i}>
                <th className="gl-th-label">
                  <input className="ed-input gl-cell gl-row-label" value={s.label} placeholder={`Row ${i + 1}`} maxLength={GRAPHIC_LIMITS.seriesLabel} aria-label={`Row ${i + 1} name`} onChange={(e) => set(setSeries(p, i, { label: e.target.value }), `label${i}`, true)} />
                </th>
                {Array.from({ length: cols }, (_, j) => {
                  const text = s.texts[j];
                  if (p.component === "TABLE" && text) {
                    return (
                      <td key={j}>
                        <input className="ed-input gl-cell" value={text} maxLength={GRAPHIC_LIMITS.cellText} aria-label={`${s.label || `Row ${i + 1}`} ${p.categories[j] ?? `#${j + 1}`}`} onChange={(e) => set(setSeries(p, i, { texts: s.texts.map((t, k) => (k === j ? e.target.value : t)) }), `t${i}:${j}`, true)} />
                      </td>
                    );
                  }
                  return (
                    <td key={j}>
                      <ValueInput value={j < s.values.length ? s.values[j]! : null} label={`${s.label || `Row ${i + 1}`} ${p.categories[j] ?? `value ${j + 1}`}`} onCommit={(n) => set(setCell(p, i, j, n ?? 0), `c${i}:${j}`, true)} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="gl-table-actions">
        <button type="button" className="ed-toolbtn" onClick={() => set(addRow(p), "addrow")} disabled={p.series.length >= sp.count[1]}>
          <Icon name="plus" size={13} /> {sp.label === "ENTITY" ? "Person" : "Row"}
        </button>
        <button type="button" className="ed-toolbtn" onClick={() => set(addColumn(p), "addcol")} disabled={cols >= sp.values[1]}>
          <Icon name="plus" size={13} /> Column
        </button>
        <button type="button" className="ed-toolbtn" onClick={() => set(removeColumn(p, cols - 1), "rmcol")} disabled={cols <= sp.values[0]}>
          <Icon name="close" size={13} /> Last column
        </button>
      </div>
      <div className="flex flex-col gap-2">
        {p.series.map((s, i) => (
          <div key={i} className="gl-row-tools">
            <span className="gl-row-name">{s.label || `Row ${i + 1}`}</span>
            <IconSelect value={s.icon} label={`${s.label} icon`} onChange={(icon) => set(setSeries(p, i, { icon: icon as GraphicProps["series"][number]["icon"] }), `icon${i}`)} />
            <ColorSelect value={s.color} label={`${s.label} colour`} onChange={(color) => set(setSeries(p, i, { color }), `color${i}`)} />
            <div className="gl-fill">
              <input
                className="ed-input gl-cell"
                value={fill[i] ?? ""}
                placeholder="Fill: 4k x12"
                aria-label={`Fill ${s.label} values`}
                onChange={(e) => setFill({ ...fill, [i]: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const r = fillRow(p, i, fill[i] ?? "");
                    if (r.ok) {
                      set(r.props, `fill${i}`, true);
                      setFill({ ...fill, [i]: "" });
                    }
                  }
                }}
              />
              <button
                type="button"
                className="ed-toolbtn"
                disabled={!fill[i]}
                onClick={() => {
                  const r = fillRow(p, i, fill[i] ?? "");
                  if (r.ok) {
                    set(r.props, `fill${i}`, true);
                    setFill({ ...fill, [i]: "" });
                  }
                }}
              >
                Fill
              </button>
            </div>
            <button type="button" className="ed-row-remove" onClick={() => set(removeRow(p, i), "rmrow")} disabled={p.series.length <= sp.count[0]} aria-label={`Remove ${s.label || `row ${i + 1}`}`}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}

// --------------------------------------------------------------------------- items

const OP_LABEL: Record<(typeof GRAPHIC_OPS)[number], string> = { NONE: "start", PLUS: "+", MINUS: "−", TIMES: "×", DIVIDE: "÷", EQUALS: "=" };
const STATE_LABEL: Record<(typeof GRAPHIC_STATES)[number], string> = { NONE: "—", DONE: "✓ done", TODO: "○ to do", NO: "✕ no" };

function ItemsList({ p, set }: { p: GraphicProps; set: (next: GraphicProps, key: string, number?: boolean) => void }) {
  const u = GRAPHIC_COMPONENT_SPECS[p.component].uses.items!;
  return (
    <Section title={`Entries · ${p.items.length}`} right={
      <button type="button" className="ed-toolbtn !text-[12px]" onClick={() => set(addItem(p), "additem")} disabled={p.items.length >= u.count[1]}>
        <Icon name="plus" size={13} /> Add
      </button>
    }>
      {p.items.map((it, i) => (
        <div key={i} className="gl-item">
          <div className="gl-item-top">
            <span className="ed-row-n">{i + 1}</span>
            <input className="ed-input" value={it.text} maxLength={GRAPHIC_LIMITS.itemText} placeholder="Label" aria-label={`Entry ${i + 1} label`} onChange={(e) => set(setItem(p, i, { text: e.target.value }), `it${i}`, /\d/.test(e.target.value))} />
            {u.value && <ValueInput className="gl-item-val" value={it.value} label={`Entry ${i + 1} value`} onCommit={(n) => set(setItem(p, i, { value: n }), `iv${i}`, true)} />}
          </div>
          <div className="gl-item-more">
            {u.sub && <input className="ed-input" value={it.sub ?? ""} maxLength={GRAPHIC_LIMITS.itemSub} placeholder="Small line (optional)" aria-label={`Entry ${i + 1} small line`} onChange={(e) => set(setItem(p, i, { sub: e.target.value || null }), `is${i}`, /\d/.test(e.target.value))} />}
            {u.icon && <IconSelect value={it.icon} label={`Entry ${i + 1} icon`} onChange={(icon) => set(setItem(p, i, { icon: icon as GraphicProps["items"][number]["icon"] }), `ii${i}`)} />}
            {u.op && (
              <select className="ed-input gl-select" value={it.op} aria-label={`Entry ${i + 1} operator`} onChange={(e) => set(setItem(p, i, { op: e.target.value as (typeof GRAPHIC_OPS)[number] }), `io${i}`)}>
                {GRAPHIC_OPS.map((o) => (
                  <option key={o} value={o}>
                    {OP_LABEL[o]}
                  </option>
                ))}
              </select>
            )}
            {u.state && (
              <select className="ed-input gl-select" value={it.state} aria-label={`Entry ${i + 1} state`} onChange={(e) => set(setItem(p, i, { state: e.target.value as (typeof GRAPHIC_STATES)[number] }), `ist${i}`)}>
                {GRAPHIC_STATES.map((o) => (
                  <option key={o} value={o}>
                    {STATE_LABEL[o]}
                  </option>
                ))}
              </select>
            )}
            <ColorSelect value={it.color} label={`Entry ${i + 1} colour`} onChange={(color) => set(setItem(p, i, { color }), `ic${i}`)} />
            <span className="gl-item-btns">
              <button type="button" className="ed-row-remove" onClick={() => set(moveItem(p, i, -1), "mv")} disabled={i === 0} aria-label={`Move entry ${i + 1} up`}>
                ↑
              </button>
              <button type="button" className="ed-row-remove" onClick={() => set(removeItem(p, i), "rmitem")} disabled={p.items.length <= u.count[0]} aria-label={`Remove entry ${i + 1}`}>
                <Icon name="trash" size={14} />
              </button>
            </span>
          </div>
        </div>
      ))}
    </Section>
  );
}

function HighlightPick({ p, onChange }: { p: GraphicProps; onChange: (v: number | null) => void }) {
  const u = GRAPHIC_COMPONENT_SPECS[p.component].uses;
  const names: string[] =
    u.highlight === "SERIES"
      ? p.series.map((s, i) => s.label || `#${i + 1}`)
      : u.highlight === "ITEMS"
        ? p.items.map((it, i) => it.text || `#${i + 1}`)
        : Array.from({ length: Math.max(0, ...p.series.map((s) => s.values.length), p.categories.length) }, (_, i) => p.categories[i] || `#${i + 1}`);
  const options: Array<[string, string]> = [["none", "None"], ...names.slice(0, 36).map((n, i) => [String(i), n] as [string, string])];
  return <Chips label="Highlight" value={p.highlight === null ? "none" : String(p.highlight)} options={options} onChange={(x) => onChange(x === "none" ? null : Number(x))} />;
}

function RangeFields({ p, onChange }: { p: GraphicProps; onChange: (r: GraphicProps["range"]) => void }) {
  const r = p.range ?? { min: 0, max: 100 };
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="block">
        <span className="ed-label">Scale from</span>
        <ValueInput value={r.min} label="Scale from" onCommit={(n) => n !== null && n < r.max && onChange({ ...r, min: n })} />
      </label>
      <label className="block">
        <span className="ed-label">Scale to</span>
        <ValueInput value={r.max} label="Scale to" onCommit={(n) => n !== null && n > r.min && onChange({ ...r, max: n })} />
      </label>
    </div>
  );
}

// --------------------------------------------------------------------------- format + animation

function FormatSection({ p, onChange }: { p: GraphicProps; onChange: (f: GraphicFormat) => void }) {
  const f = p.format;
  const sample = p.series.flatMap((s) => s.values).concat(p.items.flatMap((i) => (i.value === null ? [] : [i.value])));
  const example = sample.length ? sample.slice(0, 3) : [4000, -15000];
  return (
    <Section title="Numbers" right={<span className="gl-format-ex">{example.map((n) => formatGraphicValue(n, f)).join("  ")}</span>}>
      <div>
        <span className="ed-label">Kind</span>
        <Seg label="Number kind" value={f.kind} options={[["NUMBER", "1,234"], ["CURRENCY", `${f.currency}`], ["PERCENT", "%"]]} onChange={(kind) => onChange({ ...f, kind })} />
      </div>
      <Chips label="Short form" value={f.compact} options={[["AUTO", "Auto (4k)"], ["NONE", "Full (4,000)"], ["K", "k"], ["M", "M"]]} onChange={(compact) => onChange({ ...f, compact })} />
      <Chips label="Decimals" value={f.decimals === null ? "AUTO" : String(f.decimals)} options={[["AUTO", "Auto"], ["0", "0"], ["1", "0.0"], ["2", "0.00"]]} onChange={(d) => onChange({ ...f, decimals: d === "AUTO" ? null : Number(d) })} />
      <div>
        <span className="ed-label">Signs</span>
        <Seg label="Signs" value={f.signs} options={[["NEGATIVE", "−15k"], ["ALWAYS", "+5k / −15k"]]} onChange={(signs) => onChange({ ...f, signs })} />
      </div>
      <Toggle label="Negatives in red" checked={f.negativeRed} onChange={(negativeRed) => onChange({ ...f, negativeRed })} />
      <div className="grid grid-cols-3 gap-2">
        <label className="block">
          <span className="ed-label">Currency</span>
          <input className="ed-input" value={f.currency} maxLength={3} aria-label="Currency symbol" onChange={(e) => onChange({ ...f, currency: e.target.value.slice(0, 3) || "$" })} />
        </label>
        <label className="block">
          <span className="ed-label">Before</span>
          <input className="ed-input" value={f.prefix} maxLength={4} placeholder="~" aria-label="Before every number" onChange={(e) => onChange({ ...f, prefix: e.target.value.slice(0, 4) })} />
        </label>
        <label className="block">
          <span className="ed-label">After</span>
          <input className="ed-input" value={f.suffix} maxLength={8} placeholder="/mo" aria-label="After every number" onChange={(e) => onChange({ ...f, suffix: e.target.value.slice(0, 8) })} />
        </label>
      </div>
    </Section>
  );
}

const ENTER_LABEL: Record<(typeof GRAPHIC_ENTRANCES)[number], string> = { RISE: "Rise", POP: "Pop", FADE: "Fade", SLIDE: "Slide", WIPE: "Wipe", DROP: "Drop", FLIP: "Flip", BLUR: "Blur" };
const ORDER_LABEL: Record<(typeof GRAPHIC_ORDERS)[number], string> = { TOGETHER: "All together", STAGGER: "One after another", GROUP_BY_GROUP: "Person by person", ONE_BY_ONE: "Strictly one by one" };
const EMPH_LABEL: Record<(typeof GRAPHIC_EMPHASES)[number], string> = { NONE: "None", PULSE: "Pulse", GLOW: "Glow", RING: "Ring", SHAKE: "Shake" };
const EXIT_LABEL: Record<(typeof GRAPHIC_EXITS)[number], string> = { CONTAINER: "With the graphic", REVERSE: "Reverse", DROP: "Drop", FADE_UP: "Float up" };

function AnimationSection({ p, onChange }: { p: GraphicProps; onChange: (a: GraphicProps["animation"]) => void }) {
  const a = p.animation;
  return (
    <Section title="Animation">
      <Chips label="Elements come in" value={a.enter} options={Object.entries(ENTER_LABEL) as Array<[(typeof GRAPHIC_ENTRANCES)[number], string]>} onChange={(enter) => onChange({ ...a, enter })} />
      <Chips label="Order" value={a.order} options={Object.entries(ORDER_LABEL) as Array<[(typeof GRAPHIC_ORDERS)[number], string]>} onChange={(order) => onChange({ ...a, order })} />
      <Slider label="Gap between elements" value={a.stagger} min={0} max={0.5} step={0.01} format={(x) => `${x.toFixed(2)}s`} resetTo={0.08} onChange={(stagger) => onChange({ ...a, stagger })} />
      {a.order === "GROUP_BY_GROUP" && <Slider label="Pause between people" value={a.groupPause} min={0} max={1.5} step={0.05} format={(x) => `${x.toFixed(2)}s`} resetTo={0.35} onChange={(groupPause) => onChange({ ...a, groupPause })} />}
      <Slider label="Speed" value={a.speed} min={0.5} max={2} step={0.05} format={(x) => `${x.toFixed(2)}×`} resetTo={1} onChange={(speed) => onChange({ ...a, speed })} />
      <Toggle label="Numbers count up" checked={a.countUp} onChange={(countUp) => onChange({ ...a, countUp })} />
      <Chips label="Highlight does" value={a.emphasis} options={Object.entries(EMPH_LABEL) as Array<[(typeof GRAPHIC_EMPHASES)[number], string]>} onChange={(emphasis) => onChange({ ...a, emphasis })} />
      <Chips label="Elements leave" value={a.exit} options={Object.entries(EXIT_LABEL) as Array<[(typeof GRAPHIC_EXITS)[number], string]>} onChange={(exit) => onChange({ ...a, exit })} />
      <p className="gl-quick-hint">The build always fits the graphic&apos;s time on screen — make it longer on the timeline for a slower reveal. “Hit on my emphasis” below lands the highlight on your voice.</p>
    </Section>
  );
}
