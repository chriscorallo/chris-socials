"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { clipDuration, clipStartTimes, timelineDuration, type TimelineClip, type TimelineText, type TimelineZoom } from "@chris/media/timeline";
import { moveClip, trimClip, updateText, updateZoom, moveSpan, trimSpan } from "../../../../lib/editor/timeline-ops";
import { formatTime } from "../../../../lib/editor/preview-math";
import { fitPps, pinchPps, reorderTarget, scrollForTime, snapTo, timeAtViewportX, timeForScroll, distance } from "../../../../lib/editor/touch-math";
import type { EditorDoc } from "../../../../lib/editor/types";
import { useEditor } from "./context";
import { assignLanes, Frames } from "./TimelinePanel";
import { haptic } from "./layout-hooks";
import { Icon } from "./icons";

/**
 * Touch timeline (CapCut-style): the playhead is FIXED in the centre and the tracks scroll
 * under it. Swiping scrubs (native momentum scrolling), pinching zooms, tapping selects.
 * A selected clip grows big trim handles (with snap ticks); long-press a clip to drag it to a
 * new position. Content is padded by half the viewport each side, so scrollLeft = time × pps.
 */

const MIN_PPS = 8;
const MAX_PPS = 480;
const RULER_H = 20;
const VIDEO_H = 54;
const LANE_H = 26;
const CAPTION_H = 22;
const ZOOM_H = 24;
const SNAP_PX = 12;
const LONG_PRESS_MS = 380;

const TEXT_COLOR = "linear-gradient(180deg, #7d63f0, #6448d8)";
const ZOOM_COLOR = "linear-gradient(180deg, #d99a3c, #b97d22)";

