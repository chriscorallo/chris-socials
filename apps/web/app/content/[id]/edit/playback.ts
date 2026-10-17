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

/**
 * The preview's playback engine — one requestAnimationFrame clock for the whole editor.
 *
 * Every clip is played by a real <video> element of its source take. Consecutive uses of the
 * same take alternate between two elements ("slots"), so while one clip plays, the element for
 * the next clip is already paused on its first frame — the cut is a visibility swap, not a
 * seek. While playing, the ACTIVE video is the master clock (no audio/video drift); when it's
 * stalled or not ready, a wall clock carries time forward.
 *
 * The engine writes per-frame visuals (which element is visible, the crop and punch-in
 * transforms) straight to the DOM and notifies subscribers with the time — React only
 * re-renders for structural changes, never per frame.
 */

export interface PlayerSlot {
  key: string;
  asset: EditorAsset;
}

/** Which player element plays each clip, and the set of elements the preview must mount. */
export function assignPlayers(doc: EditorDoc, assets: Map<string, EditorAsset>): { clipPlayer: string[]; slots: PlayerSlot[] } {
  const lastSlot = new Map<string, number>();
  const clipPlayer: string[] = [];
  const keys = new Map<string, PlayerSlot>();
  doc.clips.forEach((c) => {
    const prev = lastSlot.get(c.mediaAssetId);
    const slot = prev === undefined ? 0 : 1 - prev;
    lastSlot.set(c.mediaAssetId, slot);
    const key = `${c.mediaAssetId}#${slot}`;
    clipPlayer.push(key);
    const asset = assets.get(c.mediaAssetId);
    if (asset && !keys.has(key)) keys.set(key, { key, asset });
  });
  return { clipPlayer, slots: [...keys.values()] };
}

type Listener = () => void;

export class PlaybackEngine {
  time = 0;
  playing = false;
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
      const onReady = () => {
        if (!this.playing) this.syncPaused();
        this.applyVisuals();
      };
      el.addEventListener("loadeddata", onReady);
      el.addEventListener("seeked", onReady);
    } else {
      const old = this.players.get(key);
      old?.pause();
      this.players.delete(key);
    }
  }

  setZoomLayer(el: HTMLElement | null) {
    this.zoomLayer = el;
    this.applyVisuals();
  }

  setViewport(w: number, h: number) {
    this.viewport = { w, h };
    this.applyVisuals();
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
    const { clipPlayer } = assignPlayers(this.doc, this.assets);
    this.clipPlayer = clipPlayer;
    this.starts = clipStartTimes(this.doc);
    this.duration = timelineDuration(this.doc);
    this.zooms = normalizeZooms(this.doc.zooms, this.duration).zooms;
  }

  // --- transport ----------------------------------------------------------------------

  play() {
    if (this.playing) return;
    if (this.time >= this.duration - 0.02) this.time = 0;
    this.previewOverride = null;
    this.playing = true;
    this.lastTs = performance.now();
    this.startActive(true);
    this.raf = requestAnimationFrame(this.tick);
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const p of this.players.values()) p.pause();
    this.syncPaused();
    this.emit();
  }

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
      if (el && Math.abs(el.currentTime - sourceTime) > 0.01) el.currentTime = sourceTime;
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

  /** Paused: active element shows the exact frame; every other element waits on its next clip's first frame. */
  private syncPaused() {
    if (this.previewOverride) return;
    const { clipIndex, sourceTime } = this.clipAt(this.time);
    this.activeIndex = clipIndex;
    this.activeKey = this.clipPlayer[clipIndex] ?? null;
    const el = this.activeKey ? this.players.get(this.activeKey) : undefined;
    if (el && el.readyState >= 1 && Math.abs(el.currentTime - sourceTime) > 0.015) el.currentTime = sourceTime;
    this.prerollNext(clipIndex);
  }

  /** Points every non-active element at the first frame of the next clip it will play. */
  private prerollNext(fromIndex: number) {
    const seen = new Set<string>([this.clipPlayer[fromIndex] ?? ""]);
    for (let i = fromIndex + 1; i < this.doc.clips.length; i++) {
      const key = this.clipPlayer[i]!;
      if (seen.has(key)) continue;
      seen.add(key);
      const el = this.players.get(key);
      const c = this.doc.clips[i]!;
      if (el && el.readyState >= 1 && Math.abs(el.currentTime - c.sourceStart) > 0.04) {
        if (!el.paused) el.pause();
        el.currentTime = c.sourceStart;
      }
    }
  }

  private startActive(seekExact: boolean) {
    const { clipIndex, sourceTime } = this.clipAt(this.time);
    const key = this.clipPlayer[clipIndex] ?? null;
    for (const [k, p] of this.players) if (k !== key && !p.paused) p.pause();
    this.activeIndex = clipIndex;
    this.activeKey = key;
    const el = key ? this.players.get(key) : undefined;
    if (el) {
      if (seekExact && Math.abs(el.currentTime - sourceTime) > 0.05) el.currentTime = sourceTime;
      el.volume = Math.min(1, Math.max(0, this.doc.clips[clipIndex]!.volume));
      el.muted = this.doc.clips[clipIndex]!.volume === 0;
      void el.play().catch(() => {
        /* autoplay policies / not yet loaded — wall clock carries on */
      });
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
    if (el && el.readyState >= 2 && !el.seeking && !el.paused) {
      const fromVideo = clipStart + (el.currentTime - clip.sourceStart);
      // Trust the video clock unless it's clearly stale (e.g. right after a switch).
      if (fromVideo >= clipStart - 0.05 && fromVideo <= clipEnd + 0.25) t = fromVideo;
    } else if (el && (el.seeking || el.readyState < 2)) {
      t = this.time; // buffering: hold the frame rather than letting picture and clock diverge
    }

    if (t >= clipEnd - 0.008) {
      if (i + 1 >= this.doc.clips.length) {
        this.time = this.duration;
        this.pause();
        this.emit();
        return;
      }
      this.time = clipEnd;
      this.startActive(false);
      // the next element was pre-rolled to its first frame; make sure it's exact
      const nextEl = this.activeKey ? this.players.get(this.activeKey) : undefined;
      const next = this.doc.clips[this.activeIndex]!;
      if (nextEl && Math.abs(nextEl.currentTime - next.sourceStart) > 0.08) nextEl.currentTime = next.sourceStart;
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
      el.style.opacity = visible ? "1" : "0";
      if (visible && clip) {
        const asset = this.assets.get(clip.mediaAssetId);
        const srcW = el.videoWidth || asset?.width || 1080;
        const srcH = el.videoHeight || asset?.height || 1920;
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
