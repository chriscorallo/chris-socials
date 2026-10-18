"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from "react";
import { timelineDuration } from "@chris/media/timeline";
import {
  CONTROLS_AUTO_HIDE_MS,
  fullscreenLayout,
  loadFullscreenPrefs,
  saveFullscreenPrefs,
  swipeCloses,
  type FullscreenPlatform,
  type FullscreenPrefs,
} from "../../../../lib/editor/fullscreen";
import { PLATFORM_SHORT_LABEL, PLATFORM_IDS } from "../../../../lib/editor/platform-profiles";
import { PLATFORM_UI } from "@chris/media/timeline";
import { formatTime } from "../../../../lib/editor/preview-math";
import { useEditor } from "./context";
import { useIsPlaying, usePlayheadValue } from "./playback";
import { Canvas } from "./Preview";
import { Icon } from "./icons";

/**
 * The preview stage, normal or FULL SCREEN, without ever remounting the canvas: the same <Canvas>
 * (same pool <video> elements, same playback engine — playback continues seamlessly) sits in the
 * same place in the tree; full screen only turns its box into a fixed, edge-to-edge overlay and
 * resizes the canvas. (iOS Safari can't put an arbitrary element in real full screen, so this is
 * an in-app overlay; where the Fullscreen API exists — desktop, Android — the page also enters it.)
 */
export function StageCanvas({ className, padX, padY, children }: { className: string; padX: number; padY: number; children?: ReactNode }) {
  const { doc, ui } = useEditor();
  const boxRef = useRef<HTMLDivElement>(null);
  const box = useBoxSize(boxRef);
  const fs = ui.fullscreen;
  // Remembered choice (localStorage, guarded; defaults on the server). Only the full-screen view
  // reads it, and that is never open on the first render, so hydration can't mismatch.
  const [prefs, setPrefs] = useState<FullscreenPrefs>(() => loadFullscreenPrefs());
  const safeBottom = useSafeAreaBottom(fs);
  const aspect = doc.canvas.width / doc.canvas.height;
  const platform = prefs.platform === "NONE" ? null : prefs.platform;

  let canvas = { w: 0, h: 0 };
  let frame: { x: number; y: number } | null = null;
  let clip: { x: number; y: number; w: number; h: number } | null = null;
  let nav: { y: number; h: number } | null = null;
  if (fs && box.w > 0) {
    const L = fullscreenLayout(box, platform, safeBottom, aspect);
    canvas = L.canvas;
    clip = L.clip;
    frame = { x: L.x - L.clip.x, y: L.y - L.clip.y };
    nav = L.nav;
  } else if (box.w > 0) {
    const availW = box.w - padX;
    const availH = box.h - padY;
    let h = availH;
    let w = h * aspect;
    if (w > availW) {
      w = availW;
      h = w / aspect;
    }
    canvas = { w: Math.max(0, Math.floor(w)), h: Math.max(0, Math.floor(h)) };
  }

  const update = useCallback((p: Partial<FullscreenPrefs>) => {
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      saveFullscreenPrefs(next);
      return next;
    });
  }, []);

  return (
    <div ref={boxRef} className={fs ? "ed-fs" : className} role={fs ? "dialog" : undefined} aria-modal={fs || undefined} aria-label={fs ? "Full screen preview" : undefined}>
      <div className="ed-fs-clip" style={clip ? { position: "absolute", left: clip.x, top: clip.y, width: clip.w, height: clip.h, overflow: "hidden" } : { position: "relative" }}>
        <div style={frame ? { position: "absolute", left: frame.x, top: frame.y } : { position: "relative" }}>
          {canvas.w > 0 && <Canvas w={canvas.w} h={canvas.h} view={fs} viewPlatform={fs ? platform : null} />}
        </div>
      </div>
      {fs && nav && platform && <AppNavBar y={nav.y} h={nav.h} labels={PLATFORM_UI[platform].nav} />}
      {fs ? <FullscreenControls prefs={prefs} onPrefs={update} navH={platform && nav ? box.h - nav.y : null} /> : children}
    </div>
  );
}

