"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { findFont, locateOutputTime, timelineDuration, type TimelineText } from "@chris/media/timeline";
import { updateText, updateCaptions, updateClip, updateZoom, setCover } from "../../../../lib/editor/timeline-ops";
import { gradeCss, hexToRgba, panAfterDrag, strokePx, formatTime } from "../../../../lib/editor/preview-math";
import { PLATFORM_PROFILES, PLATFORM_IDS, type PlatformId } from "../../../../lib/editor/platform-profiles";
import { safeRect } from "../../../../lib/editor/platform-warnings";
import { useEditor, type PlatformView } from "./context";
import { assignPlayers, useIsPlaying, usePlayheadValue } from "./playback";
import { Icon } from "./icons";

const SNAP_PX = 6;

export function fontFamilyCss(fontId: string): string {
  const f = findFont(fontId);
  return f ? `"${f.family}", "Inter", sans-serif` : `"Inter", sans-serif`;
}

/** CSS for a text element at preview scale k (= preview px per canvas px). */
export function textCss(t: Pick<TimelineText, "fontId" | "fontSize" | "color" | "backgroundColor" | "strokeColor" | "align" | "uppercase">, k: number): CSSProperties {
  const fs = t.fontSize * k;
  return {
    fontFamily: fontFamilyCss(t.fontId),
    fontSize: `${fs}px`,
    color: t.color,
    textAlign: t.align,
    textTransform: t.uppercase ? "uppercase" : "none",
    WebkitTextStroke: t.strokeColor ? `${strokePx(t.fontSize) * k * 2}px ${t.strokeColor}` : undefined,
    background: t.backgroundColor ? hexToRgba(t.backgroundColor) : undefined,
    padding: t.backgroundColor ? "0.3em 0.45em" : undefined,
    borderRadius: t.backgroundColor ? "0.22em" : undefined,
  };
}

