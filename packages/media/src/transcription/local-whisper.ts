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

export const DEFAULT_TRANSCRIPTION_MODEL = "onnx-community/whisper-base.en_timestamped";
export const WHISPER_SAMPLE_RATE = 16000;

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
    const out = await asr(audio, {
      return_timestamps: "word",
      // Long takes: 30 s windows with 5 s overlap, merged by transformers.js.
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const words = normalizeWhisperChunks(out.chunks ?? [], durationSeconds);
    const text = out.text.trim() || words.map((w) => w.word).join(" ");
    return {
      text,
      language: this.model.includes(".en") ? "en" : null,
      durationSeconds,
      words,
      model: this.model,
    };
  }
}
