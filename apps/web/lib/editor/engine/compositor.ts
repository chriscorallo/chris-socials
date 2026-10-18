import { cropGeometry, normalizeZooms, resolveGrade, timelineDuration, zoomStateAt, bakeFrameAt, type TimelineZoom } from "@chris/media/timeline";
import type { EditorAsset, EditorDoc } from "../types";
import type { EditorHealth } from "../health";
import { MasterClock, audioClock, wallClock } from "./clock";
import { GlCompositor } from "./gl";
import { mediaBytes, type MediaBytes } from "./media-bytes";
import { audioPieces, planSegments, segmentAt, segmentsFrom, type PlanSegment } from "./plan";
import { VideoPump, type PlanSpan } from "./video-pump";
import { AudioScheduler, TakeAudio } from "./audio";

/**
 * The compositor preview engine (docs/decisions-pending/editor-rebuild.md) — smooth on an
 * iPhone by construction:
 *  - ONE canvas: the take's 720p proxy is decoded with WebCodecs (hardware H.264) straight
 *    from memory and drawn in WebGL with the renderer's crop/zoom/grade/vignette math; baked
 *    motion graphics are decoded the same way and composited in the same draw. No <video>
 *    swapping at cuts, no DOM layers to drift.
 *  - ONE clock: the AudioContext. Every clip's sound is a buffer source scheduled at an exact
 *    context time; the picture follows the clock. Cuts are sample-accurate; nothing restarts.
 *  - Decode-ahead: frames for the next ~0.3 s (across cuts) are decoded before the clock gets
 *    there; a jump cut restarts at the key frame before it (≤ 0.5 s of lead-in).
 *  - Paused/scrubbing: exact frame decode, nearest key frame first, coalesced.
 * Public surface = the <video>-pool engine's (Preview/Timeline/etc. don't know which runs).
 */

type Listener = () => void;

interface Take {
  asset: EditorAsset;
  media: MediaBytes;
  pump: VideoPump | null;
  audio: TakeAudio | null;
}

export interface BakeSpec {
  visualId: string;
  start: number;
  end: number;
  fps: number;
  frames: number;
  url: string;
}

interface Bake {
  spec: BakeSpec;
  media: MediaBytes;
  pump: VideoPump | null;
  /** local source time of the frame in the texture, or -1 */
  shown: number;
  playing: boolean;
}

const START_TIMEOUT_MS = 1200;
const PLAN_AHEAD_S = 2.5;
const PLAN_REFILL_S = 1.5;
const AUDIO_AHEAD_S = 1.2;

export class CompositorEngine {
  readonly kind = "compositor" as const;
  time = 0;
  playing = false;
  muted = false;
  health: EditorHealth | null = null;
  /** What the engine is doing — shown in telemetry. */
  status: "idle" | "starting" | "playing" | "buffering" = "idle";
  private doc: EditorDoc;
  private assets: Map<string, EditorAsset>;
  private segs: PlanSegment[] = [];
  private duration = 0;
  private zooms: TimelineZoom[] = [];
  private takes = new Map<string, Take>();
  private bakes = new Map<string, Bake>();
  private listeners = new Set<Listener>();
  private gestureHooks = new Set<Listener>();
  private gl: GlCompositor | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private viewport = { w: 0, h: 0 };
  private clock = new MasterClock();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private scheduler: AudioScheduler | null = null;
  private raf = 0;
  private dirty = true;
  /** segment index whose frame is in the footage texture */
  private shownSeg = -1;
  private shownPts = -1;
  private firstDrawn = false;
  /** playback plan: segment index → span id, the furthest output time planned */
  private planIds = new Map<number, number>();
  private plannedUntil = 0;
  private nextSpanId = 1;
  private startAt = 0;
  private override: { clipIndex: number; sourceTime: number } | null = null;
  private seekStartedAt = 0;
  private disposed = false;

  constructor(doc: EditorDoc, assets: Map<string, EditorAsset>) {
    this.doc = doc;
    this.assets = assets;
    this.recompute();
    if (typeof window !== "undefined") {
      this.initAudio();
      this.raf = requestAnimationFrame(this.tick);
      // Leaving the app mid-play: the page stops drawing but the audio clock would run on.
      document.addEventListener("visibilitychange", this.onVisibility);
      // start downloading every take the edit uses right away (instant first play)
      for (const s of this.segs) this.take(s.assetId);
      this.showStill(0);
    }
  }

