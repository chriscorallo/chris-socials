"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import {
  findFont,
  layoutTimelineText,
  layoutCaptionChunk,
  resolveGrade,
  GRADE_PRESETS,
  GRADE_PRESET_VALUES,
  LAYOUT,
  type TimelineText,
  type TimelineCaptionChunk,
  type TimelineGrade,
  type TextElementLayout,
  type TimelineCaptionLayout,
} from "@chris/media/timeline";
import { updateText, updateCaptions } from "../../../../lib/editor/timeline-ops";
import { gradeSvgParams, hexToRgba } from "../../../../lib/editor/preview-math";
import { useEditor } from "./context";
import { usePlayheadValue } from "./playback";
import { browserMeasureText } from "./measure";

/**
 * Text and caption overlays, drawn in an SVG whose viewBox is the CANVAS (1080x1920 px by
 * default), using the renderer's own layout functions (layoutTimelineText /
 * layoutCaptionChunk) with browser glyph measurement — so line breaks, baselines, plates,
 * strokes and word positions are the ones the renderer burns in. SVG <text> gives an
 * alphabetic baseline at `y` natively, exactly like drawtext/libass.
 */

const SNAP_PX = 6;

export function fontFamilyCss(fontId: string): string {
  const f = findFont(fontId);
  return f ? `"${f.family}", "Inter", sans-serif` : `"Inter", sans-serif`;
}

export function fontStyle(fontId: string, fontPx: number): CSSProperties {
  const f = findFont(fontId);
  return {
    fontFamily: fontFamilyCss(fontId),
    fontWeight: f?.weight ?? 700,
    fontSize: fontPx,
    fontKerning: "none",
    fontVariantLigatures: "none",
    letterSpacing: 0,
    whiteSpace: "pre",
  };
}

// ---------------------------------------------------------------------------------------
// Grade (SVG filter — PREVIEW PARITY NOTES)
// ---------------------------------------------------------------------------------------

function GradeFilter({ id, grade }: { id: string; grade: TimelineGrade }) {
  const p = gradeSvgParams(resolveGrade(grade));
  return (
    <filter id={id} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
      <feComponentTransfer>
        <feFuncR type="linear" slope={p.slope} intercept={p.intercept} />
        <feFuncG type="linear" slope={p.slope} intercept={p.intercept} />
        <feFuncB type="linear" slope={p.slope} intercept={p.intercept} />
      </feComponentTransfer>
      <feColorMatrix type="saturate" values={String(p.saturation)} />
      <feColorMatrix type="matrix" values={p.matrix} />
    </filter>
  );
}

/** Hidden <svg> holding the live grade filter (`#ed-grade`) and one per preset (`#ed-grade-<P>`). */
export function GradeDefs({ grade }: { grade: TimelineGrade }) {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
      <defs>
        <GradeFilter id="ed-grade" grade={grade} />
        {GRADE_PRESETS.map((p) => (
          <GradeFilter key={p} id={`ed-grade-${p}`} grade={{ preset: p, ...GRADE_PRESET_VALUES.NONE }} />
        ))}
      </defs>
    </svg>
  );
}

// ---------------------------------------------------------------------------------------
// Shared drawing
// ---------------------------------------------------------------------------------------

function Plate({ plate }: { plate: TextElementLayout["plate"] }) {
  if (!plate) return null;
  const r = plate.rect;
  return <rect x={r.x} y={r.y} width={r.width} height={r.height} rx={plate.radius} ry={plate.radius} fill={hexToRgba(plate.color)} />;
}

function strokeProps(color: string | null, sw: number) {
  return color && sw > 0
    ? { stroke: hexToRgba(color), strokeWidth: 2 * sw, strokeLinejoin: "round" as const, paintOrder: "stroke fill" }
    : {};
}

// ---------------------------------------------------------------------------------------
// Overlay root
// ---------------------------------------------------------------------------------------

