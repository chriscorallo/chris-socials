/**
 * Editor preview assets — PURE planning shared by the worker (preview-proxy.ts) and the
 * browser editor (filmstrip tiles, waveform). See preview-proxy.ts for what they are and why.
 */
export const PROXY_MAX_LONG = 1280;
export const PROXY_MAX_SHORT = 720;
export const PROXY_MAX_FPS = 30;
export const PROXY_KEYFRAME_S = 0.5;
export const PROXY_VIDEO_KBPS = 2500;
export const FILMSTRIP_TILE_H = 120;
export const FILMSTRIP_MAX_TILES = 120;
export const FILMSTRIP_COLS = 10;
export const PEAKS_PER_SECOND = 20;

export interface PreviewPlan {
  proxy: { width: number; height: number; fps: number; gopFrames: number; videoKbps: number };
  filmstrip: { count: number; step: number; cols: number; rows: number; tileW: number; tileH: number };
}

/** Even dimensions that fit the source inside 720x1280 (or 1280x720), never upscaled. */
export function proxySize(src: { width: number; height: number }): { width: number; height: number } {
  const portrait = src.height >= src.width;
  const maxW = portrait ? PROXY_MAX_SHORT : PROXY_MAX_LONG;
  const maxH = portrait ? PROXY_MAX_LONG : PROXY_MAX_SHORT;
  const k = Math.min(1, maxW / src.width, maxH / src.height);
  const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));
  return { width: even(src.width * k), height: even(src.height * k) };
}

export function planPreviewAssets(src: { width: number; height: number; fps: number | null; durationSeconds: number }): PreviewPlan {
  const { width, height } = proxySize(src);
  const fps = Math.min(PROXY_MAX_FPS, src.fps && src.fps > 0 ? Math.round(src.fps * 1000) / 1000 : 30);
  const gopFrames = Math.max(1, Math.round(fps * PROXY_KEYFRAME_S));
  const dur = Math.max(0.1, src.durationSeconds);
  const count = Math.max(1, Math.min(FILMSTRIP_MAX_TILES, Math.ceil(dur)));
  const step = dur / count;
  const tileH = FILMSTRIP_TILE_H;
  const tileW = 2 * Math.round((tileH * (width / height)) / 2);
  const cols = Math.min(FILMSTRIP_COLS, count);
  const rows = Math.ceil(count / cols);
  return { proxy: { width, height, fps, gopFrames, videoKbps: PROXY_VIDEO_KBPS }, filmstrip: { count, step, cols, rows, tileW, tileH } };
}

/** Which tile of the sprite shows source time `t` (tile i covers [i*step, (i+1)*step)). */
export function filmstripTileAt(f: PreviewPlan["filmstrip"], t: number): { index: number; x: number; y: number } {
  const index = Math.max(0, Math.min(f.count - 1, Math.floor(t / f.step)));
  return { index, x: (index % f.cols) * f.tileW, y: Math.floor(index / f.cols) * f.tileH };
}

/** Peak envelope from mono s16le PCM: max |sample| per window, scaled 0–255. */
export function peaksFromPcm(pcm: Int16Array, sampleRate: number, perSecond = PEAKS_PER_SECOND): number[] {
  const win = Math.max(1, Math.round(sampleRate / perSecond));
  const out: number[] = [];
  for (let i = 0; i < pcm.length; i += win) {
    let m = 0;
    const end = Math.min(pcm.length, i + win);
    for (let j = i; j < end; j++) {
      const v = Math.abs(pcm[j]!);
      if (v > m) m = v;
    }
    out.push(Math.min(255, Math.round((m / 32768) * 255)));
  }
  return out;
}

