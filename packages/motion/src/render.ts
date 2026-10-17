import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { resolveBundledFontsDir, type EditTimeline, type TimelineVisual, type VisualOverlaySegment } from "@chris/media";
import { resolveRemotionEntry } from "./assets";
import { parseVisuals, visualFrameWindow } from "./timing";

/**
 * Node-side renderer for the motion layer: bundles the Remotion project once (cached per
 * process), then renders visuals with alpha through Remotion's managed headless Chrome.
 *
 * Output format: ProRes 4444 (yuva444p10le) .mov — alpha that ffmpeg-static decodes and
 * overlays reliably (VP8/VP9 alpha needs the libvpx decoder forced on the input; ProRes
 * doesn't). See docs/decisions-pending/motion-engine.md.
 *
 * Strategy "PER_VISUAL" (default): one short clip per visual, only its own frames — a 45 s
 * video with 5 visuals of ~4 s renders ~600 frames instead of 1350, and the compositor
 * overlays each clip with enable= timing. "FULL_LAYER": one full-length transparent layer.
 */

export interface RenderVisualsLayerInput {
  timeline: Pick<EditTimeline, "visuals" | "canvas">;
  fps: number;
  durationSeconds: number;
  /** PER_VISUAL: a directory for the clips. FULL_LAYER: the .mov file path. */
  outputPath: string;
  concurrency?: number | null;
  strategy?: "PER_VISUAL" | "FULL_LAYER";
  /** Progress callback (0..1 over all frames). */
  onProgress?: (p: number) => void;
}

export interface RenderVisualsLayerResult {
  outputPath: string;
  framesRendered: number;
  /** What the compositor overlays (renderTimeline's `visualsLayer.segments`). */
  segments: VisualOverlaySegment[];
  /** Visuals skipped because they failed validation (never silently rendered wrong). */
  skipped: Array<{ id: string; error: string }>;
  renderMs: number;
  bundleMs: number;
}

let bundleCache: { promise: Promise<string>; ms: number } | null = null;

/** Bundle the Remotion project once per process (webpack is the slow part: ~5-15 s). */
export async function getMotionBundle(): Promise<{ serveUrl: string; ms: number; cached: boolean }> {
  if (bundleCache) return { serveUrl: await bundleCache.promise, ms: 0, cached: true };
  const started = Date.now();
  const { bundle } = await import("@remotion/bundler");
  const entry = resolveRemotionEntry();
  const publicDir = dirname(resolveBundledFontsDir()); // packages/media/assets -> fonts/<file>
  const promise = bundle({
    entryPoint: entry,
    publicDir,
    enableCaching: true,
    outDir: join(tmpdir(), `chris-motion-bundle-${process.pid}`),
  });
  bundleCache = { promise, ms: 0 };
  try {
    const url = await promise;
    bundleCache.ms = Date.now() - started;
    return { serveUrl: url, ms: bundleCache.ms, cached: false };
  } catch (err) {
    bundleCache = null;
    throw err;
  }
}

/**
 * A Chrome headless shell to render with: `REMOTION_BROWSER_EXECUTABLE` if set, else one
 * already on this machine (Puppeteer / Playwright caches), else null — then Remotion downloads
 * and manages its own (`ensureBrowser`). Saves a ~90 MB download on dev machines.
 */
