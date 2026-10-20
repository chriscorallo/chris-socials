import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { FFMPEG_PATH } from "../ffmpeg-paths";
import type { TranscriptWord } from "../captions";

/**
 * Local, credential-free transcription: Whisper running in-process via transformers.js
 * (ONNX Runtime on CPU). No API key, no network after the first model download.
 *
 * Structurally implements packages/agents' `TranscriptionProvider` (`transcribe(filePath)`
 * returning `{ text, language, durationSeconds, words }`) without importing it — packages/media
 * and packages/agents deliberately don't depend on each other (see /docs/ARCHITECTURE.md).
 *
 * Lives behind the `@chris/media/transcription` subpath (not the package root) so code that
 * only needs probing/rendering never loads transformers.js/onnxruntime.
 */

/** 2026-10-19: large-v3-turbo — benchmarked on a real 63 s take (8 vCPU, fp32): base.en 7.8 s
 * but 10% of words wrong vs this model ("saver" → "savior", "So, anyway" → "So, a name"),
 * small.en 21 s / 9%, medium.en 47 s / 6% with a bad timestamp, large-v3-turbo 30 s, clean
 * punctuation and sentence breaks. Every editing bot works from these words. See DECISIONS. */
export const DEFAULT_TRANSCRIPTION_MODEL = "onnx-community/whisper-large-v3-turbo_timestamped";
export const WHISPER_SAMPLE_RATE = 16000;
/** Long-audio window (s) — must stay below 30 (see transcribe()). */
export const WHISPER_CHUNK_SECONDS = 25;

/**
 * Where to cut a long take so each piece is transcribed on its own (no overlap-merging, which
 * drops or mangles words at the seams — "$5,000 a month" came back "$5 month" on 2026-10-19):
 * the quietest 150 ms between `minS` and `maxS` after the last cut (a real silence wins; else
 * quieter-and-later), measured on 20 ms RMS frames. Pure; returns piece boundaries in samples.
 */
export function quietSplitPoints(audio: Float32Array, sampleRate: number, opts: { minS?: number; maxS?: number } = {}): Array<{ start: number; end: number }> {
  const minS = opts.minS ?? 14;
  const maxS = opts.maxS ?? 26;
  const frame = Math.round(sampleRate * 0.02);
  const n = Math.floor(audio.length / frame);
  const rms = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let acc = 0;
    const o = f * frame;
    for (let i = 0; i < frame; i++) acc += audio[o + i]! * audio[o + i]!;
    rms[f] = Math.sqrt(acc / frame);
  }
  const win = Math.max(1, Math.round(0.15 / 0.02)); // 150 ms = ~7 frames
  const out: Array<{ start: number; end: number }> = [];
  let start = 0;
  const total = audio.length;
  while (total - start > maxS * sampleRate) {
    // Anywhere between minS and maxS after the last cut; a real silence (energy ≈ 0) wins
    // wherever it is, otherwise the quieter AND later point (longer pieces, fewer seams).
    const lo = Math.floor((start + minS * sampleRate) / frame);
    const hi = Math.floor((start + maxS * sampleRate) / frame) - win;
    let best = -1;
    let bestE = Infinity;
    for (let f = Math.max(lo, 0); f <= hi; f++) {
      let e = 0;
      for (let k = 0; k < win; k++) e += rms[f + k]!;
      const early = (hi - f) / Math.max(1, hi - lo);
      const score = e * (1 + 0.6 * early);
      if (score < bestE) {
        bestE = score;
        best = f;
      }
    }
    if (best < 0) break;
    const cut = (best + Math.floor(win / 2)) * frame;
    out.push({ start, end: cut });
    start = cut;
  }
  out.push({ start, end: total });
  return out;
}

export interface LocalTranscriptionResult {
  text: string;
  language: string | null;
  durationSeconds: number;
  words: TranscriptWord[];
  model: string;
}

export interface LocalWhisperOptions {
  /** HF model id; must be an export with cross-attentions (the `_timestamped` variants) for
   * word timestamps. Default: env TRANSCRIPTION_MODEL, else DEFAULT_TRANSCRIPTION_MODEL. */
  model?: string;
  /** Model cache directory. Default: env TRANSCRIPTION_CACHE_DIR, else `<repo>/.cache/transformers`. */
  cacheDir?: string;
  /** ONNX weight precision. fp32 is the accurate default for word timing; q8 is ~4x smaller. */
  dtype?: "fp32" | "fp16" | "q8" | "q4";
  /** Disallow network model downloads (cache must already be populated). */
  offline?: boolean;
}

function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolveTranscriptionCacheDir(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.TRANSCRIPTION_CACHE_DIR) return process.env.TRANSCRIPTION_CACHE_DIR;
  const root = findRepoRoot(process.cwd());
  return root ? join(root, ".cache", "transformers") : join(process.cwd(), ".cache", "transformers");
}

