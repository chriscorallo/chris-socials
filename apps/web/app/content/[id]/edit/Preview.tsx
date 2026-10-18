"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type RefObject } from "react";
import { anchorOffsetFor, layoutTimelineText, locateOutputTime, resolveGrade, timelineDuration, type TimelineCrop, type TimelineText, type TimelineVisual } from "@chris/media/timeline";
import { updateClip, updateZoom, updateText, updateCaptions, setCover } from "../../../../lib/editor/timeline-ops";
import { panAfterDrag, formatTime, vignetteGradient } from "../../../../lib/editor/preview-math";
import { moveAnchoredVisual, placeVisualManually } from "../../../../lib/editor/visuals";
import { movedBeyond, pinchGeometry, type Pt } from "../../../../lib/editor/touch-math";
import { PLATFORM_IDS, PLATFORM_SHORT_LABEL, type PlatformId } from "../../../../lib/editor/platform-profiles";
import { PlatformMock } from "./PlatformMock";
import { useEditor, type PlatformView } from "./context";
import { assignPlayers, useIsPlaying, usePlayheadValue } from "./playback";
import { GradeDefs, OverlaySvg } from "./Overlays";
import { browserMeasureText } from "./measure";
import { Icon } from "./icons";
import { MotionLayer, VisualHandles, drawnPlacement, visualHitRect } from "./MotionLayer";
import { FullscreenButton, StageCanvas } from "./Fullscreen";

export { fontFamilyCss } from "./Overlays";

/** Largest canvas of the given aspect that fits the element (minus padding); follows resizes. */
export function useFitCanvas(ref: RefObject<HTMLElement | null>, aspect: number, padX: number, padY: number) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const availW = el.clientWidth - padX;
      const availH = el.clientHeight - padY;
      let h = availH;
      let w = h * aspect;
      if (w > availW) {
        w = availW;
        h = w / aspect;
      }
      const next = { w: Math.max(0, Math.floor(w)), h: Math.max(0, Math.floor(h)) };
      setSize((s) => (s.w === next.w && s.h === next.h ? s : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, aspect, padX, padY]);
  return size;
}

/** Desktop preview column: platform switch + reframe + warnings, the canvas, the transport. */
export function Preview() {
  const { doc, ui, setUi, engine, state, apply, toast } = useEditor();
  const selectedClip = state.selection?.kind === "clip" ? doc.clips.find((c) => c.id === (state.selection as { id: string }).id) : undefined;

  return (
    <section className="ed-stage" aria-label="Preview">
      <div className="ed-stage-head">
        <div className="flex items-center gap-1.5">
          <PlatformSwitch value={ui.platformView} onChange={(v) => setUi({ platformView: v })} />
          {ui.platformView !== "ALL" && <MockToggle />}
        </div>
        <div className="flex items-center gap-1.5">
          <FullscreenButton className="ed-fs-enter-inline" />
          <button
            type="button"
            className="ed-toolbtn"
            aria-pressed={ui.reframe}
            disabled={!selectedClip}
            title={selectedClip ? "Drag the picture to reframe this clip; scroll to zoom" : "Select a clip to reframe it"}
            onClick={() => {
              if (!selectedClip) return;
              enterReframe(engine, doc, selectedClip.id, ui.reframe, setUi);
            }}
          >
            <Icon name="crop" size={14} /> Reframe
          </button>
          <WarningsPill />
        </div>
      </div>
      <StageCanvas className="ed-stage-body" padX={32} padY={12} />
      <Transport
        onCover={() => {
          apply((d) => setCover(d, engine.time));
          toast(`Cover set at ${formatTime(engine.time, true)}`);
        }}
      />
    </section>
  );
}

/** Toggles reframe mode for a clip, moving the playhead into it first so its frame is on screen. */
export function enterReframe(
  engine: ReturnType<typeof useEditor>["engine"],
  doc: ReturnType<typeof useEditor>["doc"],
  clipId: string,
  on: boolean,
  setUi: ReturnType<typeof useEditor>["setUi"],
) {
  const idx = doc.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return;
  const starts = doc.clips.slice(0, idx).reduce((s, c) => s + c.sourceEnd - c.sourceStart, 0);
  const loc = locateOutputTime(doc, engine.time);
  if (!on && loc?.clipIndex !== idx) engine.seek(starts + 0.01);
  engine.pause();
  setUi({ reframe: !on });
}

