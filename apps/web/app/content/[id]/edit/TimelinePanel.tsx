"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { clipDuration, clipStartTimes, timelineDuration, type TimelineClip, type TimelineText, type TimelineZoom } from "@chris/media/timeline";
import {
  moveClip,
  trimClip,
  insertClip,
  addText,
  addZoom,
  updateText,
  updateZoom,
  moveSpan,
  trimSpan,
  newId,
} from "../../../../lib/editor/timeline-ops";
import { formatTime } from "../../../../lib/editor/preview-math";
import type { EditorAsset, EditorDoc } from "../../../../lib/editor/types";
import { useEditor } from "./context";
import { useFilmstrip, frameAt } from "./filmstrip";
import { useIsPlaying } from "./playback";
import { TAKE_DRAG_MIME } from "./MediaBin";
import { Icon } from "./icons";

const PAD = 14;
const SNAP_PX = 8;
const RULER_H = 26;
const VIDEO_H = 58;
const LANE_H = 24;
const CAPTION_H = 26;
const ZOOM_H = 28;
const MIN_PPS = 8;
const MAX_PPS = 480;

const TEXT_COLOR = "linear-gradient(180deg, #7d63f0, #6448d8)";
const ZOOM_COLOR = "linear-gradient(180deg, #d99a3c, #b97d22)";

/** Greedy lane assignment so overlapping texts stack instead of hiding each other. */
export function assignLanes(items: TimelineText[]): Map<string, number> {
  const lanes: number[] = [];
  const out = new Map<string, number>();
  for (const t of [...items].sort((a, b) => a.start - b.start)) {
    let lane = lanes.findIndex((end) => end <= t.start + 1e-6);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(0);
    }
    lanes[lane] = t.end;
    out.set(t.id, lane);
  }
  return out;
}

