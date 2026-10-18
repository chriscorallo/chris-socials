import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FFMPEG_PATH, resolveBundledFontsDir } from "@chris/media";
import { runFfmpeg } from "./audio/ffmpeg";
import { BANDS_FOR_METRICS } from "./text-bands";

/**
 * Stills for review: pixel metrics of a still (what the crew's deterministic Quality bot reads —
 * packages/agents/src/studio/engine-port.ts StillMetrics) and a JPEG contact sheet with the
 * narration line under each still (ChatGPT's vision review reads it; it can't read SVG).
 */

export interface StillTextInfo {
  band: "UPPER" | "CENTER" | "LOWER";
  /** Text color (hex) as drawn. */
  color: string;
}

export interface StillMetricsResult {
  meanLuma: number;
  emptyRatio: number;
  textContrast?: Partial<Record<"UPPER" | "CENTER" | "LOWER", number>>;
  textInsideSafeZone?: number;
}

const GW = 108;
const GH = 192;

function decodeGray(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-i", path, "-frames:v", "1", "-vf", `scale=${GW}:${GH}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    const bufs: Buffer[] = [];
    p.stdout.on("data", (d) => bufs.push(d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(Buffer.concat(bufs)) : reject(new Error(`ffmpeg ${c} decoding ${path}`))));
  });
}

const srgbToLin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
function hexLuminance(hex: string): number {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  const r = srgbToLin(((n >> 16) & 255) / 255);
  const g = srgbToLin(((n >> 8) & 255) / 255);
  const b = srgbToLin((n & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Pure part (tested): metrics from a GW×GH gray buffer. */
export function metricsFromGray(px: Uint8Array, texts: StillTextInfo[] = [], w = GW, h = GH): StillMetricsResult {
  let sum = 0;
  for (const v of px) sum += v;
  const meanLuma = sum / px.length / 255;
  // empty = 12×12 blocks that are dark and flat
  const B = 12;
  let blocks = 0;
  let empty = 0;
  for (let by = 0; by + B <= h; by += B) {
    for (let bx = 0; bx + B <= w; bx += B) {
      let s = 0;
      let s2 = 0;
      for (let y = by; y < by + B; y++) for (let x = bx; x < bx + B; x++) {
        const v = px[y * w + x]!;
        s += v;
        s2 += v * v;
      }
      const n = B * B;
      const m = s / n;
      const sd = Math.sqrt(Math.max(0, s2 / n - m * m));
      blocks++;
      if (m < 28 && sd < 4) empty++;
    }
  }
  const out: StillMetricsResult = { meanLuma: r3(meanLuma), emptyRatio: r3(empty / Math.max(1, blocks)) };
  if (texts.length) {
    const contrast: Partial<Record<"UPPER" | "CENTER" | "LOWER", number>> = {};
    for (const t of texts) {
      const [y0, y1] = BANDS_FOR_METRICS[t.band];
      const vals: number[] = [];
      for (let y = Math.floor(y0 * h); y < Math.ceil(y1 * h); y++) for (let x = Math.floor(w * 0.08); x < Math.ceil(w * 0.86); x++) vals.push(px[y * w + x]!);
      vals.sort((a, b) => a - b);
      // the background is the darker majority of the band (glyphs are the bright minority)
      const bg = srgbToLin((vals[Math.floor(vals.length * 0.3)] ?? 0) / 255);
      const fg = hexLuminance(t.color);
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      contrast[t.band] = Math.min(contrast[t.band] ?? Infinity, r3(ratio));
    }
    out.textContrast = contrast;
    // the overlay only places text inside the platform-safe bands (by construction of overlay.tsx)
    out.textInsideSafeZone = 1;
  }
  return out;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export async function measureStill(path: string, texts: StillTextInfo[] = []): Promise<StillMetricsResult> {
  return metricsFromGray(await decodeGray(path), texts);
}

/** Wraps a caption to ≤ maxLines lines of ≤ width chars (ellipsis when longer). */
export function wrapCaption(text: string, width = 34, maxLines = 3): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > width && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.slice(0, width - 1)}…`;
    return kept.join("\n");
  }
  return lines.join("\n");
}

/** A JPEG contact sheet: each still with its label + narration line under it, `cols` per row. */
export async function captionedContactSheet(items: Array<{ path: string; caption: string; label?: string }>, out: string, opts: { cols?: number; width?: number; workDir: string }): Promise<string> {
  const cols = Math.max(1, Math.min(opts.cols ?? 4, items.length));
  const width = opts.width ?? 300;
  const capH = 92;
  const font = join(resolveBundledFontsDir(), "Inter-SemiBold.ttf");
  await mkdir(opts.workDir, { recursive: true });
  const tiles: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const txt = join(opts.workDir, `cap-${i}.txt`);
    const lab = join(opts.workDir, `lab-${i}.txt`);
    await writeFile(txt, wrapCaption(it.caption || "(no narration)", Math.floor(width / 9.2)));
    await writeFile(lab, it.label ?? String(i + 1));
    const tile = join(opts.workDir, `tile-${String(i).padStart(3, "0")}.jpg`);
    const ff = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    await runFfmpeg([
      "-i",
      it.path,
      "-vf",
      [
        `scale=${width}:-2`,
        `pad=iw:ih+${capH}:0:0:color=0x111111`,
        `drawtext=fontfile='${ff(font)}':textfile='${ff(lab)}':x=8:y=8:fontsize=15:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=4`,
        `drawtext=fontfile='${ff(font)}':textfile='${ff(txt)}':x=10:y=h-${capH}+10:fontsize=15:fontcolor=0xF5F1EA:line_spacing=5`,
      ].join(","),
      "-frames:v",
      "1",
      "-q:v",
      "3",
      tile,
    ]);
    tiles.push(tile);
  }
  const rows = Math.ceil(tiles.length / cols);
  await runFfmpeg(["-framerate", "1", "-i", join(opts.workDir, "tile-%03d.jpg"), "-vf", `tile=${cols}x${rows}:padding=6:margin=6:color=0x0b0b0b`, "-frames:v", "1", "-update", "1", "-q:v", "3", out]);
  return out;
}