export function OverlaySvg({ w, h, onDragging }: { w: number; h: number; onDragging: (v: boolean) => void }) {
  const { doc, fontsVersion } = useEditor();
  const W = doc.canvas.width;
  const H = doc.canvas.height;
  const [guides, setGuides] = useState({ v: false, h: false });
  const [editing, setEditing] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const k = w / W;
  // Client-only: text layout needs real (loaded) font metrics; SSR has none.
  if (fontsVersion === 0) return null;
  return (
    <>
      <svg
        ref={svgRef}
        className="absolute left-0 top-0 z-[6]"
        width={w}
        height={h}
        viewBox={`0 0 ${W} ${H}`}
        style={{ pointerEvents: "none", overflow: "visible" }}
      >
        <CaptionLayer k={k} onDragging={onDragging} />
        <TextLayer k={k} svgRef={svgRef} onGuides={setGuides} onDragging={onDragging} editing={editing} onEdit={setEditing} />
        {guides.v && <line x1={W / 2} x2={W / 2} y1={0} y2={H} stroke="#ff5fa2" strokeWidth={1.5 / k} />}
        {guides.h && <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="#ff5fa2" strokeWidth={1.5 / k} />}
      </svg>
      {editing && <InlineTextEditor id={editing} k={k} onDone={() => setEditing(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------------------

function TextLayer({
  k,
  svgRef,
  onGuides,
  onDragging,
  editing,
  onEdit,
}: {
  k: number;
  svgRef: React.RefObject<SVGSVGElement | null>;
  onGuides: (g: { v: boolean; h: boolean }) => void;
  onDragging: (v: boolean) => void;
  editing: string | null;
  onEdit: (id: string) => void;
}) {
  const { doc, engine, state, fontsVersion } = useEditor();
  const visibleKey = usePlayheadValue(engine, (t) =>
    doc.texts
      .filter((x) => t >= x.start && t < x.end)
      .map((x) => x.id)
      .join(","),
  );
  const visible = new Set(visibleKey ? visibleKey.split(",") : []);
  const selectedId = state.selection?.kind === "text" ? state.selection.id : null;
  return (
    <>
      {doc.texts
        .filter((t) => visible.has(t.id))
        .map((t) => (
          <TextItem
            key={t.id}
            t={t}
            k={k}
            selected={t.id === selectedId}
            hidden={editing === t.id}
            fontsVersion={fontsVersion}
            svgRef={svgRef}
            onGuides={onGuides}
            onDragging={onDragging}
            onEdit={() => onEdit(t.id)}
          />
        ))}
    </>
  );
}

function TextItem({
  t,
  k,
  selected,
  hidden,
  fontsVersion,
  svgRef,
  onGuides,
  onDragging,
  onEdit,
}: {
  t: TimelineText;
  k: number;
  selected: boolean;
  hidden: boolean;
  fontsVersion: number;
  svgRef: React.RefObject<SVGSVGElement | null>;
  onGuides: (g: { v: boolean; h: boolean }) => void;
  onDragging: (v: boolean) => void;
  onEdit: () => void;
}) {
  const { apply, commit, dispatch, engine, setUi, doc } = useEditor();
  const W = doc.canvas.width;
  const H = doc.canvas.height;
  const L = useMemo(() => layoutTimelineText(t, doc.canvas, browserMeasureText), [t, doc.canvas, fontsVersion]);
  const r = L.rect;

  const onPointerDown = (e: RPointerEvent<SVGGElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    engine.pause();
    dispatch({ type: "select", selection: { kind: "text", id: t.id } });
    setUi({ tab: "selection" });
    const start = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y };
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / k;
      const dy = (ev.clientY - start.y) / k;
      if (!moved && Math.hypot(dx * k, dy * k) < 3) return;
      if (!moved) onDragging(true);
      moved = true;
      let nx = start.tx + dx / W;
      let ny = start.ty + dy / H;
      const snapV = Math.abs(nx - 0.5) * W * k < SNAP_PX;
      const snapH = Math.abs(ny - 0.5) * H * k < SNAP_PX;
      if (snapV) nx = 0.5;
      if (snapH) ny = 0.5;
      onGuides({ v: snapV, h: snapH });
      nx = Math.round(Math.min(1, Math.max(0, nx)) * 1000) / 1000;
      ny = Math.round(Math.min(1, Math.max(0, ny)) * 1000) / 1000;
      apply((d) => updateText(d, t.id, { x: nx, y: ny }), { coalesce: `move:${t.id}` });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onGuides({ v: false, h: false });
      onDragging(false);
      commit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onResizeDown = (e: RPointerEvent<SVGRectElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const cx = box.left + (r.x + r.width / 2) * k;
    const cy = box.top + (r.y + r.height / 2) * k;
    const d0 = Math.max(8, Math.hypot(e.clientX - cx, e.clientY - cy));
    const fs0 = t.fontSize;
    const move = (ev: PointerEvent) => {
      const d = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      const fontSize = Math.round(Math.min(400, Math.max(12, (fs0 * d) / d0)));
      apply((doc) => updateText(doc, t.id, { fontSize }), { coalesce: `size:${t.id}` });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      commit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const hs = 12 / k;
  return (
    <g
      style={{ pointerEvents: "auto", cursor: "grab", opacity: hidden ? 0 : 1 }}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onEdit();
      }}
      role="textbox"
      aria-label={`Text: ${t.text}`}
      className="ed-svg-text"
    >
      <title>{selected ? "Drag to move · double-click to edit" : t.text}</title>
      <rect x={r.x} y={r.y} width={r.width} height={r.height} fill="transparent" />
      <Plate plate={L.plate} />
      {L.lines.map((line, i) => (
        <text key={i} x={line.x} y={line.baseline} fill={hexToRgba(t.color)} style={fontStyle(t.fontId, L.fontPx)} {...strokeProps(t.strokeColor, L.strokeWidth)}>
          {line.text}
        </text>
      ))}
      {selected ? (
        <>
          <rect x={r.x - 6 / k} y={r.y - 6 / k} width={r.width + 12 / k} height={r.height + 12 / k} rx={6 / k} fill="none" stroke="#f3c46a" strokeWidth={1.5 / k} />
          <rect
            x={r.x + r.width + 6 / k - hs / 2}
            y={r.y + r.height + 6 / k - hs / 2}
            width={hs}
            height={hs}
            rx={3 / k}
            fill="#fff"
            stroke="#e5a94a"
            strokeWidth={2 / k}
            style={{ cursor: "nwse-resize" }}
            onPointerDown={onResizeDown}
            aria-label="Resize text"
          />
        </>
      ) : (
        <rect className="ed-svg-hover" x={r.x - 6 / k} y={r.y - 6 / k} width={r.width + 12 / k} height={r.height + 12 / k} rx={6 / k} fill="none" stroke="rgba(255,255,255,.55)" strokeDasharray={`${4 / k} ${3 / k}`} strokeWidth={1 / k} />
      )}
    </g>
  );
}

/** Double-click editing: a textarea laid over the element in the element's own face and size. */
function InlineTextEditor({ id, k, onDone }: { id: string; k: number; onDone: () => void }) {
  const { doc, apply, fontsVersion } = useEditor();
  const t = doc.texts.find((x) => x.id === id);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(t?.text ?? "");
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const L = useMemo(() => (t ? layoutTimelineText(t, doc.canvas, browserMeasureText) : null), [t, doc.canvas, fontsVersion]);
  if (!t || !L) return null;
  const finish = () => {
    const text = value.replace(/\n+$/, "").slice(0, 500);
    if (text.trim() && text !== t.text) apply((d) => updateText(d, id, { text }));
    onDone();
  };
  const r = L.rect;
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={finish}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          (e.currentTarget as HTMLTextAreaElement).blur();
        }
      }}
      aria-label="Edit text"
      className="absolute z-[8] resize-none overflow-hidden rounded-md outline-none ring-2 ring-[var(--color-gold-400)]"
      style={{
        left: r.x * k - 6,
        top: r.y * k - 6,
        width: Math.max(r.width * k + 12, 120),
        height: r.height * k + 12,
        padding: 6,
        ...fontStyle(t.fontId, L.fontPx * k),
        lineHeight: `${L.lineHeight * k}px`,
        whiteSpace: "pre-wrap",
        textAlign: t.align,
        textTransform: t.uppercase ? "uppercase" : "none",
        color: t.color.slice(0, 7),
        background: t.backgroundColor ? hexToRgba(t.backgroundColor) : "rgba(0,0,0,.55)",
      }}
    />
  );
}

// ---------------------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------------------

const PLACEHOLDER_CHUNK = {
  words: [
    { word: "Captions", start: 0, end: 1, key: "p:0" },
    { word: "show", start: 1, end: 2, key: "p:1" },
    { word: "here", start: 2, end: 3, key: "p:2" },
  ],
} as unknown as TimelineCaptionChunk;

/** BOLD_HIGHLIGHT active word (renderer rule): word i is active from (i==0 ? chunk.start :
 * word.start) to (i==last ? chunk.end : nextWord.start). */
function activeWordIndex(chunk: TimelineCaptionChunk, t: number): number {
  const ws = chunk.words;
  for (let i = 0; i < ws.length; i++) {
    const from = i === 0 ? chunk.start : ws[i]!.start;
    const to = i === ws.length - 1 ? chunk.end : ws[i + 1]!.start;
    if (t >= from && t < to) return i;
  }
  return -1;
}

function CaptionLayer({ k, onDragging }: { k: number; onDragging: (v: boolean) => void }) {
  const { doc, chunks, engine, state, dispatch, apply, commit, setUi, fontsVersion } = useEditor();
  const c = doc.captions;
  const key = usePlayheadValue(engine, (t) => {
    if (!c.enabled) return "";
    const ci = chunks.findIndex((ch) => t >= ch.start && t < ch.end);
    if (ci < 0) return "";
    return c.preset === "BOLD_HIGHLIGHT" ? `${ci}:${activeWordIndex(chunks[ci]!, t)}` : `${ci}`;
  });
  const selected = state.selection?.kind === "captions";
  const [ciStr, wiStr] = key ? key.split(":") : ["-1", "-1"];
  const chunk = chunks[Number(ciStr)];
  const placeholder = !chunk && selected && c.enabled;
  const shown = chunk ?? (placeholder ? PLACEHOLDER_CHUNK : null);
  const L = useMemo(() => (shown && c.enabled ? layoutCaptionChunk(shown, c, doc.canvas, browserMeasureText) : null), [shown, c, doc.canvas, fontsVersion]);
  if (!shown || !L) return null;
  const active = c.preset === "BOLD_HIGHLIGHT" && !placeholder ? Number(wiStr) : -1;
  const H = doc.canvas.height;

  const onPointerDown = (e: RPointerEvent<SVGGElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dispatch({ type: "select", selection: { kind: "captions" } });
    setUi({ tab: "captions" });
    const startY = e.clientY;
    const y0 = c.y;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < 3) return;
      if (!moved) onDragging(true);
      moved = true;
      const y = Math.round(Math.min(0.95, Math.max(0.05, y0 + (ev.clientY - startY) / k / H)) * 1000) / 1000;
      apply((d) => updateCaptions(d, { y }), { coalesce: "captions:y" });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onDragging(false);
      commit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const r = L.rect;
  const font = fontStyle(c.fontId, L.fontPx);
  return (
    <g style={{ pointerEvents: "auto", cursor: "ns-resize", opacity: placeholder ? 0.55 : 1 }} onPointerDown={onPointerDown} aria-label="Captions" className="ed-svg-text">
      <title>Drag up or down to move captions</title>
      <rect x={r.x} y={r.y} width={r.width} height={r.height} fill="transparent" />
      <Plate plate={L.plate} />
      {/* CLEAN: hard drop shadow (renderer: #00000080, offset s px right & down, no blur) */}
      {c.preset === "CLEAN" &&
        L.shadowOffset > 0 &&
        L.lines.map((line, i) => (
          <text key={`s${i}`} x={line.x + L.shadowOffset} y={line.baseline + L.shadowOffset} fill={hexToRgba(LAYOUT.captions.cleanShadow.color)} style={font} {...strokeProps(c.strokeColor ? LAYOUT.captions.cleanShadow.color : null, L.strokeWidth)}>
            {line.text}
          </text>
        ))}
      {L.lines.map((line, i) => (
        <text key={i} x={line.x} y={line.baseline} fill={hexToRgba(c.color)} style={font} {...strokeProps(c.strokeColor, L.strokeWidth)}>
          {line.text}
        </text>
      ))}
      {active >= 0 &&
        L.lines.flatMap((line, li) =>
          line.words
            .filter((w) => w.index === active)
            .map((w, wi) => (
              <text key={`h${li}:${wi}`} x={w.x} y={line.baseline} fill={hexToRgba(c.highlightColor)} style={font}>
                {w.text}
              </text>
            )),
        )}
      {c.preset === "KARAOKE" && !placeholder && chunk && <KaraokeFill chunk={chunk} layout={L} font={font} />}
      {selected && <rect x={r.x - 6 / k} y={r.y - 6 / k} width={r.width + 12 / k} height={r.height + 12 / k} rx={6 / k} fill="none" stroke="#f3c46a" strokeWidth={1.5 / k} />}
    </g>
  );
}

/** KARAOKE: each word wipes left→right to the highlight colour from word.start to the next
 * word's start (last: word.end) — a clip-rect over a highlight copy, updated per frame. */
function KaraokeFill({ chunk, layout, font }: { chunk: TimelineCaptionChunk; layout: TimelineCaptionLayout; font: CSSProperties }) {
  const { engine, doc } = useEditor();
  const rects = useRef<Array<SVGRectElement | null>>([]);
  const pieces = layout.lines.flatMap((line) => line.words.map((w) => ({ ...w, baseline: line.baseline })));
  const idPrefix = useMemo(() => `kf${Math.random().toString(36).slice(2, 8)}`, []);
  useEffect(() => {
    const ws = chunk.words;
    const update = () => {
      const t = engine.time;
      pieces.forEach((p, i) => {
        const w = ws[p.index];
        const el = rects.current[i];
        if (!w || !el) return;
        const end = p.index < ws.length - 1 ? ws[p.index + 1]!.start : w.end;
        const f = Math.min(1, Math.max(0, (t - w.start) / Math.max(1e-3, end - w.start)));
        el.setAttribute("width", String(p.width * f));
      });
    };
    update();
    return engine.subscribe(update);
  });
  return (
    <>
      <defs>
        {pieces.map((p, i) => (
          <clipPath key={i} id={`${idPrefix}-${i}`}>
            <rect
              ref={(el) => {
                rects.current[i] = el;
              }}
              x={p.x}
              y={p.baseline - layout.fontPx * 1.2}
              width={0}
              height={layout.fontPx * 1.6}
            />
          </clipPath>
        ))}
      </defs>
      {pieces.map((p, i) => (
        <text key={i} x={p.x} y={p.baseline} fill={hexToRgba(doc.captions.highlightColor)} style={font} clipPath={`url(#${idPrefix}-${i})`}>
          {p.text}
        </text>
      ))}
    </>
  );
}
