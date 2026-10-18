import { buildFrameIndex, decodeRange, frameAt, samplePts, type FrameIndex, type Mp4Track } from "./mp4";
import type { MediaBytes } from "./media-bytes";

/**
 * One WebCodecs VideoDecoder per take (or baked graphic), fed straight from the in-memory
 * proxy bytes. Two modes:
 *
 * PLAY — given the decode plan (source spans in output order), decodes ahead in output order
 * into a small queue of VideoFrames (≤ MAX_READY, ~0.3 s): a continuation keeps decoding; a
 * jump restarts at the key frame before the new span (keyframes every 0.5 s → ≤ 15 frames of
 * lead-in, decoded and dropped in a few ms). The compositor takes the frame for the clock's
 * time each tick. Cuts are seamless by construction: the first frame after a cut is decoded
 * before the clock gets there.
 *
 * STILL — one exact frame (paused, scrubbing): decode from the key frame before it; every
 * output at or before the target is shown as it arrives (nearest key frame first, then refined
 * to the exact frame). New targets during a decode are coalesced — only the latest runs next.
 */

export const MAX_READY = 8;
/**
 * Chunks fed but not yet output. Some decoders (software, frame-threaded — e.g. desktop WebKit)
 * hold ~20 frames before the first output and then release them in a burst, so
 * decodeQueueSize alone can't pace feeding; this cap bounds the burst instead.
 */
const MAX_PENDING = 30;

interface Tag {
  seg: number;
  /** shown frame (inside its span) vs. decode lead-in to drop */
  show: boolean;
  pts: number;
}

export interface ReadyFrame {
  frame: VideoFrame;
  seg: number;
  pts: number;
}

export interface PlanSpan {
  /** monotonically increasing id (output order) */
  seg: number;
  srcStart: number;
  srcEnd: number;
  continues: boolean;
}

export class VideoPump {
  readonly media: MediaBytes;
  readonly track: Mp4Track;
  readonly fi: FrameIndex;
  private decoder: VideoDecoder | null = null;
  private tags = new Map<number, Tag[]>();
  private ready: ReadyFrame[] = [];
  /** PLAY: decode-order sample queue */
  private queue: Array<{ i: number; tag: Tag; flushAfter?: boolean }> = [];
  private plan: PlanSpan[] = [];
  private lastFed = -1;
  private mode: "idle" | "play" | "still" = "idle";
  private needKey = true;
  private still: { target: number; best: VideoFrame | null; bestPts: number; busy: boolean; pending: number | null; onFrame: ((f: VideoFrame, exact: boolean) => void) | null; startedAt: number } = { target: -1, best: null, bestPts: -1, busy: false, pending: null, onFrame: null, startedAt: 0 };
  errors = 0;
  decodedTotal = 0;
  private pendingOut = 0;
  onError: ((msg: string) => void) | null = null;
  onOutput: (() => void) | null = null;

  constructor(media: MediaBytes, track: Mp4Track) {
    this.media = media;
    this.track = track;
    this.fi = buildFrameIndex(track);
  }

  private config(): VideoDecoderConfig {
    return { codec: this.track.codec, description: this.track.description ?? undefined, codedWidth: this.track.width, codedHeight: this.track.height, optimizeForLatency: true };
  }

  private ensureDecoder(): VideoDecoder {
    if (this.decoder && this.decoder.state !== "closed") return this.decoder;
    this.decoder = new VideoDecoder({
      output: (f) => this.onDecoded(f),
      error: (e) => {
        this.errors++;
        this.onError?.(e instanceof Error ? e.message : String(e));
        this.decoder = null;
        this.needKey = true;
        this.tags.clear();
      },
    });
    this.decoder.configure(this.config());
    this.needKey = true;
    return this.decoder;
  }

  /** Drops everything in flight (decoder reset) and queued frames. */
  private resetDecoder() {
    try {
      if (this.decoder && this.decoder.state === "configured") {
        this.decoder.reset();
        this.decoder.configure(this.config());
      }
    } catch {
      this.decoder = null;
    }
    this.tags.clear();
    this.pendingOut = 0;
    this.queue = [];
    this.lastFed = -1;
    this.needKey = true;
    for (const r of this.ready) r.frame.close();
    this.ready = [];
  }