/** Size of an element, following resizes. */
function useBoxSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      setSize((s) => (s.w === next.w && s.h === next.h ? s : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** env(safe-area-inset-bottom) in px (the home indicator), measured while full screen. */
function useSafeAreaBottom(active: boolean): number {
  const [v, setV] = useState(0);
  useLayoutEffect(() => {
    if (!active) return;
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:0;bottom:0;width:0;visibility:hidden;padding-bottom:env(safe-area-inset-bottom)";
    document.body.appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
    probe.remove();
    setV(px);
  }, [active]);
  return v;
}

/** The app's opaque bottom nav bar (below the video, never over it). */
function AppNavBar({ y, h, labels }: { y: number; h: number; labels: string[] }) {
  return (
    <div className="ed-fs-nav" style={{ top: y, height: h }} aria-hidden>
      {labels.map((l) => (
        <span key={l} className={l === "+" ? "ed-fs-nav-plus" : "ed-fs-nav-item"}>
          {l === "+" ? <Icon name="plus" size={18} /> : <i />}
        </span>
      ))}
    </div>
  );
}

/** Enter full screen from a tap (also asks the browser for real full screen where it can). */
export function useEnterFullscreen() {
  const { setUi, dispatch } = useEditor();
  return useCallback(() => {
    dispatch({ type: "select", selection: null });
    setUi({ fullscreen: true, reframe: false, sheet: null, editingTextId: null });
    const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    try {
      // Not on iPhone (no element full screen there) — the in-app overlay is the full screen.
      if (root.requestFullscreen && document.fullscreenEnabled) void root.requestFullscreen({ navigationUI: "hide" }).catch(() => undefined);
    } catch {
      /* the overlay alone is fine */
    }
  }, [setUi, dispatch]);
}

export function FullscreenButton({ className = "" }: { className?: string }) {
  const enter = useEnterFullscreen();
  return (
    <button type="button" className={`ed-fs-enter ${className}`} onClick={enter} aria-label="Full screen" title="Watch full screen">
      <Icon name="expand" size={18} />
    </button>
  );
}

const PLATFORM_CHOICES: Array<[FullscreenPlatform, string]> = [["NONE", "Off"], ...PLATFORM_IDS.map((p) => [p, PLATFORM_SHORT_LABEL[p]] as [FullscreenPlatform, string])];

/**
 * Full-screen controls: tap = play/pause (and shows the controls), swipe down = close, a scrub
 * bar + time that auto-hide while playing, mute, close, and "App UI: Off / TikTok / Reels /
 * Shorts" (remembered).
 */
function FullscreenControls({ prefs, onPrefs, navH }: { prefs: FullscreenPrefs; onPrefs: (p: Partial<FullscreenPrefs>) => void; navH: number | null }) {
  const { engine, doc, setUi } = useEditor();
  const playing = useIsPlaying(engine);
  const D = timelineDuration(doc);
  const t = usePlayheadValue(engine, (x) => Math.round(x * 20) / 20);
  const [shown, setShown] = useState(true);
  const hideTimer = useRef(0);
  const down = useRef<{ x: number; y: number; t: number; id: number } | null>(null);
  const [drag, setDrag] = useState(0);
  const scrubbing = useRef<{ wasPlaying: boolean } | null>(null);

  const close = useCallback(() => {
    setUi({ fullscreen: false });
  }, [setUi]);

  // Leave the browser's full screen with us (and close us when the browser leaves it, e.g. Esc).
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setUi({ fullscreen: false });
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [setUi]);

  // Sound: the preview's mute (the edit's clip volumes are untouched).
  useEffect(() => {
    engine.setMuted(prefs.muted);
    return () => engine.setMuted(false);
  }, [engine, prefs.muted]);

  // Controls auto-hide while playing; always visible when paused.
  const poke = useCallback(() => {
    setShown(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (engine.playing && !scrubbing.current) setShown(false);
    }, CONTROLS_AUTO_HIDE_MS);
  }, [engine]);
  useEffect(() => {
    poke();
    return () => window.clearTimeout(hideTimer.current);
  }, [playing, poke]);

  const onDown = (e: RPointerEvent) => {
    if (e.target !== e.currentTarget) return;
    down.current = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic */
    }
  };
  const onMove = (e: RPointerEvent) => {
    const d = down.current;
    if (!d || d.id !== e.pointerId) return;
    setDrag(Math.max(0, e.clientY - d.y));
  };
  const onUp = (e: RPointerEvent) => {
    const d = down.current;
    down.current = null;
    setDrag(0);
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (swipeCloses(dy, performance.now() - d.t, dx)) {
      close();
      return;
    }
    if (Math.hypot(dx, dy) < 12) {
      // play() runs inside this tap — iOS only allows sound from a user gesture
      engine.toggle();
      poke();
    }
  };

  const visible = shown || !playing;
  return (
    <div
      className="ed-fs-touch"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => {
        down.current = null;
        setDrag(0);
      }}
      style={drag ? { transform: `translateY(${drag * 0.5}px)`, opacity: Math.max(0.4, 1 - drag / 400) } : undefined}
    >
      {!playing && (
        <span className="ed-fs-bigplay" aria-hidden>
          <Icon name="play" size={34} />
        </span>
      )}
      <div className={`ed-fs-top ${visible ? "" : "ed-fs-hidden"}`}>
        <button type="button" className="ed-fs-btn" onClick={close} aria-label="Close full screen">
          <Icon name="close" size={22} />
        </button>
        <div className="ed-fs-seg" role="group" aria-label="Show an app's buttons over the video">
          <span className="ed-fs-seg-label">App UI</span>
          {PLATFORM_CHOICES.map(([p, label]) => (
            <button key={p} type="button" aria-pressed={prefs.platform === p} onClick={() => onPrefs({ platform: p })}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="ed-fs-btn" onClick={() => onPrefs({ muted: !prefs.muted })} aria-label={prefs.muted ? "Unmute" : "Mute"} aria-pressed={prefs.muted}>
          <Icon name={prefs.muted ? "mute" : "volume"} size={21} />
        </button>
      </div>
      <div className={`ed-fs-bottom ${visible ? "" : "ed-fs-hidden"} ${navH !== null ? "ed-fs-bottom-app" : ""}`} style={navH !== null ? { bottom: navH } : undefined}>
        <span className="ed-fs-time">{formatTime(t)}</span>
        <input
          type="range"
          className="ed-fs-scrub"
          min={0}
          max={Math.max(0.01, D)}
          step={0.01}
          value={Math.min(t, D)}
          aria-label="Scrub"
          onPointerDown={() => {
            scrubbing.current = { wasPlaying: engine.playing };
            if (engine.playing) engine.pause();
            poke();
          }}
          onChange={(e) => engine.seek(Number(e.target.value))}
          onPointerUp={() => {
            const s = scrubbing.current;
            scrubbing.current = null;
            if (s?.wasPlaying) engine.play();
            poke();
          }}
          style={{ ["--p" as string]: `${(Math.min(t, D) / Math.max(0.01, D)) * 100}%` }}
        />
        <span className="ed-fs-time">{formatTime(D)}</span>
      </div>
    </div>
  );
}
