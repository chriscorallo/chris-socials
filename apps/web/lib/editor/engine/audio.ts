import type { Mp4Track } from "./mp4";
import type { MediaBytes } from "./media-bytes";
import type { AudioPiece } from "./plan";

/**
 * The compositor's sound: each take's AAC track (from the same proxy bytes the video comes
 * from) decoded to PCM in ~4 s chunks as the bytes arrive, and played through ONE AudioContext
 * whose clock is the editor's master clock. Every clip of the edit becomes buffer sources
 * scheduled at exact context times, so a cut is sample-accurate and nothing restarts at a cut
 * (the old engine swapped <video> elements and their sound with them).
 *
 * Decoding works everywhere (iOS 15+): AAC frames are wrapped as ADTS and handed to
 * decodeAudioData (AudioDecoder only exists on iOS 26+). Each chunk is decoded with 2 frames
 * of pre-roll that are then dropped, so the MDCT overlap is rebuilt and chunks join cleanly.
 */

export const CHUNK_FRAMES = 188; // ≈ 4 s of AAC at 48 kHz
const PREROLL = 2;
const SFI = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export interface PcmChunk {
  /** source seconds of the chunk's first sample */
  src: number;
  buffer: AudioBuffer;
}

/** ADTS header for one raw AAC frame (pure — tested). */
export function adtsHeader(frameLen: number, objectType: number, sampleRate: number, channels: number): Uint8Array {
  const sfi = Math.max(0, SFI.indexOf(sampleRate));
  const len = frameLen + 7;
  const profile = Math.max(0, Math.min(3, objectType - 1));
  return new Uint8Array([0xff, 0xf1, (profile << 6) | (sfi << 2) | ((channels >> 2) & 1), ((channels & 3) << 6) | ((len >> 11) & 3), (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc]);
}

export class TakeAudio {
  readonly media: MediaBytes;
  readonly track: Mp4Track;
  chunks: PcmChunk[] = [];
  /** next AAC frame index to decode */
  private next = 0;
  private busy = false;
  failed: string | null = null;

  constructor(media: MediaBytes, track: Mp4Track) {
    this.media = media;
    this.track = track;
  }

  /** Source seconds decoded contiguously from 0. */
  decodedUntil(): number {
    if (!this.chunks.length) return 0;
    const last = this.chunks[this.chunks.length - 1]!;
    return last.src + last.buffer.duration;
  }

  get complete(): boolean {
    return this.next >= this.track.count;
  }

  /** Decodes the next chunk if its bytes are here. Call often; one decode at a time. */
  pump(ctx: BaseAudioContext) {
    if (this.busy || this.failed || this.complete) return;
    const t = this.track;
    const i0 = this.next;
    const i1 = Math.min(t.count, i0 + CHUNK_FRAMES);
    const last = i1 - 1;
    if (!this.media.has(t.offsets[last]!, t.sizes[last]!)) return;
    const pre = Math.min(PREROLL, i0);
    const objectType = t.description?.length ? t.description[0]! >> 3 : 2;
    let total = 0;
    for (let i = i0 - pre; i < i1; i++) total += t.sizes[i]! + 7;
    const adts = new Uint8Array(total);
    let o = 0;
    for (let i = i0 - pre; i < i1; i++) {
      const size = t.sizes[i]!;
      adts.set(adtsHeader(size, objectType, t.sampleRate, t.channels), o);
      adts.set(this.media.slice(t.offsets[i]!, size), o + 7);
      o += size + 7;
    }
    this.busy = true;
    const frames = i1 - (i0 - pre);
    const done = (buf: AudioBuffer) => {
      this.busy = false;
      const rate = buf.sampleRate;
      const perFrame = (1024 * rate) / t.sampleRate;
      // Decoders that trim the encoder delay themselves output fewer samples than frames×1024;
      // treat the shortfall as trimmed from the start (measured per chunk).
      const trim = Math.max(0, Math.round(frames * perFrame - buf.length));
      const j0 = Math.max(0, Math.round(pre * perFrame) - trim);
      const len = Math.max(1, buf.length - j0);
      const out = new AudioBuffer({ length: len, numberOfChannels: buf.numberOfChannels, sampleRate: rate });
      for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(j0, j0 + len), c);
      // decoded sample G ↔ media time G/rate − editShift/trackRate
      const g0 = (i0 - pre) * perFrame + trim + j0;
      const src = g0 / rate - t.editShift / t.timescale;
      this.chunks.push({ src, buffer: out });
      this.next = i1;
    };
    void ctx.decodeAudioData(adts.buffer.slice(0) as ArrayBuffer).then(done, (e: unknown) => {
      this.busy = false;
      this.failed = e instanceof Error ? e.message : String(e);
    });
  }

  /** The chunks overlapping source span [a, b). */
  chunksFor(a: number, b: number): PcmChunk[] {
    return this.chunks.filter((c) => c.src < b && c.src + c.buffer.duration > a);
  }
}