export function MobileTimeline() {
  const { doc, engine, ui, setUi, state, dispatch, chunks, focus } = useEditor();
  const pps = ui.pxPerSec;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);
  const D = timelineDuration(doc);
  const starts = useMemo(() => clipStartTimes(doc), [doc]);
  const lanes = useMemo(() => assignLanes(doc.texts), [doc.texts]);
  const laneCount = Math.max(1, ...[...lanes.values()].map((l) => l + 1));
  const half = viewW / 2;
  const contentW = Math.max(viewW, D * pps + viewW);
  const xOf = useCallback((t: number) => half + t * pps, [half, pps]);
  const expected = useRef(-1);
  const seekRaf = useRef(0);
  const fitted = useRef(false);
  const [snapLine, setSnapLine] = useState<number | null>(null);

  // viewport width + fit-on-open
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setViewW(el.clientWidth);
      if (!fitted.current && el.clientWidth > 0 && D > 0) {
        fitted.current = true;
        // fit ~85% of the video in view (the rest peeks in from the right, inviting a swipe)
        setUi({ pxPerSec: fitPps(D, el.clientWidth * 1.15, MIN_PPS, MAX_PPS, 0) });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [D, setUi]);

  /** Programmatic scroll to the engine time (ignored by onScroll). */
  const syncScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const x = scrollForTime(engine.time, pps);
    if (Math.abs(el.scrollLeft - x) < 0.5) return;
    expected.current = x;
    el.scrollLeft = x;
  }, [engine, pps]);

  useLayoutEffect(() => {
    syncScroll();
  }, [syncScroll, contentW]);

  useEffect(() => engine.subscribe(syncScroll), [engine, syncScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (expected.current >= 0 && Math.abs(el.scrollLeft - expected.current) < 1.5) return;
    expected.current = -1;
    if (engine.playing) engine.pause();
    cancelAnimationFrame(seekRaf.current);
    seekRaf.current = requestAnimationFrame(() => {
      const t = timeForScroll(el.scrollLeft, pps, D);
      // seek without re-snapping the scroll position under the user's finger
      expected.current = el.scrollLeft;
      engine.seek(t);
    });
  };

  // Pinch to zoom (two fingers), keeping the playhead time under the centre line. Listeners
  // are attached once; the current zoom is read from a ref so a re-render mid-pinch doesn't
  // reset the gesture.
  const ppsRef = useRef(pps);
  useEffect(() => {
    ppsRef.current = pps;
  }, [pps]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let d0 = 0;
    let pps0 = ppsRef.current;
    const dist = (e: TouchEvent) => distance({ x: e.touches[0]!.clientX, y: e.touches[0]!.clientY }, { x: e.touches[1]!.clientX, y: e.touches[1]!.clientY });
    const start = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        d0 = dist(e);
        pps0 = ppsRef.current;
        if (engine.playing) engine.pause();
      }
    };
    const move = (e: TouchEvent) => {
      if (e.touches.length !== 2 || d0 <= 0) return;
      if (e.cancelable) e.preventDefault();
      setUi({ pxPerSec: pinchPps(pps0, d0, dist(e), MIN_PPS, MAX_PPS) });
    };
    const end = (e: TouchEvent) => {
      if (e.touches.length < 2) d0 = 0;
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", end, { passive: true });
    // trackpads / mice on a narrow desktop window: ctrl/⌘+wheel zooms, vertical wheel scrubs
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setUi({ pxPerSec: Math.min(MAX_PPS, Math.max(MIN_PPS, ppsRef.current * Math.exp(-e.deltaY * 0.01))) });
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      el.removeEventListener("wheel", onWheel);
    };
  }, [engine, setUi]);

  /** Output time under a clientX (for drags). */
  const tOf = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      return timeAtViewportX(clientX - r.left, el.clientWidth, el.scrollLeft, pps);
    },
    [pps],
  );

  // ruler ticks — only those near the viewport are worth rendering on a phone
  const ticks = useMemo(() => {
    const minLabelPx = 56;
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60];
    const major = steps.find((s) => s * pps >= minLabelPx) ?? 60;
    const minor = major / 2;
    const out: Array<{ t: number; major: boolean }> = [];
    for (let t = 0; t <= D + 1e-6; t += minor) out.push({ t, major: Math.abs(t / major - Math.round(t / major)) < 1e-6 });
    return { out, major };
  }, [pps, D]);

  const sel = state.selection;
  const deselect = () => dispatch({ type: "select", selection: null });

  return (
    <div className="ed-mtl" aria-label="Timeline" style={{ ["--ed-mtl-content" as string]: `${RULER_H + VIDEO_H + 8 + laneCount * LANE_H + 4 + CAPTION_H + 4 + ZOOM_H + 4 + 6}px` }}>
      <div className="ed-mtl-scroll" ref={scrollRef} onScroll={onScroll} onPointerDown={() => engine.playing && engine.pause()}>
        <div className="ed-mtl-content" style={{ width: contentW }} onClick={(e) => e.target === e.currentTarget && deselect()}>
          {/* ruler */}
          <div className="ed-mtl-ruler" style={{ height: RULER_H }} onClick={deselect}>
            {ticks.out.map(({ t, major }) => (
              <div key={t.toFixed(3)} className={major ? "ed-mtl-tick ed-mtl-tick-major" : "ed-mtl-tick"} style={{ left: xOf(t) }}>
                {major && <span>{ticks.major < 1 ? `${t.toFixed(1)}s` : formatTime(t)}</span>}
              </div>
            ))}
            {doc.coverFrameSeconds != null && (
              <div className="ed-mtl-cover" style={{ left: xOf(doc.coverFrameSeconds) }}>
                Cover
              </div>
            )}
          </div>

          {/* video */}
          <div className="ed-mtl-track" style={{ height: VIDEO_H + 8 }} onClick={(e) => e.target === e.currentTarget && deselect()}>
            {doc.clips.map((c, i) => (
              <MClip
                key={c.id}
                clip={c}
                index={i}
                start={starts[i]!}
                pps={pps}
                half={half}
                selected={sel?.kind === "clip" && sel.id === c.id}
                tOf={tOf}
                onSnapLine={setSnapLine}
                scrollEl={scrollRef}
              />
            ))}
            <button type="button" className="ed-mtl-add" style={{ left: xOf(D) + 10 }} onClick={() => setUi({ sheet: "media" })} aria-label="Add a clip">
              <Icon name="plus" size={20} />
            </button>
          </div>

          {/* text lanes */}
          <div className="ed-mtl-track" style={{ height: laneCount * LANE_H + 4 }} onClick={(e) => e.target === e.currentTarget && deselect()}>
            {doc.texts.length === 0 && (
              <span className="ed-mtl-empty" style={{ left: half + 4 }}>
                <Icon name="text" size={12} /> No text
              </span>
            )}
            {doc.texts.map((t) => (
              <MSpan
                key={t.id}
                kind="text"
                item={t}
                top={2 + (lanes.get(t.id) ?? 0) * LANE_H}
                pps={pps}
                half={half}
                duration={D}
                selected={sel?.kind === "text" && sel.id === t.id}
                label={t.text}
                background={TEXT_COLOR}
                onSnapLine={setSnapLine}
              />
            ))}
          </div>

          {/* captions */}
          <div className="ed-mtl-track" style={{ height: CAPTION_H + 4 }}>
            {!doc.captions.enabled ? (
              <button type="button" className="ed-mtl-empty ed-mtl-empty-btn" style={{ left: half + 4 }} onClick={() => setUi({ sheet: "captions" })}>
                <Icon name="captions" size={12} /> Captions off — tap to turn on
              </button>
            ) : (
              chunks.map((ch, i) => (
                <button
                  type="button"
                  key={`${i}:${ch.start}`}
                  className="ed-mtl-chunk"
                  style={{ left: xOf(ch.start), width: Math.max(2, (ch.end - ch.start) * pps - 2), outline: sel?.kind === "captions" ? "1px solid rgba(110,231,176,.6)" : undefined }}
                  onClick={() => {
                    focus({ kind: "captions" });
                    setUi({ sheet: "captions" });
                  }}
                >
                  {ch.text}
                </button>
              ))
            )}
          </div>

          {/* zooms */}
          <div className="ed-mtl-track" style={{ height: ZOOM_H + 4 }} onClick={(e) => e.target === e.currentTarget && deselect()}>
            {doc.zooms.map((z) => (
              <MSpan
                key={z.id}
                kind="zoom"
                item={z}
                top={2}
                pps={pps}
                half={half}
                duration={D}
                selected={sel?.kind === "zoom" && sel.id === z.id}
                label={`${z.zoom.toFixed(2)}× zoom`}
                background={ZOOM_COLOR}
                onSnapLine={setSnapLine}
              />
            ))}
          </div>
          {snapLine !== null && <div className="ed-mtl-snapline" style={{ left: xOf(snapLine) }} />}
        </div>
      </div>
      <div className="ed-mtl-playhead" aria-hidden />
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Clip: tap = select, long-press = reorder, handles = trim
// ---------------------------------------------------------------------------------------

/** While set, a document-level non-passive touchmove listener stops the page/timeline scrolling. */
function lockTouchScroll(): () => void {
  const block = (e: TouchEvent) => {
    if (e.cancelable) e.preventDefault();
  };
  document.addEventListener("touchmove", block, { passive: false });
  return () => document.removeEventListener("touchmove", block);
}

const MClip = memo(function MClip({
  clip,
  index,
  start,
  pps,
  half,
  selected,
  tOf,
  onSnapLine,
  scrollEl,
}: {
  clip: TimelineClip;
  index: number;
  start: number;
  pps: number;
  half: number;
  selected: boolean;
  tOf: (clientX: number) => number;
  onSnapLine: (t: number | null) => void;
  scrollEl: React.RefObject<HTMLDivElement | null>;
}) {
  const { assetMap, apply, commit, dispatch, engine, doc } = useEditor();
  const asset = assetMap.get(clip.mediaAssetId);
  const dur = clipDuration(clip);
  const width = Math.max(6, dur * pps - 2);
  const [lift, setLift] = useState<{ dx: number; at: number } | null>(null);
  const [trimShift, setTrimShift] = useState(0);
  // a long-press ends with a click event — don't let it toggle the selection
  const justLifted = useRef(false);
  const press = useRef<{ timer: number; x0: number; y0: number; id: number; active: boolean; unlock?: () => void; target: number; raf: number; lastX: number } | null>(null);

  const endPress = () => {
    const p = press.current;
    if (!p) return;
    clearTimeout(p.timer);
    cancelAnimationFrame(p.raf);
    p.unlock?.();
    press.current = null;
  };

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    justLifted.current = false;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const id = e.pointerId;
    const el = e.currentTarget;
    const timer = window.setTimeout(() => {
      const p = press.current;
      if (!p) return;
      p.active = true;
      p.unlock = lockTouchScroll();
      try {
        el.setPointerCapture(id);
      } catch {
        /* pointer already gone */
      }
      haptic(12);
      engine.pause();
      dispatch({ type: "select", selection: { kind: "clip", id: clip.id } });
      setLift({ dx: 0, at: reorderTarget(doc.clips.map(clipDuration), index, tOf(x0)).at });
      // edge auto-scroll while holding near the sides
      const tick = () => {
        const q = press.current;
        const sc = scrollEl.current;
        if (!q || !q.active || !sc) return;
        const r = sc.getBoundingClientRect();
        const edge = 40;
        const v = q.lastX < r.left + edge ? -8 : q.lastX > r.right - edge ? 8 : 0;
        if (v) sc.scrollLeft += v;
        q.raf = requestAnimationFrame(tick);
      };
      p.raf = requestAnimationFrame(tick);
    }, LONG_PRESS_MS);
    press.current = { timer, x0, y0, id, active: false, target: index, raf: 0, lastX: x0 };
  };

  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    p.lastX = e.clientX;
    if (!p.active) {
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 8) endPress(); // it's a swipe/scrub
      return;
    }
    const r = reorderTarget(doc.clips.map(clipDuration), index, tOf(e.clientX));
    if (r.index !== p.target) haptic(6);
    p.target = r.index;
    setLift({ dx: e.clientX - p.x0, at: r.at });
  };

  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    const wasActive = p.active;
    justLifted.current = wasActive;
    const target = p.target;
    endPress();
    setLift(null);
    if (wasActive) {
      if (target !== index && e.type !== "pointercancel") apply((d) => moveClip(d, d.clips.findIndex((c) => c.id === clip.id), target));
    }
  };

  const onTrimDown = (edge: "start" | "end") => (e: RPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    engine.pause();
    const unlock = lockTouchScroll();
    const x0 = e.clientX;
    const orig = { ...clip };
    const assetDur = asset?.duration || undefined;
    let lastSnap: number | null = null;
    // Snap the moving edge's OUTPUT position to the playhead and the other cut points (never
    // to this clip's own starting edges — that would swallow small trims).
    const ownEdges = [start, start + clipDuration(orig)];
    const targets = [engine.time, 0, ...clipStartTimes(doc), timelineDuration(doc)].filter((t) => ownEdges.every((o) => Math.abs(o - t) > 1e-6));
    const el = e.currentTarget;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const dt = (ev.clientX - x0) / pps;
      let value = edge === "start" ? orig.sourceStart + dt : orig.sourceEnd + dt;
      // output position of the moving edge (left edge visually follows the finger)
      const outEdge = edge === "start" ? start + dt : start + (value - orig.sourceStart);
      const snapped = snapTo(outEdge, targets, SNAP_PX / pps);
      if (snapped !== null) value = edge === "start" ? orig.sourceStart + (snapped - start) : orig.sourceStart + (snapped - start);
      if (snapped !== lastSnap) {
        if (snapped !== null) haptic(8);
        lastSnap = snapped;
        onSnapLine(snapped);
      }
      const lo = edge === "start" ? 0 : orig.sourceStart + 0.1;
      const hi = edge === "start" ? orig.sourceEnd - 0.1 : (assetDur ?? Infinity);
      value = Math.min(hi, Math.max(lo, value));
      if (edge === "start") setTrimShift((value - orig.sourceStart) * pps);
      apply((d: EditorDoc) => trimClip(d, clip.id, edge, value, assetDur), { coalesce: `trim:${clip.id}:${edge}` });
      engine.previewSourceFrame(index, edge === "start" ? value : Math.max(orig.sourceStart, value - 0.04));
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      unlock();
      setTrimShift(0);
      onSnapLine(null);
      engine.previewSourceFrame(index, null);
      commit();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const left = half + start * pps + 1;
  return (
    <>
      <div
        className={`ed-mclip ${selected ? "ed-mclip-sel" : ""} ${lift ? "ed-mclip-lift" : ""}`}
        style={{
          left: left + trimShift,
          width,
          ["--clip-color" as string]: asset?.color ?? "#555",
          transform: lift ? `translate3d(${lift.dx}px, -4px, 0) scale(1.03)` : undefined,
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          if (justLifted.current) {
            justLifted.current = false;
            return;
          }
          dispatch({ type: "select", selection: selected ? null : { kind: "clip", id: clip.id } });
        }}
        role="button"
        aria-label={`Clip ${index + 1}: ${asset?.name ?? "take"}, ${dur.toFixed(1)} seconds`}
        aria-pressed={selected}
      >
        <div className="ed-mclip-inner">
          <Frames asset={asset} clip={clip} width={width} pps={pps} height={VIDEO_H} />
          {width > 48 && <span className="ed-mclip-dur">{dur.toFixed(1)}s</span>}
          {clip.volume === 0 && (
            <span className="ed-mclip-mute">
              <Icon name="mute" size={11} />
            </span>
          )}
        </div>
        {selected && (
          <>
            <div className="ed-mtrim ed-mtrim-l" onPointerDown={onTrimDown("start")} onClick={(e) => e.stopPropagation()} aria-label="Trim start" role="slider" aria-valuenow={clip.sourceStart} />
            <div className="ed-mtrim ed-mtrim-r" onPointerDown={onTrimDown("end")} onClick={(e) => e.stopPropagation()} aria-label="Trim end" role="slider" aria-valuenow={clip.sourceEnd} />
          </>
        )}
      </div>
      {lift && <div className="ed-mtl-drop" style={{ left: half + lift.at * pps }} />}
    </>
  );
});

