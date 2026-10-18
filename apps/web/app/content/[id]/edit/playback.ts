"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  clipDuration,
  clipStartTimes,
  locateOutputTime,
  timelineDuration,
  cropGeometry,
  normalizeZooms,
  zoomStateAt,
  type TimelineZoom,
} from "@chris/media/timeline";
import type { EditorAsset, EditorDoc } from "../../../../lib/editor/types";
import { assignPlayers, isContinuation, shouldStartStandby, standbyRate, standbyReady, standbySeekTarget, WARM_LEAD_S } from "../../../../lib/editor/player-pool";

export { assignPlayers, PLAYER_POOL } from "../../../../lib/editor/player-pool";

/**
 * The preview's playback engine — one requestAnimationFrame clock for the whole editor.
 *
 * Every clip is played by one of a FIXED POOL OF TWO <video> elements (lib/editor/player-pool.ts):
 * a run of CONTINUATION clips (same take, adjacent source times — a framing-only cut) stays on
 * one element that just keeps playing while the crop changes at the boundary; every JUMP cut (a
 * removed pause, another take) switches to the other element. That element waits a little before
 * the next clip's first frame and is started — muted, invisible — shortly before the boundary,
 * its playbackRate nudged so it lands on the first frame exactly when the current clip ends
 * ("warm standby"); the cut is then a visibility + audio swap between two elements that are
 * already playing (no seek, no play() start latency on screen). If it isn't ready in time
 * (playback started right before a cut, slow network) the cut falls back to a seek.
 * Two elements regardless of how many takes or clips: iOS Safari limits concurrent hardware
 * decoders and only lets an element play with sound once play() was called on it inside a user
 * gesture, so the pool stays tiny and both elements are unlocked from the play tap (see
 * unlockFromGesture). While playing, the ACTIVE video is the master clock (no audio/video
 * drift); when it's stalled or not ready, a wall clock carries time forward.
 *
 * The engine writes per-frame visuals (which element is visible, the crop and punch-in
 * transforms) straight to the DOM and notifies subscribers with the time — React only
 * re-renders for structural changes, never per frame.
 */

type Listener = () => void;

export class PlaybackEngine {
  time = 0;
  playing = false;
  /** Mutes the preview's sound (full-screen mute button); the edit itself is untouched. */
  muted = false;
  /**
   * Warm standby on (default). `?warm=0` on the editor URL turns it off — a kill switch / A-B
   * check for real devices (cuts then wait on the standby's first frame and start with play()).
   */
  private warmEnabled = typeof window === "undefined" || new URLSearchParams(window.location.search).get("warm") !== "0";
  private doc: EditorDoc;
  private assets: Map<string, EditorAsset>;
  private clipPlayer: string[] = [];
  private starts: number[] = [];
  private duration = 0;
  /** Zooms exactly as the renderer sees them (normalizeZooms: clamped, overlaps dropped). */
  private zooms: TimelineZoom[] = [];
  private players = new Map<string, HTMLVideoElement>();
  private wired = new WeakSet<HTMLVideoElement>();
  private zoomLayer: HTMLElement | null = null;
  private viewport = { w: 0, h: 0 };
  private listeners = new Set<Listener>();
  private raf = 0;
  private lastTs = 0;
  private activeKey: string | null = null;
  private activeIndex = -1;
  /** While set, the visible frame shows this clip at this source time (trim preview). */
  private previewOverride: { clipIndex: number; sourceTime: number } | null = null;
  /** Seek to apply once an element that just got a new `src` has its metadata. */
  private pendingSeek = new Map<HTMLVideoElement, number>();

  constructor(doc: EditorDoc, assets: Map<string, EditorAsset>) {
    this.doc = doc;
    this.assets = assets;
    this.recompute();
  }

  // --- wiring -------------------------------------------------------------------------

  setDoc(doc: EditorDoc, assets?: Map<string, EditorAsset>) {
    this.doc = doc;
    if (assets) this.assets = assets;
    this.recompute();
    if (this.time > this.duration) this.time = this.duration;
    if (!this.playing) this.syncPaused();
    this.applyVisuals();
  }