/**
 * Schedules audio pieces on a context: one gain node per piece (cut ramps), one buffer source
 * per (piece × chunk). Keeps the nodes so pause/seek can stop them.
 */
export class AudioScheduler {
  private nodes: Array<{ src: AudioBufferSourceNode; gain: GainNode; end: number }> = [];
  /** piece keys already scheduled (`${seg}:${chunkSrc}`) */
  private done = new Set<string>();

  constructor(
    private ctx: AudioContext,
    private out: AudioNode,
  ) {}

  /**
   * Schedules `piece` (output time ↦ context time via `toCtx`), using whatever chunks are
   * decoded. Returns false if a needed chunk isn't decoded yet (caller may wait).
   */
  schedule(key: string, piece: AudioPiece, take: TakeAudio, toCtx: (out: number) => number): boolean {
    const a = piece.srcStart;
    const b = piece.srcStart + piece.duration;
    let covered = a;
    const chunks = take.chunksFor(a, b);
    for (const c of chunks) {
      const k = `${key}:${c.src.toFixed(4)}`;
      const from = Math.max(a, c.src);
      const to = Math.min(b, c.src + c.buffer.duration);
      if (to - from < 1e-4) continue;
      covered = Math.max(covered, to);
      if (this.done.has(k)) continue;
      const when = toCtx(piece.outStart + (from - a));
      const now = this.ctx.currentTime;
      let offset = from - c.src;
      let dur = to - from;
      let at = when;
      if (at < now) {
        // late (just started / seek): skip into the chunk instead of playing late
        const late = now - at;
        if (late >= dur) {
          this.done.add(k);
          continue;
        }
        offset += late;
        dur -= late;
        at = now;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = c.buffer;
      const g = this.ctx.createGain();
      const pieceStartCtx = toCtx(piece.outStart);
      const pieceEndCtx = toCtx(piece.outStart + piece.duration);
      const gainV = piece.gain;
      g.gain.setValueAtTime(gainV, at);
      if (piece.fadeIn > 0 && at < pieceStartCtx + piece.fadeIn) {
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(gainV, pieceStartCtx + piece.fadeIn);
      }
      if (piece.fadeOut > 0 && at + dur > pieceEndCtx - piece.fadeOut - 1e-4) {
        g.gain.setValueAtTime(gainV, Math.max(at, pieceEndCtx - piece.fadeOut));
        g.gain.linearRampToValueAtTime(0, pieceEndCtx);
      }
      src.connect(g).connect(this.out);
      src.start(at, offset, dur);
      this.nodes.push({ src, gain: g, end: at + dur });
      this.done.add(k);
    }
    return covered >= b - 1e-3 || take.complete;
  }

  /** Forget finished nodes. */
  gc() {
    const now = this.ctx.currentTime;
    this.nodes = this.nodes.filter((n) => {
      if (n.end < now - 0.5) {
        try {
          n.src.disconnect();
          n.gain.disconnect();
        } catch {
          /* gone */
        }
        return false;
      }
      return true;
    });
  }

  stopAll() {
    for (const n of this.nodes) {
      try {
        n.src.stop();
        n.src.disconnect();
        n.gain.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.nodes = [];
    this.done.clear();
  }
}