export function Preview() {
  const { doc, ui, setUi, engine, state, apply, toast } = useEditor();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const aspect = doc.canvas.width / doc.canvas.height;

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const availW = r.width - 32;
      const availH = r.height - 12;
      let h = availH;
      let w = h * aspect;
      if (w > availW) {
        w = availW;
        h = w / aspect;
      }
      setSize({ w: Math.max(0, Math.floor(w)), h: Math.max(0, Math.floor(h)) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  useEffect(() => {
    engine.setViewport(size.w, size.h);
  }, [engine, size]);

  const selectedClip = state.selection?.kind === "clip" ? doc.clips.find((c) => c.id === (state.selection as { id: string }).id) : undefined;

  return (
    <section className="ed-stage" aria-label="Preview">
      <div className="ed-stage-head">
        <PlatformSwitch value={ui.platformView} onChange={(v) => setUi({ platformView: v })} />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="ed-toolbtn"
            aria-pressed={ui.reframe}
            disabled={!selectedClip}
            title={selectedClip ? "Drag the picture to reframe this clip; scroll to zoom" : "Select a clip to reframe it"}
            onClick={() => {
              if (!selectedClip) return;
              const idx = doc.clips.indexOf(selectedClip);
              const starts = doc.clips.slice(0, idx).reduce((s, c) => s + c.sourceEnd - c.sourceStart, 0);
              const loc = locateOutputTime(doc, engine.time);
              if (loc?.clipIndex !== idx) engine.seek(starts + 0.01);
              setUi({ reframe: !ui.reframe });
            }}
          >
            <Icon name="crop" size={14} /> Reframe
          </button>
          <WarningsPill />
        </div>
      </div>
      <div className="ed-stage-body" ref={bodyRef}>
        {size.w > 0 && <Canvas w={size.w} h={size.h} />}
      </div>
      <Transport
        onCover={() => {
          apply((d) => setCover(d, engine.time));
          toast(`Cover set at ${formatTime(engine.time, true)}`);
        }}
      />
    </section>
  );
}

function PlatformSwitch({ value, onChange }: { value: PlatformView; onChange: (v: PlatformView) => void }) {
  const opts: Array<[PlatformView, string]> = [["ALL", "All"], ...PLATFORM_IDS.map((p) => [p, PLATFORM_PROFILES[p].label] as [PlatformView, string])];
  return (
    <div className="ed-seg" role="group" aria-label="Preview as platform">
      {opts.map(([v, label]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)} title={v === "ALL" ? "Safe area for every platform" : `Preview with ${label}'s on-screen buttons`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function WarningsPill() {
  const { warnings, focus, ui } = useEditor();
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
  const scope = ui.platformView === "ALL" ? "all platforms" : PLATFORM_PROFILES[ui.platformView].label;
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
          <ul className="flex flex-col gap-1">
            {warnings.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-white/[0.06] disabled:hover:bg-transparent"
                  onClick={() => {
                    if (w.target) focus(w.target);
                    setOpen(false);
                  }}
                >
                  <span className="mt-0.5 text-[var(--color-gold-400)]">
                    <Icon name="warn" size={13} />
                  </span>
                  <span className="flex-1">
                    {w.message}
                    {ui.platformView === "ALL" && (
                      <span className="mt-0.5 block text-[11px] text-[var(--color-text-faint)]">
                        {w.platforms.map((p) => PLATFORM_PROFILES[p].label).join(" · ")}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
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
// Canvas
// ---------------------------------------------------------------------------------------

function Canvas({ w, h }: { w: number; h: number }) {
  const { doc, engine, assetMap, ui, state, apply, commit, dispatch } = useEditor();
  const k = w / doc.canvas.width;
  const zoomLayerRef = useRef<HTMLDivElement>(null);
  const { slots } = useMemo(() => assignPlayers(doc, assetMap), [doc, assetMap]);
  const grade = gradeCss(doc.grade);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    engine.setZoomLayer(zoomLayerRef.current);
    return () => engine.setZoomLayer(null);
  }, [engine]);

  const selectedClip = state.selection?.kind === "clip" ? doc.clips.find((c) => c.id === (state.selection as { id: string }).id) : undefined;
  const selectedZoom = state.selection?.kind === "zoom" ? doc.zooms.find((z) => z.id === (state.selection as { id: string }).id) : undefined;

  // Reframe: drag pans, wheel zooms the selected clip's crop.
  const onCanvasPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (ui.reframe && selectedClip) {
      const asset = assetMap.get(selectedClip.mediaAssetId);
      const start = { x: e.clientX, y: e.clientY, crop: selectedClip.crop };
      const id = selectedClip.id;
      e.currentTarget.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const pan = panAfterDrag(start.crop, asset?.width ?? 1080, asset?.height ?? 1920, w, h, ev.clientX - start.x, ev.clientY - start.y);
        apply((d) => updateClip(d, id, { crop: { ...start.crop, ...pan } }), { coalesce: `crop:${id}` });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        commit();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
    if (selectedZoom) {
      const id = selectedZoom.id;
      const setFocal = (cx: number, cy: number) => {
        const x = Math.round(Math.min(1, Math.max(0, (cx - rect.left) / rect.width)) * 1000) / 1000;
        const y = Math.round(Math.min(1, Math.max(0, (cy - rect.top) / rect.height)) * 1000) / 1000;
        apply((d) => updateZoom(d, id, { x, y }), { coalesce: `focal:${id}` });
      };
      setFocal(e.clientX, e.clientY);
      const move = (ev: PointerEvent) => setFocal(ev.clientX, ev.clientY);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        commit();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
    // Clicking the picture selects the clip on screen.
    const loc = locateOutputTime(doc, engine.time);
    const clip = loc ? doc.clips[loc.clipIndex] : undefined;
    dispatch({ type: "select", selection: clip ? { kind: "clip", id: clip.id } : null });
  };

  useEffect(() => {
    const el = zoomLayerRef.current?.parentElement;
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
      className="ed-canvas"
      style={{ width: w, height: h, cursor: ui.reframe ? "move" : selectedZoom ? "crosshair" : "default" }}
      onPointerDown={onCanvasPointerDown}
    >
      <div className="ed-layer" ref={zoomLayerRef} style={{ filter: grade.filter === "none" ? undefined : grade.filter, willChange: "transform" }}>
        {slots.map((s) => (
          <video
            key={s.key}
            ref={engine.playerRef(s.key)}
            src={s.asset.url}
            preload="auto"
            playsInline
            style={{ opacity: 0 }}
            aria-label={`Take ${s.asset.name}`}
          />
        ))}
        {grade.wash && <div className="ed-layer" style={{ background: grade.wash.color, opacity: grade.wash.opacity, mixBlendMode: "soft-light" }} />}
      </div>
      {grade.vignette > 0 && (
        <div
          className="ed-layer pointer-events-none"
          style={{ background: `radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,${Math.min(0.9, grade.vignette * 0.9)}) 100%)` }}
        />
      )}

      {ui.reframe && <ReframeGrid />}
      <SafeArea w={w} h={h} view={ui.platformView} emphasize={dragging} />
      {ui.platformView !== "ALL" && <PlatformChrome platform={ui.platformView} k={k} />}

      <TextLayer w={w} h={h} k={k} onDragging={setDragging} />
      <CaptionLayer w={w} h={h} k={k} onDragging={setDragging} />

      {selectedZoom && (
        <div
          className="pointer-events-none absolute z-[5]"
          style={{ left: selectedZoom.x * w - 14, top: selectedZoom.y * h - 14, width: 28, height: 28 }}
          aria-hidden
        >
          <div className="h-full w-full rounded-full border-2 border-[var(--color-gold-400)] shadow-[0_0_0_2px_rgba(0,0,0,0.4)]" />
          <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-gold-400)]" />
        </div>
      )}
      {selectedZoom && (
        <p className="pointer-events-none absolute inset-x-0 bottom-3 z-[5] text-center text-[11px] text-white/80 [text-shadow:0_1px_3px_rgba(0,0,0,0.8)]">
          Click to set where the zoom aims
        </p>
      )}
    </div>
  );
}

function ReframeGrid() {
  return (
    <div className="ed-layer pointer-events-none z-[4]" aria-hidden>
      {[1, 2].map((i) => (
        <div key={`v${i}`} className="absolute top-0 bottom-0 w-px bg-white/30" style={{ left: `${(i * 100) / 3}%` }} />
      ))}
      {[1, 2].map((i) => (
        <div key={`h${i}`} className="absolute left-0 right-0 h-px bg-white/30" style={{ top: `${(i * 100) / 3}%` }} />
      ))}
      <div className="absolute inset-0 rounded-[14px] ring-2 ring-inset ring-[var(--color-gold-400)]" />
      <p className="absolute inset-x-0 top-3 text-center text-[11px] font-medium text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.9)]">
        Drag to reframe · scroll to zoom
      </p>
    </div>
  );
}

function SafeArea({ w, h, view, emphasize }: { w: number; h: number; view: PlatformView; emphasize: boolean }) {
  const ids: PlatformId[] = view === "ALL" ? PLATFORM_IDS : [view];
  const r = safeRect(ids, w, h);
  return (
    <div
      className="ed-safe z-[2]"
      style={{ left: r.x0, top: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0, opacity: emphasize ? 0.9 : view === "ALL" ? 0.22 : 0.55 }}
      aria-hidden
    />
  );
}

/** Stylized (unbranded) mock of each app's on-screen UI, drawn in canvas coordinates. */
function PlatformChrome({ platform, k }: { platform: PlatformId; k: number }) {
  const p = PLATFORM_PROFILES[platform];
  const W = p.canvas.width;
  const H = p.canvas.height;
  const s = (n: number) => n * k;
  const iconX = W - p.safeZone.right / 2;
  const icons = platform === "YOUTUBE" ? 5 : platform === "TIKTOK" ? 5 : 4;
  const iconSize = 78;
  const gap = 150;
  const firstY = H - p.safeZone.bottom - (icons - 1) * gap + 40;
  return (
    <div className="ed-chrome z-[3]" aria-hidden>
      <div className="ed-chrome-dim" style={{ left: 0, top: 0, right: 0, height: s(p.safeZone.top) }} />
      <div className="ed-chrome-dim" style={{ left: 0, bottom: 0, right: 0, height: s(p.safeZone.bottom) }} />
      {/* top bar */}
      {platform === "TIKTOK" && (
        <div className="absolute flex items-center justify-center" style={{ left: 0, right: 0, top: s(70), gap: s(36) }}>
          <div className="ed-chrome-bar opacity-60" style={{ width: s(150), height: s(26) }} />
          <div className="ed-chrome-bar" style={{ width: s(150), height: s(26) }} />
        </div>
      )}
      {platform === "INSTAGRAM" && (
        <>
          <div className="ed-chrome-bar absolute" style={{ left: s(48), top: s(110), width: s(150), height: s(36) }} />
          <div className="ed-chrome-icon absolute" style={{ right: s(48), top: s(104), width: s(48), height: s(48) }} />
        </>
      )}
      {platform === "YOUTUBE" && (
        <>
          <div className="ed-chrome-icon absolute" style={{ right: s(150), top: s(80), width: s(48), height: s(48) }} />
          <div className="ed-chrome-icon absolute" style={{ right: s(48), top: s(80), width: s(48), height: s(48) }} />
        </>
      )}
      {/* right action column */}
      {Array.from({ length: icons }, (_, i) => (
        <div
          key={i}
          className="ed-chrome-icon absolute"
          style={{ left: s(iconX - iconSize / 2), top: s(firstY + i * gap), width: s(iconSize), height: s(iconSize), opacity: 0.8 }}
        />
      ))}
      {/* bottom: username + caption lines */}
      <div className="absolute" style={{ left: s(48), bottom: s(p.safeZone.bottom - 210) }}>
        <div className="flex items-center" style={{ gap: s(16) }}>
          <div className="ed-chrome-icon" style={{ width: s(56), height: s(56) }} />
          <div className="ed-chrome-bar" style={{ width: s(220), height: s(28) }} />
        </div>
        <div className="ed-chrome-bar mt-[1px] opacity-70" style={{ width: s(640), height: s(22), marginTop: s(24) }} />
        <div className="ed-chrome-bar opacity-70" style={{ width: s(460), height: s(22), marginTop: s(16) }} />
      </div>
      <div className="absolute rounded-full bg-white/50" style={{ left: s(48), right: s(48), bottom: s(platform === "YOUTUBE" ? 150 : 40), height: s(6) }} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Text layer — direct manipulation
// ---------------------------------------------------------------------------------------

function TextLayer({ w, h, k, onDragging }: { w: number; h: number; k: number; onDragging: (v: boolean) => void }) {
  const { doc, engine, state } = useEditor();
  const visibleKey = usePlayheadValue(engine, (t) =>
    doc.texts
      .filter((x) => t >= x.start && t < x.end)
      .map((x) => x.id)
      .join(","),
  );
  const visible = new Set(visibleKey ? visibleKey.split(",") : []);
  const selectedId = state.selection?.kind === "text" ? state.selection.id : null;
  const [guides, setGuides] = useState({ v: false, h: false });
  return (
    <div className="ed-layer z-[6]" style={{ pointerEvents: "none" }}>
      {doc.texts
        .filter((t) => visible.has(t.id))
        .map((t) => (
          <TextItem key={t.id} t={t} w={w} h={h} k={k} selected={t.id === selectedId} onGuides={setGuides} onDragging={onDragging} />
        ))}
      {guides.v && <div className="ed-guide-v" />}
      {guides.h && <div className="ed-guide-h" />}
    </div>
  );
}

function TextItem({
  t,
  w,
  h,
  k,
  selected,
  onGuides,
  onDragging,
}: {
  t: TimelineText;
  w: number;
  h: number;
  k: number;
  selected: boolean;
  onGuides: (g: { v: boolean; h: boolean }) => void;
  onDragging: (v: boolean) => void;
}) {
  const { apply, commit, dispatch, engine, setUi } = useEditor();
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [editing]);

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (editing || e.button !== 0) return;
    e.stopPropagation();
    engine.pause();
    dispatch({ type: "select", selection: { kind: "text", id: t.id } });
    setUi({ tab: "selection" });
    const start = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y };
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      if (!moved) onDragging(true);
      moved = true;
      let nx = start.tx + dx / w;
      let ny = start.ty + dy / h;
      const snapV = Math.abs(nx * w - w / 2) < SNAP_PX;
      const snapH = Math.abs(ny * h - h / 2) < SNAP_PX;
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

  const onResizeDown = (e: RPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
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

  const finishEditing = () => {
    const text = (ref.current?.innerText ?? "").replace(/\n+$/, "").slice(0, 500);
    setEditing(false);
    if (text.trim() && text !== t.text) apply((d) => updateText(d, t.id, { text }));
    else if (ref.current) ref.current.innerText = t.text;
  };

  return (
    <div
      ref={ref}
      className={`ed-text ${selected ? "ed-text-sel" : "ed-text-hover"}`}
      style={{
        ...textCss(t, k),
        left: t.x * w,
        top: t.y * h,
        maxWidth: t.maxWidth * w,
        pointerEvents: "auto",
        cursor: editing ? "text" : undefined,
        userSelect: editing ? "text" : "none",
        WebkitUserSelect: editing ? "text" : "none",
      }}
      contentEditable={editing}
      suppressContentEditableWarning
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      onBlur={() => editing && finishEditing()}
      onKeyDown={(e) => {
        if (!editing) return;
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          (e.currentTarget as HTMLDivElement).blur();
        }
      }}
      role="textbox"
      aria-label={`Text: ${t.text}`}
      title={selected && !editing ? "Drag to move · double-click to edit" : undefined}
    >
      {t.text}
      {selected && !editing && (
        <div
          className="ed-handle"
          style={{ right: -12, bottom: -12, cursor: "nwse-resize" }}
          onPointerDown={onResizeDown}
          contentEditable={false}
          aria-label="Resize text"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------------------

function CaptionLayer({ w, h, k, onDragging }: { w: number; h: number; k: number; onDragging: (v: boolean) => void }) {
  const { doc, chunks, engine, state, dispatch, apply, commit, setUi } = useEditor();
  const c = doc.captions;
  const key = usePlayheadValue(engine, (t) => {
    if (!c.enabled) return "";
    const ci = chunks.findIndex((ch) => t >= ch.start && t < ch.end);
    if (ci < 0) return "";
    const ch = chunks[ci]!;
    let wi = -1;
    for (let i = 0; i < ch.words.length; i++) if (t >= ch.words[i]!.start) wi = i;
    return `${ci}:${wi}`;
  });
  const selected = state.selection?.kind === "captions";
  if (!c.enabled) return null;
  const [ciStr, wiStr] = key ? key.split(":") : ["-1", "-1"];
  const chunk = chunks[Number(ciStr)];
  const activeWord = Number(wiStr);
  const placeholder = !chunk && selected;
  if (!chunk && !placeholder) return null;

  const fs = c.fontSize * k;
  const plate = c.backgroundColor ?? (c.preset === "BOXED" ? "#000000B3" : null);
  const words = chunk ? chunk.words.map((x) => x.word) : ["Captions", "show", "here"];

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
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
      const y = Math.round(Math.min(0.95, Math.max(0.05, y0 + (ev.clientY - startY) / h)) * 1000) / 1000;
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

  return (
    <div className="ed-layer z-[5]" style={{ pointerEvents: "none" }}>
      <div
        className={`ed-text ${selected ? "ed-text-sel" : "ed-text-hover"}`}
        style={{
          left: w / 2,
          top: c.y * h,
          maxWidth: 0.84 * w,
          fontFamily: fontFamilyCss(c.fontId),
          fontSize: fs,
          color: c.color,
          textAlign: "center",
          textTransform: c.uppercase ? "uppercase" : "none",
          WebkitTextStroke: c.strokeColor ? `${strokePx(c.fontSize) * k * 2}px ${c.strokeColor}` : undefined,
          background: plate ? hexToRgba(plate) : undefined,
          padding: plate ? "0.2em 0.4em" : undefined,
          borderRadius: plate ? "0.2em" : undefined,
          pointerEvents: "auto",
          cursor: "ns-resize",
          opacity: placeholder ? 0.55 : 1,
        }}
        onPointerDown={onPointerDown}
        title="Drag up or down to move captions"
        aria-label="Captions"
      >
        {words.map((word, i) => {
          let color: string | undefined;
          if (!placeholder) {
            if ((c.preset === "BOLD_HIGHLIGHT" || c.preset === "BOXED") && i === activeWord) color = c.highlightColor;
            if (c.preset === "KARAOKE" && i <= activeWord) color = c.highlightColor;
          }
          return (
            <span key={i} style={{ color, transition: c.preset === "KARAOKE" ? "color 80ms linear" : undefined }}>
              {word}
              {i < words.length - 1 ? " " : ""}
            </span>
          );
        })}
      </div>
    </div>
  );
}