  /** Stable ref callback per player key (so React doesn't detach/re-attach every render). */
  playerRef(key: string): (el: HTMLVideoElement | null) => void {
    let cb = this.refCallbacks.get(key);
    if (!cb) {
      cb = (el) => this.registerPlayer(key, el);
      this.refCallbacks.set(key, cb);
    }
    return cb;
  }
  private refCallbacks = new Map<string, (el: HTMLVideoElement | null) => void>();

  registerPlayer(key: string, el: HTMLVideoElement | null) {
    if (el) {
      this.players.set(key, el);
      if (this.wired.has(el)) return;
      this.wired.add(el);
      el.playsInline = true;
      el.preload = "auto";
      el.addEventListener("loadedmetadata", () => {
        const t = this.pendingSeek.get(el);
        if (t !== undefined) {
          this.pendingSeek.delete(el);
          el.currentTime = t;
        }
        this.applyVisuals();
      });
      const onReady = () => {
        if (!this.playing) this.syncPaused();
        this.applyVisuals();
      };
      this.watchFrames(el, key);
      el.addEventListener("loadeddata", onReady);
      el.addEventListener("seeked", () => {
        // Scrubbing: seeks that arrived while this one was in flight were coalesced — apply
        // only the latest (a new currentTime aborts the running seek, so setting it on every
        // scroll event would show no frame at all until the finger stops).
        const t = this.pendingSeek.get(el);
        if (t !== undefined && el.readyState >= 1) {
          this.pendingSeek.delete(el);
          if (Math.abs(el.currentTime - t) > 0.001) {
            el.currentTime = t;
            return;
          }
        }
        onReady();
      });
      if (!this.playing) this.syncPaused();
    } else {
      const old = this.players.get(key);
      old?.pause();
      this.players.delete(key);
    }
  }

