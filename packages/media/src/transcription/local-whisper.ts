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
    // Window: 30 s / 5 s overlap for the large model (benchmarked 2026-10-19 on a real 63 s take:
    // fastest, the most words recovered, fully punctuated, no merge glitch); 25 s / 5 s for the
    // small English exports, where a 30 s window broke word timestamps (2026-10-17). If a result
    // ever comes back word-starved (a merge failure), the other window is tried and the fuller
    // transcript kept.
    const windows = this.model.includes("large") ? [30, WHISPER_CHUNK_SECONDS] : [WHISPER_CHUNK_SECONDS, 20];
    const run = (chunk: number) =>
      asr(audio, {
        return_timestamps: "word",
        chunk_length_s: chunk,
        stride_length_s: 5,
        // Multilingual exports: Chris speaks English — never let a window auto-detect otherwise.
        ...(this.model.includes(".en") ? {} : { language: "en", task: "transcribe" }),
      });
    let out = await run(windows[0]!);
    let words = normalizeWhisperChunks(out.chunks ?? [], durationSeconds);
    if (durationSeconds > 20 && words.length / durationSeconds < 1.2) {
      const retry = await run(windows[1]!);
      const retryWords = normalizeWhisperChunks(retry.chunks ?? [], durationSeconds);
      if (retryWords.length > words.length) {
        out = retry;
        words = retryWords;
      }
    }
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