  // ------------------------------------------------------------------ wiring

  private initAudio() {
    const W = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctor = W.AudioContext ?? W.webkitAudioContext;
    if (!Ctor) return;
    // iOS: Web Audio follows the ring/silent switch unless the page's audio session is
    // "playback" (Safari 16.4+) — a <video> ignores the switch, so without this the preview
    // would go silent on a muted phone where the old engine wasn't.
    try {
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      if (nav.audioSession) nav.audioSession.type = "playback";
    } catch {
      /* not supported */
    }
    try {
      // 48 kHz = the proxies' rate: decodeAudioData then never resamples per chunk (seams).
      try {
        this.ctx = new Ctor({ sampleRate: 48000, latencyHint: "interactive" });
      } catch {
        this.ctx = new Ctor();
      }
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.scheduler = new AudioScheduler(this.ctx, this.master);
    } catch {
      this.ctx = null;
    }
  }

  /** The shared AudioContext (music bed / SFX use it too — iOS allows few, each unlocked by a tap). */
  audioContext(): AudioContext | null {
    return this.ctx;
  }

  private take(assetId: string): Take | null {
    let t = this.takes.get(assetId);
    if (t) return t;
    const asset = this.assets.get(assetId);
    if (!asset) return null;
    const media = mediaBytes(asset.url);
    t = { asset, media, pump: null, audio: null };
    this.takes.set(assetId, t);
    const tk = t;
    const ready = () => {
      if (!tk.media.info) return;
      if (!tk.pump) {
        const v = tk.media.info.tracks.find((x) => x.kind === "video");
        const a = tk.media.info.tracks.find((x) => x.kind === "audio");
        if (v) {
          tk.pump = new VideoPump(tk.media, v);
          tk.pump.onError = (msg) => this.health?.event("decoder", { error: msg.slice(0, 80), asset: "take" });
          this.health?.event("media", { path: tk.media.path ?? "?", moovMs: Math.round(performance.now() - tk.media.startedAt) });
          if (this.health) this.health.engineInfo.mediaPath = tk.media.path ?? null;
          if (!this.playing) this.showStill(this.time);
        }
        if (a) tk.audio = new TakeAudio(tk.media, a);
      }
      if (tk.media.done && this.health) {
        this.health.engineInfo.downloadMs = tk.media.doneMs;
        this.health.engineInfo.firstByteMs = tk.media.firstByteMs;
      }
      if (tk.media.error) this.health?.event("media", { error: tk.media.error.slice(0, 80) });
    };
    media.onChange(ready);
    ready();
    return t;
  }

  setDoc(doc: EditorDoc, assets?: Map<string, EditorAsset>) {
    const clipsChanged = doc.clips !== this.doc.clips;
    this.doc = doc;
    if (assets) this.assets = assets;
    this.recompute();
    if (this.time > this.duration) this.time = this.duration;
    if (clipsChanged) {
      for (const s of this.segs) this.take(s.assetId);
      if (this.playing) this.restart(this.time);
      else this.showStill(this.time);
    }
    this.dirty = true;
  }

  private recompute() {
    this.segs = planSegments(this.doc);
    this.duration = timelineDuration(this.doc);
    this.zooms = normalizeZooms(this.doc.zooms, this.duration).zooms;
  }

  /** The GL canvas (Preview renders it in place of the <video> pool). */
  canvasRef = (el: HTMLCanvasElement | null) => {
    if (el === this.canvas) return;
    this.gl?.dispose();
    this.gl = null;
    this.canvas = el;
    if (el) {
      try {
        this.gl = new GlCompositor(el);
        this.firstDrawn = false;
        this.shownPts = -1;
        this.applySize();
        if (!this.playing) this.showStill(this.time);
      } catch (e) {
        this.health?.error(`webgl: ${e instanceof Error ? e.message : String(e)}`);
        // No picture without WebGL: switch this device to the <video> engine (once) and reload.
        try {
          if (window.localStorage.getItem("chris-editor-engine") !== "video") {
            window.localStorage.setItem("chris-editor-engine", "video");
            window.location.reload();
          }
        } catch {
          /* storage blocked — the poster stays; ?engine=video still works */
        }
      }
    }
  };

  setViewport(w: number, h: number) {
    this.viewport = { w, h };
    this.applySize();
    this.dirty = true;
  }

  private applySize() {
    if (!this.gl || !this.viewport.w) return;
    // ≤ 2× device pixels: the proxy is 720 wide; more only costs fill rate on a phone.
    const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    this.gl.resize(this.viewport.w, this.viewport.h, dpr);
  }

