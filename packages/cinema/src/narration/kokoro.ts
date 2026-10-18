import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveTranscriptionCacheDir } from "@chris/media/transcription";
import { DEFAULT_SENTENCE_PAUSE, splitForSpeech } from "./speech-text";

/**
 * Local narration with Kokoro-82M (open weights, Apache-2.0 — hexgrad/Kokoro-82M; ONNX export
 * onnx-community/Kokoro-82M-v1.0-ONNX) through kokoro-js (Apache-2.0) on onnxruntime-node (CPU).
 * $0, no API key; the model (~330 MB fp32 / ~90 MB q8) downloads once into the same cache the
 * local Whisper uses (TRANSCRIPTION_CACHE_DIR / <repo>/.cache/transformers).
 *
 * Text → phonemes goes through `phonemizer` (eSpeak NG compiled to WASM). eSpeak NG is
 * GPL-3.0: we only RUN it on our own machines/sandbox (no distribution), and generated audio
 * is not a derivative of the program — see docs/decisions-pending/mini-movies.md.
 */

export const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_SAMPLE_RATE = 24000;

export interface KokoroOptions {
  dtype?: "fp32" | "fp16" | "q8" | "q4";
  cacheDir?: string;
}

interface KokoroLike {
  generate(text: string, opts: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

let ttsPromise: Promise<KokoroLike> | null = null;
let ttsKey = "";

export async function loadKokoro(opts: KokoroOptions = {}): Promise<KokoroLike> {
  const dtype = opts.dtype ?? (process.env.KOKORO_DTYPE as KokoroOptions["dtype"]) ?? "q8";
  const key = `${dtype}|${opts.cacheDir ?? ""}`;
  if (ttsPromise && ttsKey === key) return ttsPromise;
  ttsKey = key;
  ttsPromise = (async () => {
    const { env } = await import("@huggingface/transformers");
    env.cacheDir = resolveTranscriptionCacheDir(opts.cacheDir);
    const { KokoroTTS } = await import("kokoro-js");
    const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype, device: "cpu" });
    return tts as unknown as KokoroLike;
  })();
  ttsPromise.catch(() => {
    ttsPromise = null;
  });
  return ttsPromise;
}

/** Trims leading/trailing near-silence (keeps `padSeconds` of air on each side). */
export function trimSilence(samples: Float32Array, sampleRate: number, padSeconds = 0.04, threshold = 0.006): Float32Array {
  const win = Math.round(sampleRate * 0.01);
  const rms = (from: number) => {
    let s = 0;
    const to = Math.min(samples.length, from + win);
    for (let i = from; i < to; i++) s += samples[i]! * samples[i]!;
    return Math.sqrt(s / Math.max(1, to - from));
  };
  let start = 0;
  while (start < samples.length && rms(start) < threshold) start += win;
  let end = samples.length;
  while (end > start && rms(Math.max(0, end - win)) < threshold) end -= win;
  const pad = Math.round(sampleRate * padSeconds);
  return samples.slice(Math.max(0, start - pad), Math.min(samples.length, end + pad));
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

export interface SynthesizedLine {
  path: string;
  durationSeconds: number;
  sampleRate: number;
}

/** Speaks one line to a WAV (silence-trimmed). Cached by path: an existing file is reused. */
/**
 * Speaks one line to a WAV (silence-trimmed). Sentences are voiced one at a time with
 * `sentencePause` seconds of silence between them, and `[pause]` / `[pause 0.6]` markers add
 * explicit beats (see speech-text.ts). Cached by path: an existing file is reused.
 */
export async function synthesizeLine(text: string, outPath: string, voice: string, speed = 1, opts: KokoroOptions & { force?: boolean; sentencePause?: number } = {}): Promise<SynthesizedLine> {
  if (!opts.force && existsSync(outPath)) {
    const { probeDurationSeconds } = await import("../audio/ffmpeg");
    return { path: outPath, durationSeconds: await probeDurationSeconds(outPath), sampleRate: KOKORO_SAMPLE_RATE };
  }
  const tts = await loadKokoro(opts);
  const segments = splitForSpeech(text, opts.sentencePause ?? DEFAULT_SENTENCE_PAUSE);
  const parts: Float32Array[] = [];
  let sr = KOKORO_SAMPLE_RATE;
  for (const seg of segments) {
    const raw = await tts.generate(seg.text, { voice, speed });
    sr = raw.sampling_rate;
    parts.push(trimSilence(raw.audio, sr, 0.03));
    if (seg.pauseAfter > 0) parts.push(new Float32Array(Math.round(seg.pauseAfter * sr)));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const audio = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    audio.set(p, o);
    o += p.length;
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, encodeWav(audio, sr));
  return { path: outPath, durationSeconds: audio.length / sr, sampleRate: sr };
}

export function lineAudioPath(dir: string, shotId: string, voice: string, speed: number, text: string, extra = ""): string {
  // content-addressed so editing a line re-synthesizes only that line
  let h = 2166136261;
  const s = `${voice}|${speed}|${text}${extra ? `|${extra}` : ""}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return join(dir, `${shotId}-${(h >>> 0).toString(16)}.wav`);
}