/** Decodes any audio/video file's first audio stream to 16 kHz mono float32 PCM. */
export function extractAudioPcm16k(filePath: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filePath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(WHISPER_SAMPLE_RATE),
      "-f",
      "f32le",
      "-",
    ]);
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg audio extraction failed (code ${code}): ${stderr.slice(-1000)}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      // Copy into an aligned ArrayBuffer (Buffer pool slices aren't guaranteed 4-byte aligned).
      const aligned = new ArrayBuffer(buf.byteLength - (buf.byteLength % 4));
      new Uint8Array(aligned).set(buf.subarray(0, aligned.byteLength));
      resolve(new Float32Array(aligned));
    });
  });
}

interface WhisperChunk {
  text: string;
  timestamp: [number | null, number | null];
}

/**
 * Turns transformers.js word chunks into clean words. Whisper emits sub-word continuations
 * without a leading space (" 50" then "%"), which belong to the previous word; timestamps
 * can be null at the very end of a stream. Pure + exported for tests.
 */
export function normalizeWhisperChunks(
  chunks: WhisperChunk[],
  audioDurationSeconds: number,
): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const c of chunks) {
    const raw = c.text ?? "";
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const [s, e] = c.timestamp;
    const start = s ?? words[words.length - 1]?.end ?? 0;
    let end = e ?? Math.min(audioDurationSeconds, start + 0.3);
    if (end < start) end = start;
    const prev = words[words.length - 1];
    const isContinuation = prev != null && !/^\s/.test(raw);
    if (isContinuation) {
      prev.word += trimmed;
      prev.end = Math.max(prev.end, end);
    } else {
      words.push({ word: trimmed, start, end });
    }
  }
  return words.map((w) => ({
    word: w.word,
    start: Math.round(w.start * 1000) / 1000,
    end: Math.round(w.end * 1000) / 1000,
  }));
}

type AsrPipeline = ((
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ text: string; chunks?: WhisperChunk[] }>) & { dispose?: () => Promise<void> };

const pipelineCache = new Map<string, Promise<AsrPipeline>>();

export class LocalWhisperTranscriptionProvider {
  readonly model: string;
  readonly cacheDir: string;
  readonly dtype: NonNullable<LocalWhisperOptions["dtype"]>;
  readonly offline: boolean;

  constructor(options: LocalWhisperOptions = {}) {
    this.model = options.model ?? process.env.TRANSCRIPTION_MODEL ?? DEFAULT_TRANSCRIPTION_MODEL;
    this.cacheDir = resolveTranscriptionCacheDir(options.cacheDir);
    this.dtype = options.dtype ?? "fp32";
    this.offline = options.offline ?? false;
  }

  private loadPipeline(): Promise<AsrPipeline> {
    const key = `${this.model}|${this.dtype}|${this.cacheDir}`;
    let p = pipelineCache.get(key);
    if (!p) {
      p = (async () => {
        // Dynamic import: keeps onnxruntime-node out of every process that merely imports
        // @chris/media/transcription types, and lets a failed native load surface as a normal
        // rejected promise the caller can degrade from.
        const { pipeline, env } = await import("@huggingface/transformers");
        env.cacheDir = this.cacheDir;
        env.allowRemoteModels = !this.offline;
        const asr = await pipeline("automatic-speech-recognition", this.model, {
          dtype: this.dtype,
        });
        return asr as unknown as AsrPipeline;
      })();
      p.catch(() => pipelineCache.delete(key));
      pipelineCache.set(key, p);
    }
    return p;
  }

  async transcribe(filePath: string): Promise<LocalTranscriptionResult> {
    const audio = await extractAudioPcm16k(filePath);
    const durationSeconds = audio.length / WHISPER_SAMPLE_RATE;
    if (audio.length === 0) {
      return { text: "", language: "en", durationSeconds: 0, words: [], model: this.model };
    }
    const asr = await this.loadPipeline();
    // Each take is cut at the quietest moment of every ~25 s span and the pieces are transcribed
    // on their own (≤ 30 s = Whisper's native input, so no overlap-merging and none of its
    // dropped/mangled words at the seams — see quietSplitPoints). Timings are offset per piece.
    const lang = this.model.includes(".en") ? {} : { language: "en" as const, task: "transcribe" as const };
    const pieces = quietSplitPoints(audio, WHISPER_SAMPLE_RATE);
    const chunks: WhisperChunk[] = [];
    const texts: string[] = [];
    for (const piece of pieces) {
      const part = audio.subarray(piece.start, piece.end);
      if (part.length < WHISPER_SAMPLE_RATE * 0.3) continue;
      const res = await asr(part, { return_timestamps: "word", ...lang });
      const offset = piece.start / WHISPER_SAMPLE_RATE;
      for (const c of res.chunks ?? []) {
        const t = c.timestamp as [number | null, number | null] | undefined;
        chunks.push({ ...c, timestamp: [t?.[0] == null ? null : t[0] + offset, t?.[1] == null ? null : t[1] + offset] as never });
      }
      if (res.text?.trim()) texts.push(res.text.trim());
    }
    const out = { text: texts.join(" "), chunks };
    const words = normalizeWhisperChunks(out.chunks ?? [], durationSeconds);
    const text = out.text.trim() || words.map((w) => w.word).join(" ");
    return {
      text,
      language: "en",
      durationSeconds,
      words,
      model: this.model,
    };
  }
}