  /**
   * Frame-accurate cuts where the browser supports requestVideoFrameCallback (Chrome, Safari ≥
   * 15.4): the callback runs right before the frame it reports is composited, so if the ACTIVE
   * element is about to show the first frame past its clip's out point before the rAF tick's
   * clock check (below) has cut, the cut happens in that same frame — the removed footage never
   * reaches the screen and a crop change lands on the boundary frame.
   */
  private watchFrames(el: HTMLVideoElement, key: string) {
    const v = el as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
    };
    if (typeof v.requestVideoFrameCallback !== "function") return;
    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      v.requestVideoFrameCallback!(onFrame);
      if (!this.playing || this.previewOverride || key !== this.activeKey) return;
      const i = this.activeIndex;
      const clip = this.doc.clips[i];
      if (!clip || el.dataset.assetId !== clip.mediaAssetId) return;
      if (meta.mediaTime >= clip.sourceEnd - 0.25 / 30 && meta.mediaTime < clip.sourceEnd + 0.5) this.crossBoundary(i);
    };
    v.requestVideoFrameCallback(onFrame);
  }

  /** The active clip `i` just ended: finish, or hand over to clip i + 1. */
  private crossBoundary(i: number) {
    const clip = this.doc.clips[i];
    if (!clip || i !== this.activeIndex) return;
    const clipEnd = this.starts[i]! + clipDuration(clip);
    if (i + 1 >= this.doc.clips.length) {
      this.time = this.duration;
      this.pause();
      this.emit();
      return;
    }
    this.time = clipEnd;
    this.startActive(false);
    this.emit();
  }

  setZoomLayer(el: HTMLElement | null) {
    this.zoomLayer = el;
    this.applyVisuals();
  }

  setViewport(w: number, h: number) {
    this.viewport = { w, h };
    this.applyVisuals();
  }

  private gestureHooks = new Set<Listener>();
  /**
   * Runs synchronously inside play() — i.e. inside the user's play tap — so side players (the
   * music bed, sound effects) can start/unlock their own audio there (iOS only allows sound
   * from a gesture).
   */
  onPlayGesture(fn: Listener): () => void {
    this.gestureHooks.add(fn);
    return () => {
      this.gestureHooks.delete(fn);
    };
  }

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getTime = () => this.time;
  getPlaying = () => this.playing;

  get totalDuration() {
    return this.duration;
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  private recompute() {
    const { clipPlayer } = assignPlayers(this.doc.clips);
    this.clipPlayer = clipPlayer;
    this.starts = clipStartTimes(this.doc);
    this.duration = timelineDuration(this.doc);
    this.zooms = normalizeZooms(this.doc.zooms, this.duration).zooms;
  }

  // --- transport ----------------------------------------------------------------------

  /** Call from the play tap/click itself (iOS needs the user gesture for sound). */
  play() {
    if (this.playing) return;
    if (this.time >= this.duration - 0.02) this.time = 0;
    this.previewOverride = null;
    this.playing = true;
    this.lastTs = performance.now();
    this.startActive(true);
    this.unlockFromGesture();
    for (const h of this.gestureHooks) {
      try {
        h();
      } catch {
        /* a side player failing must never stop the picture */
      }
    }
    this.raf = requestAnimationFrame(this.tick);
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const p of this.players.values()) {
      p.pause();
      this.coolDown(p);
    }
    this.syncPaused();
    this.emit();
  }

  setMuted(m: boolean) {
    this.muted = m;
    const el = this.activeKey ? this.players.get(this.activeKey) : undefined;
    const clip = this.doc.clips[this.activeIndex];
    if (el && clip && !el.dataset.warm) el.muted = clip.volume === 0 || m;
    this.emit();
  }

  getMuted = () => this.muted;

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    this.previewOverride = null;
    this.time = Math.max(0, Math.min(this.duration, t));
    if (this.playing) this.startActive(true);
    else this.syncPaused();
    this.applyVisuals();
    this.emit();
  }

  /** Show a specific source frame of a clip without moving the playhead (trim preview). */
  previewSourceFrame(clipIndex: number, sourceTime: number | null) {
    if (sourceTime === null) {
      this.previewOverride = null;
      this.syncPaused();
    } else {
      if (this.playing) this.pause();
      this.previewOverride = { clipIndex, sourceTime };
      const key = this.clipPlayer[clipIndex];
      const el = key ? this.players.get(key) : undefined;
      if (el) this.bind(el, clipIndex, sourceTime, 0.01);
      this.activeKey = key ?? null;
      this.activeIndex = clipIndex;
    }
    this.applyVisuals();
  }

  /** JPEG data URL of the frame on screen (crop applied, no grade), or null if unreadable. */
  snapshot(width = 120): string | null {
    const key = this.activeKey ?? this.clipPlayer[this.clipAt(this.time).clipIndex];
    const el = key ? this.players.get(key) : undefined;
    const clip = this.doc.clips[this.activeIndex >= 0 ? this.activeIndex : 0];
    if (!el || !clip || el.readyState < 2 || !el.videoWidth) return null;
    try {
      const h = Math.round((width * this.doc.canvas.height) / this.doc.canvas.width);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const g = cropGeometry({ width: el.videoWidth, height: el.videoHeight }, { width, height: h }, clip.crop);
      ctx.drawImage(el, -g.offsetX, -g.offsetY, g.scaledWidth, g.scaledHeight);
      return canvas.toDataURL("image/jpeg", 0.75);
    } catch {
      return null; // cross-origin storage without CORS taints the canvas
    }
  }

  /**
   * The element showing the picture right now, its clip and the zoom — for layers that redraw
   * the footage themselves (the person cutout of behind-subject graphics, PersonCutout.tsx).
   */
  activeFrame(): { el: HTMLVideoElement; clipIndex: number; zoom: { zoom: number; x: number; y: number } } | null {
    const clipIndex = this.previewOverride ? this.previewOverride.clipIndex : this.activeIndex >= 0 ? this.activeIndex : this.clipAt(this.time).clipIndex;
    const key = this.clipPlayer[clipIndex];
    const el = key ? this.players.get(key) : undefined;
    const clip = this.doc.clips[clipIndex];
    if (!el || !clip || el.dataset.assetId !== clip.mediaAssetId) return null;
    const zoom = this.previewOverride ? { zoom: 1, x: 0.5, y: 0.5 } : zoomStateAt(this.zooms, this.time);
    return { el, clipIndex, zoom };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    for (const p of this.players.values()) p.pause();
    this.listeners.clear();
  }

  // --- internals ----------------------------------------------------------------------

  private clipAt(t: number) {
    const loc = locateOutputTime(this.doc, t);
    return loc ?? { clipIndex: 0, sourceTime: this.doc.clips[0]?.sourceStart ?? 0 };
  }

  /** Paused: the active element shows the exact frame; the other waits on the next clip's first frame. */
  private syncPaused() {
    if (this.previewOverride) return;
    const { clipIndex, sourceTime } = this.clipAt(this.time);
    this.activeIndex = clipIndex;
    this.activeKey = this.clipPlayer[clipIndex] ?? null;
    const el = this.activeKey ? this.players.get(this.activeKey) : undefined;
    if (el) this.bind(el, clipIndex, sourceTime, 0.015);
    this.prerollNext(clipIndex);
  }

  /**
   * Points a pool element at clip `clipIndex`'s take and source time. Switching takes sets a
   * new `src`; the seek is applied once its metadata arrives.
   */
  private bind(el: HTMLVideoElement, clipIndex: number, sourceTime: number, tolerance: number) {
    const clip = this.doc.clips[clipIndex];
    const asset = clip ? this.assets.get(clip.mediaAssetId) : undefined;
    if (!clip || !asset) return;
    // A new take — or the same take's preview proxy arriving (swapped only while paused, so
    // playback never stalls on a source change).
    if (el.dataset.assetId !== asset.id || (el.dataset.url !== asset.url && !this.playing)) {
      if (!el.paused) el.pause();
      el.dataset.assetId = asset.id;
      el.dataset.url = asset.url;
      this.pendingSeek.set(el, sourceTime);
      el.src = asset.url;
      return;
    }
    if (el.readyState >= 1) {
      if (Math.abs(el.currentTime - sourceTime) <= tolerance) {
        this.pendingSeek.delete(el);
      } else if (el.seeking) {
        this.pendingSeek.set(el, sourceTime); // applied on 'seeked' (latest wins)
      } else {
        el.currentTime = sourceTime;
      }
    } else {
      this.pendingSeek.set(el, sourceTime);
    }
  }

  /** A standby that was started early goes back to a normal, paused-capable element. */
  private coolDown(el: HTMLVideoElement) {
    if (el.playbackRate !== 1) el.playbackRate = 1;
    delete el.dataset.warm;
  }

  /**
   * iOS only lets an element play with sound if play() was first called on it inside a user
   * gesture. play() runs from the play tap, so start (muted) and immediately pause the OTHER
   * pool element in that same gesture — the cut to the next clip can then start it with sound.
   */
  private unlockFromGesture() {
    for (const [key, el] of this.players) {
      if (key === this.activeKey || !el.getAttribute("src") || el.dataset.unlocked) continue;
      const wasMuted = el.muted;
      el.muted = true;
      el.dataset.unlocked = "1";
      let p: Promise<void> | undefined;
      try {
        p = el.play();
      } catch {
        p = undefined;
      }
      void p
        ?.then(() => {
          // A warm standby started in the meantime must stay muted until its cut.
          if (el.dataset.warm) return;
          el.muted = wasMuted;
          if (this.activeKey !== key || !this.playing) {
            el.pause();
            if (!this.playing) this.syncPaused();
            else this.prerollNext(this.activeIndex);
          }
        })
        .catch(() => {
          el.muted = wasMuted;
          delete el.dataset.unlocked;
        });
    }
  }

  /**
   * Readies the element that plays after the current clip. A continuation needs nothing (same
   * element, it keeps playing). For a jump, the other element waits WARM_LEAD_S before the next
   * clip's first frame (the tick starts it so it arrives on time) — or ON the first frame when
   * the cut is too close for a warm start (then the cut is a plain visibility swap + play()).
   */
  private prerollNext(fromIndex: number) {
    const i = fromIndex + 1;
    const key = this.clipPlayer[i];
    const c = this.doc.clips[i];
    if (!key || !c || key === this.clipPlayer[fromIndex]) return;
    const el = this.players.get(key);
    if (!el) return;
    if (!el.paused) el.pause();
    this.coolDown(el);
    const cur = this.doc.clips[fromIndex];
    const remaining = cur ? this.starts[fromIndex]! + clipDuration(cur) - this.time : 0;
    const warm = this.warmEnabled && this.playing && remaining > WARM_LEAD_S + 0.35;
    this.bind(el, i, warm ? standbySeekTarget(c) : c.sourceStart, 0.04);
  }

  /**
   * Called every tick while playing: starts the waiting standby (muted, invisible) so it
   * reaches the next clip's first frame when the current clip ends, and keeps it on time by
   * nudging its playbackRate.
   */
  private driveStandby(index: number, remaining: number) {
    const next = this.doc.clips[index + 1];
    const key = this.clipPlayer[index + 1];
    if (!next || !key || key === this.activeKey) return;
    const el = this.players.get(key);
    if (!el || el.dataset.assetId !== next.mediaAssetId || el.seeking || el.readyState < 2) return;
    if (el.paused) {
      if (el.dataset.warm || el.currentTime > next.sourceStart - 0.02) return; // cold: waits on its first frame
      if (!shouldStartStandby(remaining, el.currentTime, next.sourceStart)) return;
      el.muted = true;
      el.dataset.warm = "1";
      try {
        void el.play().catch(() => this.coolDown(el));
      } catch {
        this.coolDown(el);
      }
    } else if (el.dataset.warm) {
      // (Steering by presented frames instead of currentTime was measured and was no better.)
      const r = standbyRate(el.currentTime, next.sourceStart, remaining);
      if (Math.abs(el.playbackRate - r) > 0.004) el.playbackRate = r;
    }
  }

  private startActive(seekExact: boolean) {
    const { clipIndex, sourceTime } = this.clipAt(this.time);
    const key = this.clipPlayer[clipIndex] ?? null;
    const prevIndex = this.activeIndex;
    for (const [k, p] of this.players)
      if (k !== key) {
        if (!p.paused) p.pause();
        this.coolDown(p);
      }
    this.activeIndex = clipIndex;
    this.activeKey = key;
    const el = key ? this.players.get(key) : undefined;
    if (el) {
      const clip = this.doc.clips[clipIndex]!;
      const continuing = !seekExact && prevIndex === clipIndex - 1 && isContinuation(this.doc.clips[prevIndex], clip) && !el.paused;
      const warmOnTime = !seekExact && !!el.dataset.warm && !el.paused && el.dataset.assetId === clip.mediaAssetId && standbyReady(el.currentTime, sourceTime);
      // A continuation / an on-time warm standby is already exactly there — never seek it.
      if (!continuing && !warmOnTime) this.bind(el, clipIndex, sourceTime, seekExact ? 0.05 : 1.5 / 30);
      this.coolDown(el);
      // iOS ignores `volume` (always 1) — mute still works; the render applies the real level.
      el.volume = Math.min(1, Math.max(0, this.doc.clips[clipIndex]!.volume));
      el.muted = this.doc.clips[clipIndex]!.volume === 0 || this.muted;
      try {
        void el.play().catch(() => {
          /* autoplay policies / not yet loaded — wall clock carries on */
        });
      } catch {
        /* very old engines return undefined / throw synchronously */
      }
    }
    this.prerollNext(clipIndex);
    this.applyVisuals();
  }

  private tick = (ts: number) => {
    if (!this.playing) return;
    const dt = Math.min(0.1, (ts - this.lastTs) / 1000);
    this.lastTs = ts;
    const i = this.activeIndex;
    const clip = this.doc.clips[i];
    const el = this.activeKey ? this.players.get(this.activeKey) : undefined;
    if (!clip) {
      this.pause();
      return;
    }
    const clipStart = this.starts[i]!;
    const clipEnd = clipStart + clipDuration(clip);
    let t = this.time + dt;
    this.driveStandby(i, clipEnd - this.time);
    const onTake = el?.dataset.assetId === clip.mediaAssetId;
    if (el && onTake && el.readyState >= 2 && !el.seeking && !el.paused) {
      const fromVideo = clipStart + (el.currentTime - clip.sourceStart);
      // Trust the video clock unless it's clearly stale (e.g. right after a switch).
      if (fromVideo >= clipStart - 0.05 && fromVideo <= clipEnd + 0.25) t = fromVideo;
    } else if (el && (el.seeking || el.readyState < 2 || !onTake)) {
      t = this.time; // buffering: hold the frame rather than letting picture and clock diverge
    }

    // The clock (currentTime, a little ahead of the picture) cuts here; where frame callbacks
    // exist, watchFrames cuts on the frame if it gets there first. (Cutting ONLY on frame
    // callbacks was measured: worse in Chrome — 3–9 dropped frames per 13 cuts instead of 1–2.)
    if (t >= clipEnd - 0.008) {
      this.crossBoundary(i);
      if (!this.playing) return;
    } else {
      this.time = Math.max(this.time, t);
      this.applyVisuals();
    }
    this.emit();
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Visibility, crop transform of the active element, and the punch-in on the zoom layer. */
  applyVisuals() {
    const { w, h } = this.viewport;
    if (!w || !h) return;
    const activeIndex = this.previewOverride ? this.previewOverride.clipIndex : this.activeIndex >= 0 ? this.activeIndex : this.clipAt(this.time).clipIndex;
    const activeKey = this.clipPlayer[activeIndex] ?? null;
    const clip = this.doc.clips[activeIndex];
    for (const [key, el] of this.players) {
      const visible = key === activeKey;
      // The hidden element is STACKED BEHIND the visible one (both cover the whole canvas), not
      // made transparent: WebKit stops painting an opacity-0 <video> and, once shown again, can
      // take most of a second to present its first frame (measured: Playwright WebKit, 0.9 s
      // freezes at cuts) — a warm standby must stay "visible" to keep decoding to the screen.
      el.style.zIndex = visible ? "1" : "0";
      el.style.opacity = visible || (el.readyState >= 2 && !!el.dataset.assetId) ? "1" : "0";
      if (visible && clip) {
        const asset = this.assets.get(clip.mediaAssetId);
        const loaded = el.dataset.assetId === clip.mediaAssetId && el.videoWidth > 0;
        const srcW = (loaded ? el.videoWidth : 0) || asset?.width || 1080;
        const srcH = (loaded ? el.videoHeight : 0) || asset?.height || 1920;
        // Same geometry as the renderer (cropGeometry), at preview scale.
        const g = cropGeometry({ width: srcW, height: srcH }, { width: w, height: h }, clip.crop);
        el.style.width = `${g.scaledWidth}px`;
        el.style.height = `${g.scaledHeight}px`;
        el.style.transform = `translate(${-g.offsetX}px, ${-g.offsetY}px)`;
      }
    }
    if (this.zoomLayer) {
      const z = this.previewOverride ? { zoom: 1, x: 0.5, y: 0.5 } : zoomStateAt(this.zooms, this.time);
      this.zoomLayer.style.transformOrigin = `${z.x * 100}% ${z.y * 100}%`;
      this.zoomLayer.style.transform = z.zoom === 1 ? "none" : `scale(${z.zoom})`;
    }
  }
}

/** Creates the engine once per editor mount and keeps it in sync with the doc. */
export function usePlaybackEngine(doc: EditorDoc, assets: Map<string, EditorAsset>): PlaybackEngine {
  const [engine] = useState(() => new PlaybackEngine(doc, assets));
  useEffect(() => {
    engine.setDoc(doc, assets);
  }, [engine, doc, assets]);
  useEffect(() => () => engine.dispose(), [engine]);
  return engine;
}

/** Re-renders only when `select(time)` changes (compared with Object.is on the returned primitive). */
export function usePlayheadValue<T extends string | number | boolean | null>(engine: PlaybackEngine, select: (t: number) => T): T {
  const selectRef = useRef(select);
  useEffect(() => {
    selectRef.current = select;
  });
  return useSyncExternalStore(
    engine.subscribe,
    () => selectRef.current(engine.time),
    () => selectRef.current(0),
  );
}

export function useIsPlaying(engine: PlaybackEngine): boolean {
  return useSyncExternalStore(engine.subscribe, engine.getPlaying, () => false);
}
