"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { locateOutputTime, resolveGrade, timelineDuration } from "@chris/media/timeline";
import { updateClip, updateZoom, setCover } from "../../../../lib/editor/timeline-ops";
import { panAfterDrag, formatTime, vignetteGradient } from "../../../../lib/editor/preview-math";
import { PLATFORM_PROFILES, PLATFORM_IDS, PLATFORM_SHORT_LABEL, type PlatformId } from "../../../../lib/editor/platform-profiles";
import { safeRect } from "../../../../lib/editor/platform-warnings";
import { useEditor, type PlatformView } from "./context";
import { assignPlayers, useIsPlaying, usePlayheadValue } from "./playback";
import { GradeDefs, OverlaySvg } from "./Overlays";
import { Icon } from "./icons";

export { fontFamilyCss } from "./Overlays";

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
  const opts: Array<[PlatformView, string]> = [["ALL", "All"], ...PLATFORM_IDS.map((p) => [p, PLATFORM_SHORT_LABEL[p]] as [PlatformView, string])];
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
                        {w.platforms.map((p) => PLATFORM_SHORT_LABEL[p]).join(" · ")}
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
  const g = resolveGrade(doc.grade);
  const gradeOn = g.brightness !== 0 || g.contrast !== 1 || g.saturation !== 1 || g.temperature !== 0;
  const vignette = vignetteGradient(g.vignette);
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
        const W = doc.canvas.width;
        const pan = panAfterDrag(
          start.crop,
          { width: asset?.width ?? 1080, height: asset?.height ?? 1920 },
          doc.canvas,
          ((ev.clientX - start.x) * W) / w,
          ((ev.clientY - start.y) * W) / w,
        );
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
      <GradeDefs grade={doc.grade} />
      {/* video layer: clip crop → punch-in zoom (engine) → grade (exact SVG filter) */}
      <div className="ed-layer" style={{ filter: gradeOn ? "url(#ed-grade)" : undefined }}>
      <div className="ed-layer" ref={zoomLayerRef} style={{ willChange: "transform" }}>
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
      </div>
      </div>
      {vignette && <div className="ed-layer pointer-events-none" style={{ background: vignette }} />}

      {ui.reframe && <ReframeGrid />}
      <SafeArea w={w} h={h} view={ui.platformView} emphasize={dragging} />
      {ui.platformView !== "ALL" && <PlatformChrome platform={ui.platformView} k={k} />}

      <OverlaySvg w={w} h={h} onDragging={setDragging} />

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
