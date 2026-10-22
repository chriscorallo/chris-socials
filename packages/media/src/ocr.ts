import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FFMPEG_PATH } from "./ffmpeg-paths";
import type { OcrAdapter } from "./reference/ocr-adapter";
import type { OcrFrame, OcrWord } from "./reference/text-events";

/**
 * On-screen text with tesseract.js (pure WASM — the same code runs on the Mac and in the
 * sandbox, no system package). Frames are sampled with one ffmpeg pass (grey, 540 px wide), each
 * read in sparse-text mode; words come back with boxes and confidence as frame fractions. The
 * English model (tessdata_fast, gzipped) is looked for in packages/media/assets/models/tesseract
 * (the snapshot downloads it; TESSERACT_LANG_PATH overrides) — without it, or without the
 * package installed, `available()` says why and the reference measurement skips the screen.
 *
 * tesseract.js is loaded by name at runtime (not a static import) so a machine without it still
 * type-checks and runs everything else.
 */
const LANG = "eng";

export function resolveTesseractLangPath(): string | null {
  const candidates: string[] = [];
  if (process.env.TESSERACT_LANG_PATH) candidates.push(process.env.TESSERACT_LANG_PATH);
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "models", "tesseract"));
  } catch {
    // bundled
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, "packages", "media", "assets", "models", "tesseract"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates.find((c) => existsSync(join(c, `${LANG}.traineddata.gz`)) || existsSync(join(c, `${LANG}.traineddata`))) ?? null;
}

interface TessWorker {
  setParameters(p: Record<string, string | number>): Promise<unknown>;
  recognize(image: string, opts?: Record<string, unknown>, output?: Record<string, boolean>): Promise<{ data: TessData }>;
  terminate(): Promise<unknown>;
}
interface TessWordRaw {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
interface TessData {
  words?: TessWordRaw[];
  blocks?: Array<{ paragraphs: Array<{ lines: Array<{ words: TessWordRaw[] }> }> }> | null;
}

async function loadTesseract(): Promise<{ createWorker: (lang: string, oem: number, opts: Record<string, unknown>) => Promise<TessWorker>; PSM: Record<string, string> } | null> {
  try {
    const name = "tesseract.js";
    const mod = (await import(/* @vite-ignore */ name)) as Record<string, unknown>;
    const m = (mod.default ?? mod) as Record<string, unknown>;
    const createWorker = (m.createWorker ?? mod.createWorker) as ((lang: string, oem: number, opts: Record<string, unknown>) => Promise<TessWorker>) | undefined;
    const PSM = (m.PSM ?? mod.PSM) as Record<string, string> | undefined;
    if (!createWorker) return null;
    return { createWorker, PSM: PSM ?? { SPARSE_TEXT: "11" } };
  } catch {
    return null;
  }
}

/** One ffmpeg pass: grey frames at `fps`, 540 px wide, as PNGs in `dir`. Returns the frame times. */
async function sampleFrames(videoPath: string, dir: string, fps: number, maxFrames: number): Promise<Array<{ t: number; path: string }>> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-i", videoPath, "-an", "-sn", "-vf", `fps=${fps},scale=540:-2,format=gray`, "-frames:v", String(maxFrames), join(dir, "f-%05d.png")]);
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg frame sampling failed (${code}): ${stderr.slice(-400)}`))));
  });
  const files = (await readdir(dir)).filter((f) => f.startsWith("f-") && f.endsWith(".png")).sort();
  return files.map((f, i) => ({ t: Math.round((i / fps) * 1000) / 1000, path: join(dir, f) }));
}

export class TesseractJsOcr implements OcrAdapter {
  readonly method: string;
  constructor(private readonly fpsLabel = 3) {
    this.method = `tesseract.js · ${fpsLabel} fps · 540 px grey`;
  }

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!(await loadTesseract())) return { ok: false, reason: "tesseract.js is not installed" };
    if (!resolveTesseractLangPath()) return { ok: false, reason: "no English model (packages/media/assets/models/tesseract/eng.traineddata.gz)" };
    return { ok: true };
  }

  async recognizeFrames(videoPath: string, options: { fps: number; maxFrames: number; durationS: number; onProgress?: (done: number, total: number) => void }): Promise<OcrFrame[]> {
    const tess = await loadTesseract();
    const langPath = resolveTesseractLangPath();
    if (!tess || !langPath) throw new Error("OCR unavailable");
    const dir = await mkdtemp(join(tmpdir(), "chris-ocr-"));
    let worker: TessWorker | null = null;
    try {
      const frames = await sampleFrames(videoPath, dir, options.fps, options.maxFrames);
      worker = await tess.createWorker(LANG, 1, { langPath, cachePath: langPath, gzip: true, cacheMethod: "readOnly", logger: () => undefined, errorHandler: () => undefined });
      await worker.setParameters({ tessedit_pageseg_mode: tess.PSM.SPARSE_TEXT ?? "11", preserve_interword_spaces: "1" });
      const out: OcrFrame[] = [];
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i]!;
        const { data } = await worker.recognize(f.path, {}, { blocks: true, text: false });
        const raw: TessWordRaw[] = data.words ?? (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
        // Frame size: 540 wide; height from the PNG is not needed — boxes come in pixels of the
        // sampled frame, so normalise by its own size (read once from the first word's bbox range
        // is wrong; use the known width and the aspect of the source via ffprobe-free estimate).
        const words = normalise(raw, 540, this.frameHeight ?? (await this.measureHeight(f.path)));
        out.push({ t: f.t, words });
        options.onProgress?.(i + 1, frames.length);
      }
      return out;
    } finally {
      await worker?.terminate().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }

  private frameHeight: number | null = null;
  private async measureHeight(png: string): Promise<number> {
    const { readFile } = await import("node:fs/promises");
    const b = await readFile(png);
    // PNG IHDR: width at 16..19, height at 20..23 (big-endian).
    const h = b.length >= 24 ? b.readUInt32BE(20) : 960;
    this.frameHeight = h || 960;
    return this.frameHeight;
  }
}

function normalise(raw: TessWordRaw[], w: number, h: number): OcrWord[] {
  const out: OcrWord[] = [];
  for (const r of raw) {
    const text = (r.text ?? "").trim();
    if (!text) continue;
    const bw = r.bbox.x1 - r.bbox.x0;
    const bh = r.bbox.y1 - r.bbox.y0;
    if (bw <= 0 || bh <= 0) continue;
    out.push({ text, conf: Math.max(0, Math.min(100, r.confidence ?? 0)), x: r.bbox.x0 / w, y: r.bbox.y0 / h, w: bw / w, h: bh / h });
  }
  return out;
}