  private feed(i: number, tag: Tag): boolean {
    const t = this.track;
    const off = t.offsets[i]!;
    const size = t.sizes[i]!;
    if (!this.media.has(off, size)) return false;
    const dec = this.ensureDecoder();
    const key = t.keys[i] === 1;
    if (this.needKey && !key) return true; // can't start mid-GOP: skip until a key frame
    const ts = Math.round(samplePts(t, i) * 1e6);
    const list = this.tags.get(ts);
    if (list) list.push(tag);
    else this.tags.set(ts, [tag]);
    this.pendingOut++;
    try {
      dec.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: ts, data: this.media.slice(off, size) }));
      this.needKey = false;
    } catch (e) {
      this.errors++;
      this.onError?.(e instanceof Error ? e.message : String(e));
      this.needKey = true;
    }
    this.lastFed = i;
    return true;
  }

  private onDecoded(f: VideoFrame) {
    this.decodedTotal++;
    if (this.pendingOut > 0) this.pendingOut--;
    const list = this.tags.get(f.timestamp);
    const tag = list?.shift();
    if (list && !list.length) this.tags.delete(f.timestamp);
    if (this.mode === "still") {
      const pts = f.timestamp / 1e6;
      const s = this.still;
      if (pts <= s.target + 1e-3 && pts >= s.bestPts) {
        s.best?.close();
        s.best = f;
        s.bestPts = pts;
        const exact = pts >= s.target - this.fi.frameDur + 1e-3;
        s.onFrame?.(f, exact);
      } else f.close();
      return;
    }
    if (!tag || !tag.show || this.mode !== "play") {
      f.close();
      return;
    }
    this.ready.push({ frame: f, seg: tag.seg, pts: tag.pts });
    this.onOutput?.();
  }

  // ------------------------------------------------------------------ PLAY

  /** Starts playback decoding for these spans (first one at the playhead). */
  startPlan(spans: PlanSpan[]) {
    this.mode = "play";
    this.releaseStill();
    this.resetDecoder();
    this.plan = [];
    this.planComplete = false;
    this.flushed = false;
    for (const s of spans) this.extendPlan(s);
  }

  /** Appends a span (the engine extends the plan as playback advances). */
  extendPlan(s: PlanSpan, flushAfter = false) {
    if (this.plan.some((p) => p.seg === s.seg)) return;
    this.plan.push(s);
    const { from, to } = decodeRange(this.track, this.fi, s.srcStart, s.srcEnd);
    // Continuation: keep going from what's already queued/fed. Otherwise restart at the key
    // frame (re-feeding a GOP we already passed is fine — the key frame resets the decoder).
    const tail = this.queue.length ? this.queue[this.queue.length - 1]!.i : this.needKey ? -1 : this.lastFed;
    const cont = s.continues && tail >= from && tail < to;
    const start = cont ? tail + 1 : from;
    if (cont) {
      // B-frames: samples already queued/fed for the previous span can present inside this one
      // (decode order ≠ display order) — re-tag them so those frames are shown, not dropped.
      const half = this.fi.frameDur / 2;
      const claim = (tag: Tag) => {
        if (tag.pts >= s.srcStart - half && tag.pts < s.srcEnd - 1e-4) {
          tag.seg = s.seg;
          tag.show = true;
        }
      };
      for (const q of this.queue) claim(q.tag);
      for (const list of this.tags.values()) for (const tg of list) claim(tg);
    }
    for (let i = start; i <= to; i++) {
      const pts = samplePts(this.track, i);
      const show = pts >= s.srcStart - this.fi.frameDur / 2 && pts < s.srcEnd - 1e-4;
      this.queue.push({ i, tag: { seg: s.seg, show, pts } });
    }
    // The next span plays from another take: push this span's last frames out of the B-frame
    // reorder buffer right after its last sample (otherwise they'd wait for this decoder's
    // next input and arrive late at the cut).
    if (flushAfter && this.queue.length) this.queue[this.queue.length - 1]!.flushAfter = true;
  }

  /** Feeds the decoder while there's room and bytes. Call every tick. */
  pump(): void {
    if (this.mode !== "play") return;
    while (this.queue.length) {
      if (this.ready.length >= MAX_READY || this.pendingOut >= MAX_PENDING) break;
      const q = this.queue[0]!;
      if (!this.feed(q.i, q.tag)) break; // bytes not here yet
      this.queue.shift();
      if (q.flushAfter && this.decoder && this.decoder.state === "configured") {
        void this.decoder.flush().catch(() => undefined);
        this.needKey = true;
      }
    }
    // End of plan: push the last frames out of the B-frame reorder buffer.
    if (this.planComplete && !this.queue.length && this.decoder && this.decoder.state === "configured" && this.decoder.decodeQueueSize === 0 && !this.flushing && !this.flushed) {
      this.flushed = true;
      this.flushing = true;
      void this.decoder
        .flush()
        .catch(() => undefined)
        .finally(() => {
          this.flushing = false;
          this.needKey = true;
        });
    }
  }
  private flushing = false;
  private flushed = false;
  /** Set when the plan reaches the end of the timeline (the tail may then be flushed out). */
  planComplete = false;

  /** True when the next sample needed isn't downloaded yet. */
  starved(): boolean {
    const q = this.queue[0];
    if (!q) return false;
    return !this.media.has(this.track.offsets[q.i]!, this.track.sizes[q.i]!);
  }

  /**
   * The frame to show for span `seg` at source time `src` (last pts ≤ src). Older frames are
   * closed; returns null if nothing newer than what's on screen is ready. Caller closes the
   * returned frame after uploading it.
   */
  take(seg: number, src: number): ReadyFrame | null {
    let pick: ReadyFrame | null = null;
    while (this.ready.length) {
      const r = this.ready[0]!;
      if (r.seg < seg || (r.seg === seg && r.pts <= src + 1e-3)) {
        this.ready.shift();
        if (pick) pick.frame.close();
        pick = r.seg === seg ? r : (r.frame.close(), null);
        continue;
      }
      break;
    }
    return pick;
  }

  /** The earliest queued frame (for "is the next frame ready?" checks). */
  peek(): ReadyFrame | null {
    return this.ready[0] ?? null;
  }

  readyCount(): number {
    return this.ready.length;
  }

  /** Debug/telemetry snapshot. */
  stats() {
    return { mode: this.mode, ready: this.ready.length, queued: this.queue.length, pending: this.pendingOut, inflight: this.decoder?.decodeQueueSize ?? -1, state: this.decoder?.state ?? "none", decoded: this.decodedTotal, readyHead: this.ready[0] ? `${this.ready[0].seg}:${this.ready[0].pts.toFixed(3)}` : null };
  }

  /** Spans not needed any more (already played). */
  prunePlan(beforeSeg: number) {
    this.plan = this.plan.filter((p) => p.seg >= beforeSeg);
  }

  // ------------------------------------------------------------------ STILL

  private releaseStill() {
    this.still.best?.close();
    this.still.best = null;
    this.still.bestPts = -1;
    this.still.pending = null;
  }

  /**
   * Shows source time `src`: `onFrame` runs for each improving frame (key frame first, exact
   * last). Coalesces: while a decode runs, only the newest target is kept for next.
   */
  seek(src: number, onFrame: (f: VideoFrame, exact: boolean) => void) {
    this.still.onFrame = onFrame;
    if (this.mode === "still" && this.still.busy) {
      this.still.pending = src;
      return;
    }
    this.runStill(src);
  }

  private runStill(src: number) {
    if (this.mode !== "still") {
      this.mode = "still";
      this.resetDecoder();
    }
    const s = this.still;
    const fi = this.fi;
    const p = frameAt(fi, src);
    if (p < 0) return;
    const target = fi.pts[p]!;
    // Already showing exactly this frame
    if (s.best && Math.abs(s.bestPts - target) < 1e-4) {
      s.onFrame?.(s.best, true);
      return;
    }
    const d = fi.order[p]!;
    // Forward within the same GOP as the last still decode and the key already fed: just keep
    // feeding (no reset) — scrubbing forward stays cheap.
    const key = fi.keyBefore[d]!;
    const sameGop = this.lastFed >= key && this.lastFed < d && s.bestPts <= target;
    if (!sameGop) {
      this.resetDecoder();
      s.best?.close();
      s.best = null;
      s.bestPts = -1;
    }
    s.target = target;
    s.busy = true;
    s.startedAt = performance.now();
    // feed through the target's decode index plus a few more inside the GOP (B-frame reorder)
    let end = d;
    for (let i = d + 1; i < Math.min(this.track.count, d + 4) && !this.track.keys[i]; i++) end = i;
    let ok = true;
    for (let i = sameGop ? this.lastFed + 1 : key; i <= end; i++) {
      if (!this.feed(i, { seg: -1, show: true, pts: samplePts(this.track, i) })) {
        ok = false;
        break;
      }
    }
    const dec = this.decoder;
    const done = () => {
      s.busy = false;
      this.needKey = true; // after flush the decoder wants a key frame
      this.lastFed = -1;
      const next = s.pending;
      s.pending = null;
      if (next !== null && this.mode === "still") this.runStill(next);
    };
    if (!dec || !ok) {
      // bytes not downloaded yet — retry shortly
      s.busy = false;
      s.pending = null;
      window.setTimeout(() => {
        if (this.mode === "still" && s.target === target) this.runStill(src);
      }, 120);
      return;
    }
    void dec.flush().then(done, done);
  }

  /** Frame currently held by STILL mode (owned by the pump — don't close). */
  stillFrame(): VideoFrame | null {
    return this.still.best;
  }

  idle() {
    this.mode = "idle";
    this.resetDecoder();
  }

  close() {
    this.mode = "idle";
    this.resetDecoder();
    this.releaseStill();
    try {
      this.decoder?.close();
    } catch {
      /* already closed */
    }
    this.decoder = null;
  }
}