  /** No-ops kept for interface parity with the <video>-pool engine. */
  setZoomLayer(_el: HTMLElement | null) {
    void _el;
  }
  playerRef(_key: string): (el: HTMLVideoElement | null) => void {
    void _key;
    return () => undefined;
  }

  /** Baked graphics the compositor draws (the rest stay live in the DOM). */
  setBakes(specs: BakeSpec[]) {
    const keep = new Set(specs.map((s) => `${s.visualId}|${s.url}`));
    for (const [k, b] of this.bakes) {
      if (!keep.has(k)) {
        b.pump?.close();
        this.gl?.dropSprite(k);
        this.bakes.delete(k);
      }
    }
    for (const spec of specs) {
      const k = `${spec.visualId}|${spec.url}`;
      const existing = this.bakes.get(k);
      if (existing) {
        existing.spec = spec; // start/end may move without changing pixels
        continue;
      }
      const b: Bake = { spec, media: mediaBytes(spec.url), pump: null, shown: -1, playing: false };
      this.bakes.set(k, b);
      const ready = () => {
        if (b.pump || !b.media.info) return;
        const v = b.media.info.tracks.find((x) => x.kind === "video");
        if (!v) return;
        b.pump = new VideoPump(b.media, v);
        b.pump.onError = (msg) => this.health?.event("decoder", { error: msg.slice(0, 80), asset: "bake" });
        if (!this.playing) this.stillBake(k, b, this.time);
      };
      b.media.onChange(ready);
      ready();
    }
    this.dirty = true;
  }

  /** Visual ids drawn by the compositor right now (the live layer skips these). */
  bakedVisualIds(): Set<string> {
    return new Set([...this.bakes.values()].map((b) => b.spec.visualId));
  }

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
  getMuted = () => this.muted;