// ---------------------------------------------------------------------------------------
// Text / zoom spans: tap = select; once selected, drag the body to move, handles to trim
// ---------------------------------------------------------------------------------------

function MSpan({
  kind,
  item,
  top,
  pps,
  half,
  duration,
  selected,
  label,
  background,
  onSnapLine,
}: {
  kind: "text" | "zoom";
  item: TimelineText | TimelineZoom;
  top: number;
  pps: number;
  half: number;
  duration: number;
  selected: boolean;
  label: string;
  background: string;
  onSnapLine: (t: number | null) => void;
}) {
  const { apply, commit, focus, engine, doc } = useEditor();
  const update = (d: EditorDoc, patch: { start: number; end: number }) => (kind === "text" ? updateText(d, item.id, patch) : updateZoom(d, item.id, patch));
  const moved = useRef(false);

  const drag = (mode: "move" | "start" | "end") => (e: RPointerEvent<HTMLDivElement>) => {
    if (!selected) return; // unselected: let the swipe scroll the timeline; tap selects
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    engine.pause();
    const unlock = lockTouchScroll();
    const x0 = e.clientX;
    const orig = { start: item.start, end: item.end };
    const own = [item.start, item.end];
    const targets = [0, duration, engine.time, ...clipStartTimes(doc), ...doc.texts.flatMap((t) => (t.id === item.id ? [] : [t.start, t.end])), ...doc.zooms.flatMap((z) => (z.id === item.id ? [] : [z.start, z.end]))].filter(
      (t) => own.every((o) => Math.abs(o - t) > 1e-6),
    );
    let lastSnap: number | null = null;
    moved.current = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!moved.current && Math.abs(ev.clientX - x0) < 4) return;
      moved.current = true;
      const dt = (ev.clientX - x0) / pps;
      let next: { start: number; end: number };
      let snapped: number | null;
      if (mode === "move") {
        let s = orig.start + dt;
        const len = orig.end - orig.start;
        const sStart = snapTo(s, targets, SNAP_PX / pps);
        const sEnd = snapTo(s + len, targets, SNAP_PX / pps);
        if (sStart !== null) s = sStart;
        else if (sEnd !== null) s = sEnd - len;
        snapped = sStart ?? sEnd;
        next = moveSpan(orig, s, duration);
      } else {
        let v = (mode === "start" ? orig.start : orig.end) + dt;
        snapped = snapTo(v, targets, SNAP_PX / pps);
        if (snapped !== null) v = snapped;
        next = trimSpan(orig, mode, v, duration);
      }
      if (snapped !== lastSnap) {
        if (snapped !== null) haptic(8);
        lastSnap = snapped;
        onSnapLine(snapped);
      }
      apply((d) => update(d, next), { coalesce: `${kind}:${mode}:${item.id}` });
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      unlock();
      onSnapLine(null);
      commit();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div
      className={`ed-mspan ${selected ? "ed-mspan-sel" : ""}`}
      style={{ left: half + item.start * pps, width: Math.max(10, (item.end - item.start) * pps), top, background }}
      onPointerDown={drag("move")}
      onClick={(e) => {
        e.stopPropagation();
        if (moved.current) {
          moved.current = false;
          return;
        }
        if (!selected) focus({ kind, id: item.id });
      }}
      role="button"
      aria-label={`${kind === "text" ? "Text" : "Zoom"}: ${label}`}
      aria-pressed={selected}
    >
      <span>{label}</span>
      {selected && (
        <>
          <div className="ed-mspan-h ed-mspan-h-l" onPointerDown={drag("start")} aria-label={`${kind} start`} />
          <div className="ed-mspan-h ed-mspan-h-r" onPointerDown={drag("end")} aria-label={`${kind} end`} />
        </>
      )}
    </div>
  );
}