export function TimelinePanel({ onSplit, onDelete, onDuplicate }: { onSplit: () => void; onDelete: () => void; onDuplicate: () => void }) {
  const { doc, engine, ui, setUi, apply, state, dispatch, chunks, focus, assetMap } = useEditor();
  const pps = ui.pxPerSec;
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(800);
  const [snap, setSnap] = useState(true);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const D = timelineDuration(doc);
  const starts = useMemo(() => clipStartTimes(doc), [doc]);
  const lanes = useMemo(() => assignLanes(doc.texts), [doc.texts]);
  const laneCount = Math.max(1, ...[...lanes.values()].map((l) => l + 1));
  const textTrackH = laneCount * LANE_H + 8;
  const contentW = Math.max(viewW, D * pps + PAD * 2 + 240);
  const playing = useIsPlaying(engine);
  const fitted = useRef(false);

  const xOf = useCallback((t: number) => PAD + t * pps, [pps]);
  const tOf = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      return Math.max(0, (clientX - r.left + el.scrollLeft - PAD) / pps);
    },
    [pps],
  );

  // viewport width + fit-on-open
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewW(el.clientWidth);
      if (!fitted.current && el.clientWidth > 0 && D > 0) {
        fitted.current = true;
        setUi({ pxPerSec: Math.min(MAX_PPS, Math.max(MIN_PPS, (el.clientWidth - PAD * 2 - 40) / D)) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [D, setUi]);

  // playhead: direct DOM writes, auto-follow while playing
  useEffect(() => {
    const update = () => {
      const x = xOf(engine.time);
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${x}px)`;
      const el = scrollRef.current;
      if (el && engine.playing) {
        if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 60);
      }
    };
    update();
    return engine.subscribe(update);
  }, [engine, xOf]);

  // cmd/ctrl+wheel zooms around the pointer; plain vertical wheel scrolls horizontally
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const t = (mx + el.scrollLeft - PAD) / pps;
        const next = Math.min(MAX_PPS, Math.max(MIN_PPS, pps * Math.exp(-e.deltaY * 0.01)));
        setUi({ pxPerSec: next });
        requestAnimationFrame(() => {
          el.scrollLeft = Math.max(0, PAD + t * next - mx);
        });
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) {
        const before = el.scrollLeft;
        el.scrollLeft += e.deltaY;
        if (el.scrollLeft !== before) e.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pps, setUi]);

  /** Snap targets (output seconds): 0, end, playhead, clip boundaries, other item edges. */
  const snapTargets = useCallback(
    (excludeId?: string) => {
      const ts = [0, D, engine.time, ...starts, ...doc.texts.flatMap((t) => (t.id === excludeId ? [] : [t.start, t.end])), ...doc.zooms.flatMap((z) => (z.id === excludeId ? [] : [z.start, z.end]))];
      return ts;
    },
    [D, engine, starts, doc.texts, doc.zooms],
  );
  const snapTime = useCallback(
    (t: number, targets: number[]): number | null => {
      if (!snap) return null;
      let best: number | null = null;
      let bestD = SNAP_PX / pps;
      for (const s of targets) {
        const d = Math.abs(s - t);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      return best;
    },
    [snap, pps],
  );

  // ruler/background scrubbing
  const onScrubDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const wasPlaying = engine.playing;
    engine.pause();
    engine.seek(Math.min(D, tOf(e.clientX)));
    const move = (ev: PointerEvent) => engine.seek(Math.min(D, tOf(ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (wasPlaying) engine.play();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onBackgroundDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    dispatch({ type: "select", selection: null });
    onScrubDown(e);
  };

  // ruler ticks
  const { ticks, majorStep } = useMemo(() => {
    const minLabelPx = 70;
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60];
    const major = steps.find((s) => s * pps >= minLabelPx) ?? 60;
    const minor = major / (major >= 5 ? 5 : 2);
    const out: Array<{ t: number; major: boolean }> = [];
    const end = (contentW - PAD) / pps;
    for (let t = 0; t <= end + 1e-6; t += minor) {
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      out.push({ t, major: isMajor });
    }
    return { ticks: out, majorStep: major };
  }, [pps, contentW]);

  const sel = state.selection;
  const canDelete = sel?.kind === "clip" ? doc.clips.length > 1 : sel?.kind === "text" || sel?.kind === "zoom";
  const sliderVal = Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS);

  // ---- drops from the media bin
  const dropIndexAt = (clientX: number) => {
    const t = tOf(clientX);
    for (let i = 0; i < doc.clips.length; i++) {
      if (t < starts[i]! + clipDuration(doc.clips[i]!) / 2) return i;
    }
    return doc.clips.length;
  };

  return (
    <section className="ed-timeline" aria-label="Timeline">
      <div className="ed-tl-toolbar">
        <div className="flex items-center gap-0.5">
          <button type="button" className="ed-toolbtn" onClick={onSplit} title="Split the clip at the playhead (S)">
            <Icon name="split" size={14} /> Split
          </button>
          <button type="button" className="ed-toolbtn" onClick={onDelete} disabled={!canDelete} title="Delete the selection — the gap closes (⌫)">
            <Icon name="trash" size={14} /> Delete
          </button>
          <button type="button" className="ed-toolbtn" onClick={onDuplicate} disabled={sel?.kind !== "clip" && sel?.kind !== "text"} title="Duplicate (⌘D)">
            <Icon name="duplicate" size={14} /> Duplicate
          </button>
          <span className="mx-1.5 h-4 w-px bg-[var(--color-border)]" />
          <button
            type="button"
            className="ed-toolbtn"
            onClick={() => {
              const id = newId("text");
              const at = engine.time;
              apply((d) => addText(d, at, {}, id).doc, { select: { kind: "text", id } });
            }}
            title="Add text at the playhead"
          >
            <Icon name="text" size={14} /> Text
          </button>
          <button
            type="button"
            className="ed-toolbtn"
            onClick={() => {
              const id = newId("zoom");
              const at = engine.time;
              apply((d) => addZoom(d, at, id).doc, { select: { kind: "zoom", id } });
            }}
            title="Add a zoom (punch-in) at the playhead"
          >
            <Icon name="zoom" size={14} /> Zoom
          </button>
          <button
            type="button"
            className="ed-toolbtn"
            onClick={() => focus({ kind: "captions" })}
            aria-pressed={sel?.kind === "captions"}
            title="Caption style and word fixes"
          >
            <Icon name="captions" size={14} /> Captions
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">{playing ? "Playing" : ""}</span>
          <button type="button" className="ed-iconbtn !h-7 !w-7" aria-pressed={snap} onClick={() => setSnap((s) => !s)} title={snap ? "Snapping on" : "Snapping off"} aria-label="Toggle snapping">
            <Icon name="magnet" size={14} />
          </button>
          <Icon name="zoom" size={13} className="text-[var(--color-text-faint)]" />
          <input
            type="range"
            className="ed-range !w-[120px]"
            min={0}
            max={1}
            step={0.001}
            value={sliderVal}
            style={{ ["--fill" as string]: `${sliderVal * 100}%` }}
            onChange={(e) => setUi({ pxPerSec: MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, Number(e.target.value)) })}
            aria-label="Timeline zoom"
          />
          <button
            type="button"
            className="ed-toolbtn"
            onClick={() => {
              const el = scrollRef.current;
              if (!el || D <= 0) return;
              setUi({ pxPerSec: Math.min(MAX_PPS, Math.max(MIN_PPS, (el.clientWidth - PAD * 2 - 40) / D)) });
              el.scrollLeft = 0;
            }}
            title="Fit the whole video"
          >
            <Icon name="fit" size={14} /> Fit
          </button>
        </div>
      </div>

      <div className="ed-tl-body ed-scroll">
        <div className="ed-tl-heads">
          <div style={{ height: RULER_H }} className="border-b border-[var(--ed-line)]" />
          <div className="ed-tl-head" style={{ height: VIDEO_H }}>
            <Icon name="film" size={13} /> Video
          </div>
          <div className="ed-tl-head" style={{ height: textTrackH }}>
            <Icon name="text" size={13} /> Text
          </div>
          <div className="ed-tl-head" style={{ height: CAPTION_H }}>
            <Icon name="captions" size={13} /> Captions
          </div>
          <div className="ed-tl-head" style={{ height: ZOOM_H }}>
            <Icon name="zoom" size={13} /> Zoom
          </div>
        </div>

        <div className="ed-tl-scroll" ref={scrollRef}>
          <div style={{ width: contentW, position: "relative" }}>
            {/* ruler */}
            <div className="ed-ruler" onPointerDown={onScrubDown}>
              {ticks.map(({ t, major }) => (
                <div key={t.toFixed(3)}>
                  <div className="ed-tick" style={{ left: xOf(t), height: major ? 10 : 5 }} />
                  {major && (
                    <span className="ed-tick-label" style={{ left: xOf(t) }}>
                      {majorStep < 1 ? `${t.toFixed(1)}s` : formatTime(t)}
                    </span>
                  )}
                </div>
              ))}
              <div className="absolute bottom-0 top-0 bg-white/[0.03]" style={{ left: xOf(D), right: 0 }} />
            </div>

            {/* video */}
            <div
              className="ed-track"
              style={{ height: VIDEO_H }}
              onPointerDown={onBackgroundDown}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(TAKE_DRAG_MIME)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setDropIndex(dropIndexAt(e.clientX));
              }}
              onDragLeave={() => setDropIndex(null)}
              onDrop={(e) => {
                const assetId = e.dataTransfer.getData(TAKE_DRAG_MIME);
                const index = dropIndexAt(e.clientX);
                setDropIndex(null);
                if (!assetId) return;
                e.preventDefault();
                const asset = assetMap.get(assetId);
                if (!asset) return;
                const id = newId("clip");
                apply((d) => insertClip(d, index, { mediaAssetId: assetId, sourceStart: 0, sourceEnd: asset.duration || 5 }, id).doc, {
                  select: { kind: "clip", id },
                });
              }}
            >
              {doc.clips.map((c, i) => (
                <ClipView
                  key={c.id}
                  clip={c}
                  index={i}
                  start={starts[i]!}
                  pps={pps}
                  selected={sel?.kind === "clip" && sel.id === c.id}
                  tOf={tOf}
                  snapTime={snapTime}
                  onSnapLine={setSnapLine}
                />
              ))}
              {dropIndex !== null && (
                <div className="ed-drop-marker" style={{ left: xOf(dropIndex < doc.clips.length ? starts[dropIndex]! : D) }} />
              )}
            </div>

            {/* text */}
            <div className="ed-track" style={{ height: textTrackH }} onPointerDown={onBackgroundDown}>
              {doc.texts.map((t) => (
                <SpanView
                  key={t.id}
                  kind="text"
                  item={t}
                  top={4 + (lanes.get(t.id) ?? 0) * LANE_H}
                  pps={pps}
                  duration={D}
                  selected={sel?.kind === "text" && sel.id === t.id}
                  label={t.text}
                  background={TEXT_COLOR}
                  snapTargets={snapTargets}
                  snapTime={snapTime}
                  onSnapLine={setSnapLine}
                />
              ))}
            </div>

            {/* captions */}
            <div className="ed-track" style={{ height: CAPTION_H }} onPointerDown={onBackgroundDown}>
              {!doc.captions.enabled && (
                <button type="button" className="absolute left-3 top-1 text-[11px] text-[var(--color-text-faint)] hover:text-[var(--color-text)]" onClick={() => focus({ kind: "captions" })} style={{ left: PAD }}>
                  Captions are off — turn on
                </button>
              )}
              {doc.captions.enabled &&
                chunks.map((ch, i) => (
                  <div
                    key={`${i}:${ch.start}`}
                    className="ed-chunk"
                    style={{ left: xOf(ch.start), width: Math.max(2, (ch.end - ch.start) * pps - 2), outline: sel?.kind === "captions" ? "1px solid rgba(110,231,176,.5)" : undefined }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      focus({ kind: "captions" });
                      engine.seek(ch.start + 0.01);
                    }}
                    title={ch.text}
                  >
                    {ch.text}
                  </div>
                ))}
            </div>

            {/* zoom */}
            <div className="ed-track" style={{ height: ZOOM_H }} onPointerDown={onBackgroundDown}>
              {doc.zooms.map((z) => (
                <SpanView
                  key={z.id}
                  kind="zoom"
                  item={z}
                  top={4}
                  pps={pps}
                  duration={D}
                  selected={sel?.kind === "zoom" && sel.id === z.id}
                  label={`${z.zoom.toFixed(2)}× ${z.mode === "EASE" ? "ease" : "cut"}`}
                  background={ZOOM_COLOR}
                  snapTargets={snapTargets}
                  snapTime={snapTime}
                  onSnapLine={setSnapLine}
                />
              ))}
            </div>

            {doc.coverFrameSeconds != null && (
              <div
                className="pointer-events-none absolute z-[4] -translate-x-1/2 rounded-sm bg-[var(--color-emerald-500)] px-1 text-[9px] font-bold uppercase text-black"
                style={{ left: xOf(doc.coverFrameSeconds), top: RULER_H - 12 }}
                title="Cover frame"
              >
                Cover
              </div>
            )}
            {snapLine !== null && <div className="ed-snapline" style={{ left: xOf(snapLine) }} />}
            <div className="ed-playhead" ref={playheadRef}>
              <div className="ed-playhead-knob" onPointerDown={onScrubDown} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------
// Clip
// ---------------------------------------------------------------------------------------

const ClipView = memo(function ClipView({
  clip,
  index,
  start,
  pps,
  selected,
  tOf,
  snapTime,
  onSnapLine,
}: {
  clip: TimelineClip;
  index: number;
  start: number;
  pps: number;
  selected: boolean;
  tOf: (clientX: number) => number;
  snapTime: (t: number, targets: number[]) => number | null;
  onSnapLine: (t: number | null) => void;
}) {
  const { assetMap, apply, commit, dispatch, engine, doc } = useEditor();
  const asset = assetMap.get(clip.mediaAssetId);
  const dur = clipDuration(clip);
  const width = Math.max(4, dur * pps - 2);
  const [dragDx, setDragDx] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  const onBodyDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dispatch({ type: "select", selection: { kind: "clip", id: clip.id } });
    const x0 = e.clientX;
    let dragging = false;
    let target = index;
    const others = doc.clips.filter((c) => c.id !== clip.id);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!dragging && Math.abs(dx) < 5) return;
      dragging = true;
      setDragDx(dx);
      const tp = tOf(ev.clientX);
      let acc = 0;
      target = others.length;
      for (let i = 0; i < others.length; i++) {
        const d = clipDuration(others[i]!);
        if (tp < acc + d / 2) {
          target = i;
          break;
        }
        acc += d;
      }
      let at = 0;
      for (let i = 0; i < target; i++) at += clipDuration(others[i]!);
      setDropAt(at);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragDx(null);
      setDropAt(null);
      if (dragging && target !== index) apply((d) => moveClip(d, d.clips.findIndex((c) => c.id === clip.id), target));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onTrimDown = (edge: "start" | "end") => (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    engine.pause();
    dispatch({ type: "select", selection: { kind: "clip", id: clip.id } });
    const x0 = e.clientX;
    const orig = { ...clip };
    const assetDur = asset?.duration || undefined;
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / pps;
      let value = edge === "start" ? orig.sourceStart + dt : orig.sourceEnd + dt;
      if (edge === "end") {
        const outEnd = start + (value - orig.sourceStart);
        const snapped = snapTime(outEnd, [engine.time]);
        if (snapped !== null) value = orig.sourceStart + (snapped - start);
        onSnapLine(snapped);
      }
      const lo = edge === "start" ? 0 : orig.sourceStart + 0.1;
      const hi = edge === "start" ? orig.sourceEnd - 0.1 : (assetDur ?? Infinity);
      value = Math.min(hi, Math.max(lo, value));
      apply((d) => trimClip(d, clip.id, edge, value, assetDur), { coalesce: `trim:${clip.id}:${edge}` });
      engine.previewSourceFrame(index, edge === "start" ? value : Math.max(orig.sourceStart, value - 0.04));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onSnapLine(null);
      engine.previewSourceFrame(index, null);
      commit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <>
      <div
        className={`ed-clip ${selected ? "ed-clip-sel" : ""}`}
        style={{
          left: PAD + start * pps + 1,
          width,
          ["--clip-color" as string]: asset?.color ?? "#555",
          transform: dragDx !== null ? `translateX(${dragDx}px) translateY(-3px)` : undefined,
          zIndex: dragDx !== null ? 4 : undefined,
          opacity: dragDx !== null ? 0.85 : 1,
          boxShadow: dragDx !== null ? "0 12px 30px -10px rgba(0,0,0,.8)" : undefined,
          cursor: dragDx !== null ? "grabbing" : undefined,
        }}
        onPointerDown={onBodyDown}
        role="button"
        aria-label={`Clip ${index + 1}: ${asset?.name ?? "take"}, ${dur.toFixed(1)} seconds`}
        aria-pressed={selected}
      >
        <Frames asset={asset} clip={clip} width={width} pps={pps} />
        <span className="ed-clip-label">{asset?.name ?? "Missing take"}</span>
        {width > 56 && <span className="ed-clip-dur">{dur.toFixed(1)}s</span>}
        <div className="ed-trim ed-trim-l" onPointerDown={onTrimDown("start")} aria-label="Trim start" />
        <div className="ed-trim ed-trim-r" onPointerDown={onTrimDown("end")} aria-label="Trim end" />
      </div>
      {dropAt !== null && <div className="ed-drop-marker" style={{ left: PAD + dropAt * pps }} />}
    </>
  );
});

export function Frames({ asset, clip, width, pps, height = VIDEO_H }: { asset: EditorAsset | undefined; clip: TimelineClip; width: number; pps: number; height?: number }) {
  const strip = useFilmstrip(asset);
  if (!strip) return null;
  const frameW = Math.max(24, (height - 10) * strip.aspect);
  const n = Math.min(80, Math.ceil(width / frameW));
  return (
    <div className="ed-clip-frames">
      {Array.from({ length: n }, (_, i) => {
        const t = clip.sourceStart + ((i + 0.5) * frameW) / pps;
        const src = frameAt(strip, Math.min(clip.sourceEnd, t));
        return <div key={i} style={{ width: frameW, backgroundImage: src ? `url(${src})` : undefined }} />;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Text / zoom spans
// ---------------------------------------------------------------------------------------

function SpanView({
  kind,
  item,
  top,
  pps,
  duration,
  selected,
  label,
  background,
  snapTargets,
  snapTime,
  onSnapLine,
}: {
  kind: "text" | "zoom";
  item: TimelineText | TimelineZoom;
  top: number;
  pps: number;
  duration: number;
  selected: boolean;
  label: string;
  background: string;
  snapTargets: (excludeId?: string) => number[];
  snapTime: (t: number, targets: number[]) => number | null;
  onSnapLine: (t: number | null) => void;
}) {
  const { apply, commit, focus, engine } = useEditor();
  const update = (d: EditorDoc, patch: { start: number; end: number }) =>
    kind === "text" ? updateText(d, item.id, patch) : updateZoom(d, item.id, patch);

  const drag = (mode: "move" | "start" | "end") => (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    engine.pause();
    focus({ kind, id: item.id });
    const x0 = e.clientX;
    const orig = { start: item.start, end: item.end };
    const targets = snapTargets(item.id);
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / pps;
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      let next: { start: number; end: number };
      if (mode === "move") {
        let s = orig.start + dt;
        const len = orig.end - orig.start;
        const sStart = snapTime(s, targets);
        const sEnd = snapTime(s + len, targets);
        if (sStart !== null) s = sStart;
        else if (sEnd !== null) s = sEnd - len;
        onSnapLine(sStart ?? sEnd);
        next = moveSpan(orig, s, duration);
      } else {
        let v = (mode === "start" ? orig.start : orig.end) + dt;
        const sv = snapTime(v, targets);
        if (sv !== null) v = sv;
        onSnapLine(sv);
        next = trimSpan(orig, mode, v, duration);
        engine.seek(mode === "start" ? next.start : Math.max(next.start, next.end - 0.02));
      }
      apply((d) => update(d, next), { coalesce: `${kind}:${mode}:${item.id}` });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onSnapLine(null);
      commit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className={`ed-item ${selected ? "ed-item-sel" : ""}`}
      style={{ left: PAD + item.start * pps, width: Math.max(8, (item.end - item.start) * pps), top, background }}
      onPointerDown={drag("move")}
      role="button"
      aria-label={`${kind === "text" ? "Text" : "Zoom"}: ${label}`}
      aria-pressed={selected}
      title={label}
    >
      <span>{label}</span>
      <div className="ed-trim ed-trim-l" style={{ width: 8 }} onPointerDown={drag("start")} />
      <div className="ed-trim ed-trim-r" style={{ width: 8 }} onPointerDown={drag("end")} />
    </div>
  );
}