  get totalDuration() {
    return this.duration;
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------------ transport

  /** Call from the play tap itself (iOS unlocks audio only inside a gesture). */
  play() {
    if (this.playing) return;
    if (this.time >= this.duration - 0.02) this.time = 0;
    this.override = null;
    if (this.ctx && this.ctx.state !== "running") void this.ctx.resume().catch(() => undefined);
    this.playing = true;
    for (const h of this.gestureHooks) {
      try {
        h();
      } catch {
        /* a side player failing must never stop the picture */
      }
    }
    this.health?.setPlaying(true);
    this.restart(this.time);
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.time = this.clock.isRunning ? Math.min(this.duration, this.clock.stop()) : this.time;
    this.status = "idle";
    this.scheduler?.stopAll();
    for (const t of this.takes.values()) t.pump?.idle();
    for (const b of this.bakes.values()) {
      b.pump?.idle();
      b.playing = false;
    }
    this.health?.setPlaying(false);
    this.showStill(this.time, true);
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    this.override = null;
    this.time = Math.max(0, Math.min(this.duration, t));
    if (this.playing) this.restart(this.time);
    else this.showStill(this.time);
    this.emit();
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setValueAtTime(m ? 0 : 1, this.ctx.currentTime);
    this.emit();
  }

  /** Trim preview: show a source frame of a clip without moving the playhead. */
  previewSourceFrame(clipIndex: number, sourceTime: number | null) {
    if (sourceTime === null) {
      this.override = null;
      this.showStill(this.time);
      return;
    }
    if (this.playing) this.pause();
    this.override = { clipIndex, sourceTime };
    const clip = this.doc.clips[clipIndex];
    const take = clip ? this.take(clip.mediaAssetId) : null;
    const seg = this.segs.findIndex((s) => s.clipIndex === clipIndex);
    if (!take?.pump || seg < 0) return;
    take.pump.seek(sourceTime, (f) => {
      if (!this.override) return;
      this.gl?.setFootage(f);
      this.shownSeg = seg;
      this.dirty = true;
    });
  }

  snapshot(width = 120): string | null {
    if (!this.gl) return null;
    this.render();
    return this.gl.snapshot(width);
  }

  /** The person cut-out (behind-you graphics) needs a <video>; the compositor draws in front. */
  activeFrame(): null {
    return null;
  }

  private onVisibility = () => {
    if (document.visibilityState === "hidden" && this.playing) this.pause();
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    this.scheduler?.stopAll();
    for (const t of this.takes.values()) t.pump?.close();
    for (const b of this.bakes.values()) b.pump?.close();
    this.gl?.dispose();
    void this.ctx?.close().catch(() => undefined);
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ playback internals

  /** (Re)starts playback decoding + audio at output time t; the clock starts once ready. */
  private restart(t: number) {
    this.clock.stop();
    this.clock.set(t);
    this.time = t;
    this.scheduler?.stopAll();
    this.planIds.clear();
    this.plannedUntil = t;
    for (const tk of this.takes.values()) tk.pump?.idle();
    this.status = "starting";
    this.startAt = performance.now();
    this.planFrom(t, t + PLAN_AHEAD_S, true);
    for (const b of this.bakes.values()) b.playing = false;
  }

  /** Hands the next spans (output time ≥ from, up to `to`) to the takes' decoders. */
  private planFrom(from: number, to: number, fresh: boolean) {
    const spans = segmentsFrom(this.segs, from, to - from);
    const byAsset = new Map<string, PlanSpan[]>();
    const flushAfter = new Set<number>();
    spans.forEach((s, k) => {
      const segIndex = s.segIndex;
      if (this.planIds.has(segIndex)) return;
      const id = this.nextSpanId++;
      this.planIds.set(segIndex, id);
      const list = byAsset.get(s.assetId) ?? [];
      list.push({ seg: id, srcStart: s.srcStart, srcEnd: s.srcEnd, continues: s.continues && (list.length > 0 || (!fresh && this.planIds.has(segIndex - 1))) });
      byAsset.set(s.assetId, list);
      const next = spans[k + 1];
      if (next && next.assetId !== s.assetId) flushAfter.add(id);
    });
    for (const [assetId, list] of byAsset) {
      const tk = this.take(assetId);
      if (!tk?.pump) continue;
      if (fresh) {
        tk.pump.startPlan([]);
      }
      for (const span of list) tk.pump.extendPlan(span, flushAfter.has(span.seg));
    }
    const lastSeg = spans[spans.length - 1];
    if (lastSeg) this.plannedUntil = Math.max(this.plannedUntil, lastSeg.outEnd);
    if (this.plannedUntil >= this.duration - 1e-3) for (const tk of this.takes.values()) if (tk.pump) tk.pump.planComplete = true;
  }

  private audioReadyFor(t: number, ahead: number): boolean {
    const spans = segmentsFrom(this.segs, t, ahead);
    for (const s of spans) {
      const tk = this.takes.get(s.assetId);
      if (!tk?.audio || tk.audio.failed) continue;
      if (tk.audio.decodedUntil() < Math.min(s.srcEnd, s.srcStart + ahead) - 0.01 && !tk.audio.complete) return false;
    }
    return true;
  }

  private startClock() {
    const t = this.time;
    if (this.ctx && this.ctx.state === "running") {
      const src = audioClock(this.ctx);
      this.clock.start(t, src, this.ctx.currentTime + 0.04);
    } else {
      this.clock.start(t, wallClock());
    }
    this.status = "playing";
    this.health?.event("clock", { kind: this.clock.kind ?? "?", startMs: Math.round(performance.now() - this.startAt) });
    this.scheduleAudio();
  }

  private scheduleAudio() {
    if (!this.scheduler || !this.ctx || this.clock.kind !== "audio") return;
    const t = this.clock.time();
    const spans = segmentsFrom(this.segs, t, AUDIO_AHEAD_S);
    const pieces = audioPieces(spans);
    pieces.forEach((p, k) => {
      const segIndex = spans[k]!.segIndex;
      const tk = this.takes.get(p.assetId);
      if (!tk?.audio) return;
      this.scheduler!.schedule(`s${segIndex}`, p, tk.audio, (out) => this.clock.sourceTimeFor(out));
    });
    this.scheduler.gc();
  }

  private tick = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    // keep decoders/audio fed
    if (this.ctx) for (const tk of this.takes.values()) tk.audio?.pump(this.ctx);
    if (this.playing) this.playTick();
    else this.pumpBakesPaused();
    if (this.dirty) {
      this.dirty = false;
      this.render();
    }
  };

  private playTick() {
    for (const tk of this.takes.values()) tk.pump?.pump();
    if (this.status === "starting") {
      const segIndex = segmentAt(this.segs, this.time);
      const tk = this.takes.get(this.segs[segIndex]?.assetId ?? "");
      const id = this.planIds.get(segIndex);
      // a take whose index arrived after play was pressed: plan now
      if (tk?.pump && id === undefined) this.planFrom(this.time, this.time + PLAN_AHEAD_S, true);
      const head = tk?.pump?.peek();
      const frameReady = !!head && head.seg === this.planIds.get(segIndex);
      const waited = performance.now() - this.startAt;
      // iOS resumes the context asynchronously after the tap — give it a moment
      const ctxOk = !this.ctx || this.ctx.state === "running" || waited > 600;
      const audioReady = this.audioReadyFor(this.time, 0.5);
      if ((frameReady && audioReady && ctxOk) || (waited > START_TIMEOUT_MS && (frameReady || waited > START_TIMEOUT_MS * 3))) this.startClock();
      else {
        if (waited > 300) this.health?.event("wait", { frame: frameReady, audio: audioReady });
        return;
      }
    }
    // the context came up after a silent (wall-clock) start: hand the clock to it, add sound
    if (this.clock.kind === "wall" && this.ctx?.state === "running") {
      this.clock.rebase(audioClock(this.ctx));
      this.health?.event("clock", { kind: "audio", rebased: true });
    }
    const t = this.clock.time();
    if (t >= this.duration) {
      this.time = this.duration;
      this.pause();
      return;
    }
    // refill the plan
    if (this.plannedUntil - t < PLAN_REFILL_S && this.plannedUntil < this.duration) this.planFrom(this.plannedUntil - 1e-6, this.plannedUntil + PLAN_AHEAD_S, false);
    this.scheduleAudio();
    // the frame for t
    const segIndex = segmentAt(this.segs, t);
    const seg = this.segs[segIndex];
    const id = this.planIds.get(segIndex);
    const tk = seg ? this.takes.get(seg.assetId) : undefined;
    if (seg && tk?.pump && id !== undefined) {
      const src = seg.srcStart + (t - seg.outStart);
      const r = tk.pump.take(id, src);
      if (r) {
        this.gl?.setFootage(r.frame);
        r.frame.close();
        this.shownSeg = segIndex;
        this.shownPts = r.pts;
        this.dirty = true;
        this.health?.framePresented();
        if (!this.firstDrawn) this.markFirstFrame();
      } else if (this.shownSeg !== segIndex || src - this.shownPts > 2.5 * tk.pump.fi.frameDur) {
        // the frame isn't decoded in time
        this.health?.lateFrame();
        if (tk.pump.starved() && tk.pump.readyCount() === 0) {
          // network: hold (buffering) and restart cleanly from here once bytes arrive
          this.health?.event("buffering", { t: Math.round(t * 100) / 100 });
          this.time = t;
          this.restart(t);
          this.emit();
          return;
        }
      }
    }
    this.playBakes(t);
    this.time = t;
    this.dirty = true;
    this.emit();
  }

  private markFirstFrame() {
    this.firstDrawn = true;
    this.health?.mark("firstFrame");
    if (this.canvas) this.canvas.style.opacity = "1";
  }

  // ------------------------------------------------------------------ graphics (baked)

  private bakeLocal(b: Bake, t: number): number | null {
    const f = bakeFrameAt(b.spec, t, b.spec.fps, b.spec.frames);
    return f === null ? null : f / b.spec.fps;
  }

  private playBakes(t: number) {
    for (const [k, b] of this.bakes) {
      if (!b.pump) continue;
      const from = Math.max(0, Math.round(b.spec.start * b.spec.fps)) / b.spec.fps;
      const end = from + b.spec.frames / b.spec.fps;
      if (t < from - 1.0 || t >= end) {
        if (b.playing) {
          b.pump.idle();
          b.playing = false;
        }
        continue;
      }
      if (!b.playing) {
        const local = Math.max(0, t - from);
        const id = this.nextSpanId++;
        b.pump.startPlan([{ seg: id, srcStart: local, srcEnd: b.spec.frames / b.spec.fps, continues: false }]);
        b.pump.planComplete = true;
        (b as Bake & { span?: number }).span = id;
        b.playing = true;
      }
      b.pump.pump();
      const local = this.bakeLocal(b, t);
      if (local === null) continue;
      const r = b.pump.take((b as Bake & { span?: number }).span!, local + 1e-4);
      if (r) {
        this.gl?.setSprite(k, r.frame);
        r.frame.close();
        b.shown = r.pts;
      }
    }
  }

  private stillBake(k: string, b: Bake, t: number) {
    const local = this.bakeLocal(b, t);
    if (local === null || !b.pump) return;
    if (Math.abs(b.shown - local) < 1e-4) return;
    b.pump.seek(local + 1e-4, (f) => {
      this.gl?.setSprite(k, f);
      b.shown = f.timestamp / 1e6;
      this.dirty = true;
    });
  }

  private pumpBakesPaused() {
    /* still decodes run off their own callbacks */
  }

  // ------------------------------------------------------------------ paused frames

  /** Shows the exact frame at output time t (paused / scrubbing). */
  private showStill(t: number, afterPlay = false) {
    if (this.override) return;
    const segIndex = segmentAt(this.segs, t);
    const seg = this.segs[segIndex];
    if (!seg) return;
    const tk = this.take(seg.assetId);
    const src = Math.min(seg.srcEnd - 1e-4, seg.srcStart + Math.max(0, t - seg.outStart));
    for (const [k, b] of this.bakes) this.stillBake(k, b, t);
    this.dirty = true;
    if (!tk?.pump) return;
    // the frame on screen after playing is already the right one
    if (afterPlay && this.shownSeg === segIndex && Math.abs(src - this.shownPts) < tk.pump.fi.frameDur * 0.6) return;
    this.seekStartedAt = performance.now();
    tk.pump.seek(src, (f, exact) => {
      if (this.playing || this.override) return;
      this.gl?.setFootage(f);
      this.shownSeg = segIndex;
      this.shownPts = f.timestamp / 1e6;
      this.dirty = true;
      if (!this.firstDrawn) this.markFirstFrame();
      if (exact && this.seekStartedAt) {
        this.health?.scrubLatency(performance.now() - this.seekStartedAt);
        this.seekStartedAt = 0;
      }
    });
  }

  // ------------------------------------------------------------------ drawing

  private render() {
    const gl = this.gl;
    const { w, h } = this.viewport;
    if (!gl || !w || !h) return;
    const segIndex = this.override ? this.segs.findIndex((s) => s.clipIndex === this.override!.clipIndex) : this.shownSeg >= 0 ? this.shownSeg : segmentAt(this.segs, this.time);
    const seg = this.segs[segIndex];
    const clip = seg ? this.doc.clips[seg.clipIndex] : undefined;
    const asset = clip ? this.assets.get(clip.mediaAssetId) : undefined;
    let footage = null;
    if (clip) {
      const vt = seg ? this.takes.get(seg.assetId)?.pump?.track : undefined;
      // display size of the decoded proxy (upright) — the crop is relative to the source aspect
      const srcW = vt?.width || asset?.width || 1080;
      const srcH = vt?.height || asset?.height || 1920;
      const g = cropGeometry({ width: srcW, height: srcH }, { width: this.doc.canvas.width, height: this.doc.canvas.height }, clip.crop);
      const W = this.doc.canvas.width;
      const H = this.doc.canvas.height;
      footage = {
        rect: { x: -g.offsetX / W, y: -g.offsetY / H, w: g.scaledWidth / W, h: g.scaledHeight / H },
        uvRect: { x: 0, y: 0, w: 1, h: 1 },
        zoom: this.override ? { zoom: 1, x: 0.5, y: 0.5 } : zoomStateAt(this.zooms, this.time),
        grade: resolveGrade(this.doc.grade),
      };
    }
    const sprites: string[] = [];
    if (!this.override)
      for (const [k, b] of this.bakes) {
        if (b.shown >= 0 && this.bakeLocal(b, this.time) !== null) sprites.push(k);
      }
    gl.draw(footage, false, sprites);
  }

  /** Debug: per-take decoder state. */
  debug() {
    return { t: this.time, status: this.status, shownSeg: this.shownSeg, shownPts: this.shownPts, planIds: [...this.planIds.entries()], takes: [...this.takes.values()].map((t) => t.pump?.stats() ?? null) };
  }

  /** Telemetry snapshot of the engine's state. */
  info(): Record<string, string | number | boolean | null> {
    let ready = 0;
    let decoded = 0;
    let errors = 0;
    for (const t of this.takes.values()) {
      ready += t.pump?.readyCount() ?? 0;
      decoded += t.pump?.decodedTotal ?? 0;
      errors += t.pump?.errors ?? 0;
    }
    return { status: this.status, clock: this.clock.kind, ctxState: this.ctx?.state ?? null, ctxRate: this.ctx?.sampleRate ?? null, readyFrames: ready, decoded, decodeErrors: errors, bakes: this.bakes.size };
  }
}
