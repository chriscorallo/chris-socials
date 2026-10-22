import type { OcrFrame } from "./text-events";

/**
 * How the reference analysis reads on-screen text: an adapter so the job runs with tesseract.js
 * (ocr.ts, node) in the worker and the sandbox, with a fake in tests, and with nothing at all
 * when OCR is unavailable (the rest of the measurement stands; `screen` is null and says so).
 */
export interface OcrAdapter {
  /** A short label stored with the measurement ("tesseract.js 5 · 3 fps"). */
  readonly method: string;
  /** False = don't try (no language data, no binary); the job records why. */
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** OCR of frames sampled through the video at `fps` (capped at `maxFrames`), in time order. */
  recognizeFrames(videoPath: string, options: { fps: number; maxFrames: number; durationS: number; onProgress?: (done: number, total: number) => void }): Promise<OcrFrame[]>;
}