/** Shows / hides the app UI mock over the preview (platform tabs). */
export function MockToggle() {
  const { ui, setUi } = useEditor();
  return (
    <button
      type="button"
      className="ed-mock-toggle"
      aria-pressed={ui.platformMock}
      aria-label={ui.platformMock ? "Hide the app's buttons" : "Show the app's buttons"}
      title={ui.platformMock ? "Hide the app's buttons" : "Show the app's buttons"}
      onClick={() => setUi({ platformMock: !ui.platformMock })}
    >
      <Icon name={ui.platformMock ? "eye" : "eyeOff"} size={16} />
    </button>
  );
}

export function PlatformSwitch({ value, onChange, compact }: { value: PlatformView; onChange: (v: PlatformView) => void; compact?: boolean }) {
  const opts: Array<[PlatformView, string]> = [["ALL", "All"], ...PLATFORM_IDS.map((p) => [p, PLATFORM_SHORT_LABEL[p]] as [PlatformView, string])];
  return (
    <div className={`ed-seg ${compact ? "ed-seg-compact" : ""}`} role="group" aria-label="Preview as platform">
      {opts.map(([v, label]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)} title={v === "ALL" ? "Safe area for every platform" : `Preview with ${label}'s on-screen buttons`}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** The platform warnings as a tappable list (desktop popover and the touch "Platforms" sheet). */
export function WarningsList({ onPicked }: { onPicked?: () => void }) {
  const { warnings, focus, ui } = useEditor();
  const scope = ui.platformView === "ALL" ? "all platforms" : PLATFORM_SHORT_LABEL[ui.platformView];
  if (!warnings.length) {
    return (
      <p className="ed-ok-note">
        <Icon name="check" size={15} /> Nothing is covered by {scope}&apos;s buttons, and the length fits.
      </p>
    );
  }
  return (
    <ul className="ed-warn-list">
      {warnings.map((w) => (
        <li key={w.id}>
          <button
            type="button"
            disabled={!w.target}
            onClick={() => {
              if (w.target) focus(w.target);
              onPicked?.();
            }}
          >
            <span className="mt-0.5 text-[var(--color-gold-400)]">
              <Icon name="warn" size={14} />
            </span>
            <span className="flex-1">
              {w.message}
              {ui.platformView === "ALL" && <span className="ed-warn-platforms">{w.platforms.map((p) => PLATFORM_SHORT_LABEL[p]).join(" · ")}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function WarningsPill() {
  const { warnings, ui } = useEditor();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const scope = ui.platformView === "ALL" ? "all platforms" : PLATFORM_SHORT_LABEL[ui.platformView];
  if (!warnings.length) {
    return (
      <span className="ed-chip" title={`Nothing is covered by ${scope}'s buttons, and the length fits.`} style={{ color: "var(--color-emerald-400)" }}>
        <Icon name="check" size={13} /> Fits {scope}
      </span>
    );
  }
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="ed-chip ed-chip-gold" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="warn" size={13} /> {warnings.length} to check
      </button>
      {open && (
        <div className="ed-popover right-0 top-9 w-[300px]">
          <p className="ed-eyebrow mb-2">For {scope}</p>
          <WarningsList onPicked={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function Transport({ onCover }: { onCover: () => void }) {
  const { engine, doc } = useEditor();
  const playing = useIsPlaying(engine);
  const t = usePlayheadValue(engine, (x) => Math.floor(x * 100) / 100);
  const d = timelineDuration(doc);
  return (
    <div className="ed-transport">
      <span className="w-[120px] text-right text-[12px] tabular-nums text-[var(--color-text-muted)]">
        <span className="text-[var(--color-text)]">{formatTime(t, true)}</span> / {formatTime(d, true)}
      </span>
      <button type="button" className="ed-iconbtn" aria-label="Go to start" onClick={() => engine.seek(0)}>
        <Icon name="skipBack" />
      </button>
      <button type="button" className="ed-playbtn" aria-label={playing ? "Pause" : "Play"} onClick={() => engine.toggle()}>
        <Icon name={playing ? "pause" : "play"} size={18} />
      </button>
      <button type="button" className="ed-iconbtn" aria-label="Go to end" onClick={() => engine.seek(d)}>
        <Icon name="skipFwd" />
      </button>
      <span className="w-[120px]">
        <button type="button" className="ed-toolbtn" onClick={onCover} title="Use the frame at the playhead as the video's cover">
          <Icon name="image" size={14} /> Set cover
        </button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Canvas + gesture controller
// ---------------------------------------------------------------------------------------

type Target =
  | { kind: "text"; id: string; wasSelected: boolean }
  | { kind: "text-resize"; id: string }
  | { kind: "captions" }
  | { kind: "reframe"; id: string }
  | { kind: "focal"; id: string }
  | { kind: "visual"; id: string; wasSelected: boolean }
  | { kind: "visual-resize"; id: string }
  | { kind: "stage" };

interface Gesture {
  target: Target;
  pointers: Map<number, Pt>;
  downAt: Pt;
  moved: boolean;
  /** Pose + values at the last change in finger count (so adding/lifting a finger never jumps). */
  base: { pts: Pt[]; text?: TimelineText; crop?: TimelineCrop; capY: number; capSize: number; resizeD0?: number; center?: Pt; visual?: TimelineVisual };
}

const SNAP_PX = 6;

/**
 * The 9:16 preview. One pointer-events gesture controller handles mouse and touch:
 * - drag a text to move it (centre guides snap), pinch to resize it (two fingers anywhere
 *   while a text is selected), tap a selected text to type into it;
 * - drag captions up/down, pinch to resize them;
 * - Reframe mode: one finger pans the clip's crop, two fingers zoom it (wheel on desktop);
 * - a selected zoom: tap/drag sets where it aims;
 * - otherwise a tap toggles playback (touch) or selects the clip on screen (mouse).
 * The canvas has `touch-action: none`, so the browser never scrolls or zooms the page here.
 */
export function Canvas({ w, h, view = false, viewPlatform = null }: { w: number; h: number; view?: boolean; viewPlatform?: PlatformId | null }) {
  const { doc, engine, assetMap, ui, setUi, state, apply, commit, dispatch, touch, placement, interactions, interactionCtx } = useEditor();
  const k = w / doc.canvas.width;
  const zoomLayerRef = useRef<HTMLDivElement>(null);
  const { slots } = useMemo(() => assignPlayers(doc.clips.length), [doc.clips.length]);
  const progress = usePlayheadValue(engine, (t) => (view && viewPlatform ? Math.round((t / Math.max(0.01, timelineDuration(doc))) * 400) / 400 : 0));
  const g = resolveGrade(doc.grade);
  const gradeOn = g.brightness !== 0 || g.contrast !== 1 || g.saturation !== 1 || g.temperature !== 0;
  const vignette = vignetteGradient(g.vignette);
  const [dragging, setDragging] = useState(false);
  const [guides, setGuides] = useState({ v: false, h: false });
  const [draggingVisual, setDraggingVisual] = useState<string | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef({ doc, selection: state.selection, visuals: placement.visuals, interactions, interactionCtx });
  useEffect(() => {
    latest.current = { doc, selection: state.selection, visuals: placement.visuals, interactions, interactionCtx };
  });

  useLayoutEffect(() => {
    engine.setZoomLayer(zoomLayerRef.current);
    return () => engine.setZoomLayer(null);
  }, [engine]);
  useEffect(() => {
    engine.setViewport(w, h);
  }, [engine, w, h]);

  const selectedClip = state.selection?.kind === "clip" ? doc.clips.find((c) => c.id === (state.selection as { id: string }).id) : undefined;
  const selectedZoom = state.selection?.kind === "zoom" ? doc.zooms.find((z) => z.id === (state.selection as { id: string }).id) : undefined;

  const W = doc.canvas.width;
  const H = doc.canvas.height;

  const rebase = (gs: Gesture) => {
    const d = latest.current.doc;
    const pts = [...gs.pointers.values()];
    const t = gs.target;
    const text = t.kind === "text" || t.kind === "text-resize" ? d.texts.find((x) => x.id === t.id) : undefined;
    const clip = t.kind === "reframe" ? d.clips.find((c) => c.id === t.id) : undefined;
    // Graphics start from where they're DRAWN (an AUTO one's solved spot), so taking manual
    // control never makes it jump.
    const found = t.kind === "visual" || t.kind === "visual-resize" ? latest.current.visuals.find((v) => v.id === t.id) : undefined;
    // A graphic that follows Chris / rides the camera starts from where it's drawn NOW.
    const drawn = found ? drawnPlacement(found, latest.current.interactions[found.id], engine.time, d.canvas) : null;
    const visual = found && drawn ? { ...found, placement: { ...found.placement, x: drawn.x, y: drawn.y } } : found;
    gs.base = { pts, text, crop: clip?.crop, capY: d.captions.y, capSize: d.captions.fontSize, visual };
  };

  const canvasPt = (e: { clientX: number; clientY: number }, el: HTMLElement): Pt => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const setFocal = (id: string, p: Pt) => {
    const x = Math.round(Math.min(1, Math.max(0, p.x / w)) * 1000) / 1000;
    const y = Math.round(Math.min(1, Math.max(0, p.y / h)) * 1000) / 1000;
    apply((d) => updateZoom(d, id, { x, y }), { coalesce: `focal:${id}` });
  };

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Touch/pen: suppress the compatibility mousedown, which would steal focus from the
    // keyboard bar opened by a tap (and close the iOS keyboard right after it opens).
    if (e.pointerType !== "mouse") e.preventDefault();
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    const p = canvasPt(e, el);
    // A primary pointer always starts a fresh gesture (a lost pointerup must never leave a
    // stale gesture that swallows the next touch).
    if (e.isPrimary && gesture.current) {
      gesture.current = null;
      setGuides({ v: false, h: false });
      setDragging(false);
      commit();
    }
    const gs = gesture.current;
    if (gs) {
      if (gs.pointers.size >= 2) return;
      gs.pointers.set(e.pointerId, p);
      // Pinching on empty picture while a text is selected scales that text.
      const sel = latest.current.selection;
      if (gs.target.kind === "stage" && sel?.kind === "text") gs.target = { kind: "text", id: sel.id, wasSelected: true };
      if (gs.target.kind === "stage" && sel?.kind === "captions") gs.target = { kind: "captions" };
      if (gs.target.kind === "stage" && sel?.kind === "visual") gs.target = { kind: "visual", id: sel.id, wasSelected: true };
      gs.moved = true;
      rebase(gs);
      return;
    }
    const hit = (e.target as Element).closest?.("[data-gesture]") as HTMLElement | SVGElement | null;
    const kind = hit?.getAttribute("data-gesture");
    const hitId = hit?.getAttribute("data-id") ?? "";
    let target: Target;
    if (ui.reframe && selectedClip) {
      target = { kind: "reframe", id: selectedClip.id };
    } else if (kind === "text-resize") {
      target = { kind: "text-resize", id: hitId };
    } else if (kind === "text") {
      const wasSelected = state.selection?.kind === "text" && state.selection.id === hitId;
      target = { kind: "text", id: hitId, wasSelected };
      engine.pause();
      if (!wasSelected) dispatch({ type: "select", selection: { kind: "text", id: hitId } });
      if (!touch) setUi({ tab: "selection" });
    } else if (kind === "visual-resize") {
      target = { kind: "visual-resize", id: hitId };
      engine.pause();
    } else if (kind === "visual") {
      const wasSelected = state.selection?.kind === "visual" && state.selection.id === hitId;
      target = { kind: "visual", id: hitId, wasSelected };
      engine.pause();
      if (!wasSelected) dispatch({ type: "select", selection: { kind: "visual", id: hitId } });
      if (!touch) setUi({ tab: "selection" });
    } else if (kind === "captions") {
      target = { kind: "captions" };
      if (state.selection?.kind !== "captions") dispatch({ type: "select", selection: { kind: "captions" } });
      if (!touch) setUi({ tab: "captions" });
    } else if (selectedZoom) {
      target = { kind: "focal", id: selectedZoom.id };
      setFocal(selectedZoom.id, p);
    } else {
      target = { kind: "stage" };
      if (!touch) {
        // Clicking the picture selects the clip on screen.
        const loc = locateOutputTime(doc, engine.time);
        const clip = loc ? doc.clips[loc.clipIndex] : undefined;
        dispatch({ type: "select", selection: clip ? { kind: "clip", id: clip.id } : null });
      }
    }
    const next: Gesture = { target, pointers: new Map([[e.pointerId, p]]), downAt: p, moved: false, base: { pts: [], capY: 0, capSize: 0 } };
    rebase(next);
    if (target.kind === "text-resize" && next.base.text) {
      const L = layoutTimelineText(next.base.text, doc.canvas, browserMeasureText);
      const center = { x: (L.rect.x + L.rect.width / 2) * k, y: (L.rect.y + L.rect.height / 2) * k };
      next.base.center = center;
      next.base.resizeD0 = Math.max(8, Math.hypot(p.x - center.x, p.y - center.y));
    }
    if (target.kind === "visual-resize" && next.base.visual) {
      const r = visualHitRect(next.base.visual, doc.canvas);
      const center = { x: (r.x + r.width / 2) * k, y: (r.y + r.height / 2) * k };
      next.base.center = center;
      next.base.resizeD0 = Math.max(8, Math.hypot(p.x - center.x, p.y - center.y));
    }
    gesture.current = next;
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const gs = gesture.current;
    if (!gs || !gs.pointers.has(e.pointerId)) return;
    const p = canvasPt(e, e.currentTarget);
    gs.pointers.set(e.pointerId, p);
    const pts = [...gs.pointers.values()];
    if (!gs.moved) {
      if (pts.length === 1 && !movedBeyond(gs.downAt, p, e.pointerType === "mouse" ? 3 : 8)) return;
      gs.moved = true;
      rebase(gs);
      gs.base.pts = [gs.downAt];
      if (gs.target.kind === "text" || gs.target.kind === "captions") setDragging(true);
      if (gs.target.kind === "visual" || gs.target.kind === "visual-resize") {
        setDragging(true);
        setDraggingVisual(gs.target.id);
      }
    }
    const t = gs.target;
    const b = gs.base;
    const two = pts.length >= 2 && b.pts.length >= 2;
    const pinch = two ? pinchGeometry(b.pts[0]!, b.pts[1]!, pts[0]!, pts[1]!) : { scale: 1, dx: pts[0]!.x - b.pts[0]!.x, dy: pts[0]!.y - b.pts[0]!.y };

    if (t.kind === "text" && b.text) {
      let nx = b.text.x + pinch.dx / k / W;
      let ny = b.text.y + pinch.dy / k / H;
      const snapPx = touch ? 10 : SNAP_PX;
      const snapV = Math.abs(nx - 0.5) * W * k < snapPx;
      const snapH = Math.abs(ny - 0.5) * H * k < snapPx;
      if (snapV) nx = 0.5;
      if (snapH) ny = 0.5;
      setGuides((gd) => (gd.v === snapV && gd.h === snapH ? gd : { v: snapV, h: snapH }));
      nx = Math.round(Math.min(1, Math.max(0, nx)) * 1000) / 1000;
      ny = Math.round(Math.min(1, Math.max(0, ny)) * 1000) / 1000;
      const patch: Partial<TimelineText> = { x: nx, y: ny };
      if (two) patch.fontSize = Math.round(Math.min(400, Math.max(12, b.text.fontSize * pinch.scale)));
      apply((d) => updateText(d, t.id, patch), { coalesce: `move:${t.id}` });
    } else if (t.kind === "text-resize" && b.text && b.center && b.resizeD0) {
      const d1 = Math.hypot(p.x - b.center.x, p.y - b.center.y);
      const fontSize = Math.round(Math.min(400, Math.max(12, (b.text.fontSize * d1) / b.resizeD0)));
      apply((d) => updateText(d, t.id, { fontSize }), { coalesce: `size:${t.id}` });
    } else if (t.kind === "captions") {
      const y = Math.round(Math.min(0.95, Math.max(0.05, b.capY + pinch.dy / k / H)) * 1000) / 1000;
      const patch = two ? { y, fontSize: Math.round(Math.min(200, Math.max(24, b.capSize * pinch.scale))) } : { y };
      apply((d) => updateCaptions(d, patch), { coalesce: "captions:y" });
    } else if (t.kind === "reframe" && b.crop) {
      const clip = latest.current.doc.clips.find((c) => c.id === t.id);
      const asset = clip ? assetMap.get(clip.mediaAssetId) : undefined;
      const zoom = two ? Math.round(Math.min(4, Math.max(1, b.crop.zoom * pinch.scale)) * 1000) / 1000 : b.crop.zoom;
      const start = { ...b.crop, zoom };
      const pan = panAfterDrag(start, { width: asset?.width ?? 1080, height: asset?.height ?? 1920 }, doc.canvas, (pinch.dx * W) / w, (pinch.dy * W) / w);
      apply((d) => updateClip(d, t.id, { crop: { ...start, ...pan } }), { coalesce: `crop:${t.id}` });
    } else if (t.kind === "visual" && b.visual) {
      // Dragging a graphic = Chris places it: MANUAL from here on (Auto-place hands it back).
      const pl = b.visual.placement;
      let nx = pl.x + pinch.dx / k / W;
      let ny = pl.y + pinch.dy / k / H;
      const snapPx = touch ? 10 : SNAP_PX;
      const snapV = Math.abs(nx - 0.5) * W * k < snapPx;
      const snapH = Math.abs(ny - 0.5) * H * k < snapPx;
      if (snapV) nx = 0.5;
      if (snapH) ny = 0.5;
      setGuides((gd) => (gd.v === snapV && gd.h === snapH ? gd : { v: snapV, h: snapH }));
      const patch = two ? { x: nx, y: ny, scale: pl.scale * pinch.scale } : { x: nx, y: ny };
      if (b.visual.anchor.type === "SUBJECT") {
        // Following Chris: dragging sets where it sits relative to him (offset at the playhead).
        const tNow = Math.min(b.visual.end - 0.05, Math.max(b.visual.start, engine.time));
        const off = anchorOffsetFor({ placement: { ...pl, x: nx, y: ny } }, latest.current.doc, tNow, latest.current.interactionCtx);
        if (off) {
          apply((d) => moveAnchoredVisual(d, t.id, off, { x: nx, y: ny }, patch.scale), { coalesce: `vmove:${t.id}` });
          return;
        }
      }
      apply((d) => placeVisualManually(d, t.id, patch), { coalesce: `vmove:${t.id}` });
    } else if (t.kind === "visual-resize" && b.visual && b.center && b.resizeD0) {
      const d1 = Math.hypot(p.x - b.center.x, p.y - b.center.y);
      const pl = b.visual.placement;
      apply((d) => placeVisualManually(d, t.id, { x: pl.x, y: pl.y, scale: (pl.scale * d1) / b.resizeD0! }), { coalesce: `vsize:${t.id}` });
    } else if (t.kind === "focal" && !two) {
      setFocal(t.id, p);
    }
  };

  const onPointerEnd = (e: RPointerEvent<HTMLDivElement>) => {
    const gs = gesture.current;
    if (!gs || !gs.pointers.has(e.pointerId)) return;
    gs.pointers.delete(e.pointerId);
    if (gs.pointers.size > 0) {
      rebase(gs);
      return;
    }
    gesture.current = null;
    setGuides({ v: false, h: false });
    setDragging(false);
    setDraggingVisual(null);
    commit();
    if (gs.moved || e.type === "pointercancel") return;
    // ---- taps
    const t = gs.target;
    if (t.kind === "text" && t.wasSelected) setUi({ editingTextId: t.id });
    else if (t.kind === "visual" && t.wasSelected && touch) setUi({ sheet: "visuals" });
    else if (t.kind === "stage" && touch) {
      if (state.selection && state.selection.kind !== "clip") dispatch({ type: "select", selection: null });
      else engine.toggle();
    }
  };

  useEffect(() => {
    const el = zoomLayerRef.current?.parentElement?.parentElement;
    if (!el || !ui.reframe || !selectedClip) return;
    const id = selectedClip.id;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      apply(
        (d) => {
          const c = d.clips.find((x) => x.id === id);
          if (!c) return d;
          const zoom = Math.round(Math.min(4, Math.max(1, c.crop.zoom * Math.exp(-e.deltaY * 0.0025))) * 1000) / 1000;
          return updateClip(d, id, { crop: { ...c.crop, zoom } });
        },
        { coalesce: `cropzoom:${id}` },
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ui.reframe, selectedClip, apply]);

  return (
    <div
      className={view ? "ed-canvas ed-canvas-view" : "ed-canvas"}
      style={{ width: w, height: h, cursor: view ? undefined : ui.reframe ? "move" : selectedZoom ? "crosshair" : "default" }}
      onPointerDown={view ? undefined : onPointerDown}
      onPointerMove={view ? undefined : onPointerMove}
      onPointerUp={view ? undefined : onPointerEnd}
      onPointerCancel={view ? undefined : onPointerEnd}
    >
      <GradeDefs grade={doc.grade} />
      {/* video layer: clip crop → punch-in zoom (engine) → grade (exact SVG filter) */}
      <div className="ed-layer" style={{ filter: gradeOn ? "url(#ed-grade)" : undefined }}>
        <div className="ed-layer" ref={zoomLayerRef} style={{ willChange: "transform" }}>
          {slots.map((key) => (
            <video key={key} ref={engine.playerRef(key)} preload="auto" playsInline disablePictureInPicture disableRemotePlayback style={{ opacity: 0 }} aria-label="Preview video" />
          ))}
        </div>
      </div>
      {vignette && <div className="ed-layer pointer-events-none" style={{ background: vignette }} />}
      {/* motion graphics: over the graded picture, under texts/captions — the renderer's order */}
      <MotionLayer w={w} h={h} />

      {!view && ui.reframe && <ReframeGrid touch={touch} />}
      {view ? (
        viewPlatform && <PlatformMock platform={viewPlatform} w={w} h={h} progress={progress} className="z-[7]" />
      ) : (
        (ui.platformMock || dragging) && <PlatformMock platform={ui.platformView} w={w} h={h} zones={dragging} className={ui.platformView === "ALL" ? "z-[2]" : "z-[7] ed-mock-edit"} />
      )}

      {!view && !ui.reframe && <VisualHandles w={w} dragging={draggingVisual} />}
      <OverlaySvg w={w} h={h} guides={guides} inlineEditor={!touch && !view} />

      {!view && selectedZoom && (
        <div className="pointer-events-none absolute z-[5]" style={{ left: selectedZoom.x * w - 14, top: selectedZoom.y * h - 14, width: 28, height: 28 }} aria-hidden>
          <div className="h-full w-full rounded-full border-2 border-[var(--color-gold-400)] shadow-[0_0_0_2px_rgba(0,0,0,0.4)]" />
          <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-gold-400)]" />
        </div>
      )}
      {!view && selectedZoom && (
        <p className="pointer-events-none absolute inset-x-0 bottom-3 z-[5] px-2 text-center text-[11px] text-white/85 [text-shadow:0_1px_3px_rgba(0,0,0,0.8)]">
          {touch ? "Tap the video to aim the zoom" : "Click to set where the zoom aims"}
        </p>
      )}
    </div>
  );
}

function ReframeGrid({ touch }: { touch: boolean }) {
  return (
    <div className="ed-layer pointer-events-none z-[4]" aria-hidden>
      {[1, 2].map((i) => (
        <div key={`v${i}`} className="absolute top-0 bottom-0 w-px bg-white/30" style={{ left: `${(i * 100) / 3}%` }} />
      ))}
      {[1, 2].map((i) => (
        <div key={`h${i}`} className="absolute left-0 right-0 h-px bg-white/30" style={{ top: `${(i * 100) / 3}%` }} />
      ))}
      <div className="absolute inset-0 rounded-[inherit] ring-2 ring-inset ring-[var(--color-gold-400)]" />
      <p className="absolute inset-x-0 top-3 px-2 text-center text-[11px] font-medium text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.9)]">
        {touch ? "Drag to reframe · pinch to zoom" : "Drag to reframe · scroll to zoom"}
      </p>
    </div>
  );
}