export function findLocalHeadlessShell(): string | null {
  const env = process.env.REMOTION_BROWSER_EXECUTABLE;
  if (env) return existsSync(env) ? env : null;
  if (process.env.MOTION_USE_REMOTION_BROWSER === "1") return null;
  const home = homedir();
  const roots: Array<{ dir: string; rel: string[] }> = [
    { dir: join(home, ".cache", "puppeteer", "chrome-headless-shell"), rel: ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64", "chrome-headless-shell-linux64"] },
    { dir: join(home, "Library", "Caches", "ms-playwright"), rel: ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64"] },
    { dir: join(home, ".cache", "ms-playwright"), rel: ["chrome-headless-shell-linux64", "chrome-linux"] },
  ];
  for (const r of roots) {
    if (!existsSync(r.dir)) continue;
    const versions = readdirSync(r.dir).filter((d) => !d.startsWith("__") && !d.startsWith("chromium-") && !d.startsWith("ffmpeg")).sort().reverse();
    for (const v of versions) {
      for (const rel of r.rel) {
        const exe = join(r.dir, v, rel, "chrome-headless-shell");
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

function clipFile(dir: string, v: TimelineVisual, i: number): string {
  return join(dir, `visual-${String(i).padStart(2, "0")}-${v.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.mov`);
}

/**
 * Renders the timeline's visuals to alpha video. No visuals -> nothing is rendered (no
 * browser is even launched) and `segments` is empty.
 */
export async function renderVisualsLayer(input: RenderVisualsLayerInput): Promise<RenderVisualsLayerResult> {
  const started = Date.now();
  const strategy = input.strategy ?? "PER_VISUAL";
  const { parsed, errors } = parseVisuals(input.timeline.visuals ?? []);
  const totalFrames = Math.max(1, Math.round(input.durationSeconds * input.fps));
  const active = parsed.filter((pv) => visualFrameWindow(pv.visual, input.fps).from < totalFrames);
  if (active.length === 0) {
    return { outputPath: input.outputPath, framesRendered: 0, segments: [], skipped: errors, renderMs: 0, bundleMs: 0 };
  }

  const { renderMedia, selectComposition, openBrowser, ensureBrowser } = await import("@remotion/renderer");
  const { serveUrl, ms: bundleMs } = await getMotionBundle();
  const browserExecutable = findLocalHeadlessShell();
  if (!browserExecutable) await ensureBrowser();
  const browser = await openBrowser("chrome", { browserExecutable, chromiumOptions: { gl: "angle" } });
  const canvas = input.timeline.canvas ?? { width: 1080, height: 1920 };
  const common = {
    serveUrl,
    codec: "prores" as const,
    proResProfile: "4444" as const,
    pixelFormat: "yuva444p10le" as const,
    imageFormat: "png" as const,
    // Tag + convert as BT.709 so the overlay's YUV matrix matches the H.264 master's.
    colorSpace: "bt709" as const,
    muted: true,
    concurrency: input.concurrency ?? null,
    puppeteerInstance: browser,
    chromiumOptions: { gl: "angle" as const },
    logLevel: "error" as const,
  };

  const segments: VisualOverlaySegment[] = [];
  let framesRendered = 0;
  try {
    if (strategy === "FULL_LAYER") {
      await mkdir(dirname(input.outputPath), { recursive: true });
      const inputProps = { visuals: active.map((pv) => pv.visual), canvas, fontBaseUrl: null, clipMode: false, fps: input.fps, durationInFrames: totalFrames };
      const composition = await selectComposition({ serveUrl, id: "VisualsLayer", inputProps, puppeteerInstance: browser, chromiumOptions: { gl: "angle" }, logLevel: "error" });
      await renderMedia({ ...common, composition, inputProps, outputLocation: input.outputPath, onProgress: ({ progress }) => input.onProgress?.(progress) });
      framesRendered = totalFrames;
      segments.push({ path: input.outputPath, start: 0, end: totalFrames / input.fps, id: "layer" });
    } else {
      await mkdir(input.outputPath, { recursive: true });
      const totalActive = active.reduce((a, pv) => a + visualFrameWindow(pv.visual, input.fps).durationInFrames, 0);
      let done = 0;
      for (const [i, pv] of active.entries()) {
        const win = visualFrameWindow(pv.visual, input.fps);
        const frames = Math.min(win.durationInFrames, totalFrames - win.from);
        const inputProps = { visuals: [pv.visual], canvas, fontBaseUrl: null, clipMode: true, fps: input.fps, durationInFrames: frames };
        const composition = await selectComposition({ serveUrl, id: "VisualClip", inputProps, puppeteerInstance: browser, chromiumOptions: { gl: "angle" }, logLevel: "error" });
        const out = clipFile(input.outputPath, pv.visual, i);
        await renderMedia({
          ...common,
          composition,
          inputProps,
          outputLocation: out,
          onProgress: ({ progress }) => input.onProgress?.((done + progress * frames) / totalActive),
        });
        done += frames;
        framesRendered += frames;
        segments.push({ path: out, start: win.from / input.fps, end: (win.from + frames) / input.fps, id: pv.visual.id });
      }
    }
  } finally {
    await browser.close({ silent: true }).catch(() => undefined);
  }
  return { outputPath: input.outputPath, framesRendered, segments, skipped: errors, renderMs: Date.now() - started, bundleMs };
}
