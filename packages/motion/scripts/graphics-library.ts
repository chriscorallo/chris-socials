/**
 * Quality loop + poster build for the graphics LIBRARY (every preset in
 * @chris/media GRAPHIC_PRESETS), through the real Remotion renderer (renderStill on the
 * `Preset-<id>` compositions — the same components the server render and the editor preview
 * draw).
 *
 *   pnpm --filter @chris/motion exec tsx scripts/graphics-library.ts <outDir> [--only=id1,id2] [--posters=<dir>] [--mid]
 *
 * Writes, per preset, a SETTLED frame (fully built, just before the exit) and with --mid a
 * MID-animation frame, composited over a dim "talking head" stand-in; then contact sheets
 * (<outDir>/sheet-<n>.jpg, 5×4 per sheet, labelled) and — with --posters — small JPEG posters
 * cropped to each graphic's box for the editor gallery (apps/web/public/motion-posters).
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FFMPEG_PATH, GRAPHIC_PRESETS, type GraphicPreset } from "@chris/media";
import { findLocalHeadlessShell, getMotionBundle, placementBox, presetVisual, visualFrameWindow } from "../src/index";
import { rendererGl } from "../src/render";

function ff(args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let e = "";
    p.stderr.on("data", (c) => (e += c));
    p.on("close", (code) => (code === 0 ? res() : rej(new Error(e.slice(-2000)))));
  });
}

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        await fn(items[k]!, k);
      }
    }),
  );
}

const W = 1080;
const H = 1920;

async function main() {
  const args = process.argv.slice(2);
  const outDir = resolve(args.find((a) => !a.startsWith("--")) ?? "/tmp/chris-graphics");
  const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
  const postersArg = args.find((a) => a.startsWith("--posters="))?.slice(10);
  const posters = postersArg ? resolve(postersArg) : null;
  const mid = args.includes("--mid");
  const presets = GRAPHIC_PRESETS.filter((p) => !only || only.includes(p.id));
  await mkdir(join(outDir, "frames"), { recursive: true });
  if (posters) await mkdir(posters, { recursive: true });

  const { renderStill, selectComposition, openBrowser, ensureBrowser } = await import("@remotion/renderer");
  const t0 = Date.now();
  const { serveUrl } = await getMotionBundle();
  const exe = findLocalHeadlessShell();
  if (!exe) await ensureBrowser();
  const browser = await openBrowser("chrome", { browserExecutable: exe, chromiumOptions: { gl: rendererGl() } });
  console.log(`bundle + browser ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // A dim stand-in for footage so glass/scrims read like they will over a real take.
  const bg = join(outDir, "bg.png");
  await ff(["-f", "lavfi", "-i", `color=c=0x3a3f47:s=${W}x${H},format=rgb24`, "-vf", "geq=r='58+28*exp(-((X-540)^2+(Y-1150)^2)/90000)':g='63+24*exp(-((X-540)^2+(Y-1150)^2)/90000)':b='71+20*exp(-((X-540)^2+(Y-1150)^2)/90000)'", "-frames:v", "1", bg]);

  const failures: string[] = [];
  const settled: Array<{ p: GraphicPreset; png: string }> = [];
  const mids: Array<{ p: GraphicPreset; png: string }> = [];
  const started = Date.now();
  await pool(presets, 4, async (p) => {
    const v = presetVisual(p, 0, p.seconds);
    const win = visualFrameWindow(v, 30);
    const id = `Preset-${p.id}`;
    try {
      const composition = await selectComposition({ serveUrl, id, puppeteerInstance: browser, logLevel: "error", chromiumOptions: { gl: rendererGl() } });
      const frames: Array<[string, number]> = [["settled", Math.max(0, win.durationInFrames - win.exitFrames - 4)]];
      if (mid) frames.push(["mid", Math.round(win.durationInFrames * 0.34)]);
      for (const [tag, frame] of frames) {
        const raw = join(outDir, "frames", `${p.id}__${tag}.raw.png`);
        await renderStill({ serveUrl, composition, output: raw, frame, imageFormat: "png", puppeteerInstance: browser, logLevel: "error", chromiumOptions: { gl: rendererGl() } });
        const png = join(outDir, "frames", `${p.id}__${tag}.png`);
        await ff(["-i", bg, "-i", raw, "-filter_complex", "[0][1]overlay=0:0:format=auto", "-frames:v", "1", png]);
        (tag === "settled" ? settled : mids).push({ p, png });
        if (tag === "settled" && posters) {
          const box = placementBox(p.template, v.placement, { width: W, height: H }, v.props);
          const pad = 24;
          const x = Math.max(0, Math.floor(box.left - pad));
          const y = Math.max(0, Math.floor(box.top - pad));
          const w = Math.min(W - x, Math.ceil(box.width + 2 * pad));
          const h = Math.min(H - y, Math.ceil(box.height + 2 * pad));
          const out = join(posters, `${p.id}.jpg`);
          await ff(["-f", "lavfi", "-i", `color=c=0x15151c:s=${w}x${h}`, "-i", raw, "-filter_complex", `[1]crop=${w}:${h}:${x}:${y}[g];[0][g]overlay=0:0:format=auto,scale='if(gt(iw,ih),360,-2)':'if(gt(iw,ih),-2,360)'`, "-frames:v", "1", "-q:v", "5", out]);
        }
      }
    } catch (err) {
      failures.push(`${p.id}: ${(err as Error).message.slice(0, 300)}`);
    }
  });
  await browser.close({ silent: true }).catch(() => undefined);
  console.log(`${presets.length} presets rendered in ${((Date.now() - started) / 1000).toFixed(1)}s; failures: ${failures.length}`);
  for (const f of failures) console.log("  FAIL", f);

  // Contact sheets: 5 x 4 per sheet, each tile 324x576 with the preset id burned in.
  const order = new Map(presets.map((p, i) => [p.id, i]));
  for (const [tag, list] of [["settled", settled], ["mid", mids]] as const) {
    list.sort((a, b) => order.get(a.p.id)! - order.get(b.p.id)!);
    for (let s = 0; s * 20 < list.length; s++) {
      const chunk = list.slice(s * 20, s * 20 + 20);
      const inputs = chunk.flatMap((c) => ["-i", c.png]);
      const labels = chunk.map((c, i) => `[${i}]scale=324:576,drawbox=y=548:w=324:h=28:color=black@0.6:t=fill,drawtext=text='${c.p.id.replace(/'/g, "")}':x=6:y=554:fontsize=15:fontcolor=white[t${i}]`).join(";");
      const pads = Array.from({ length: 20 - chunk.length }, (_, i) => `color=c=black:s=324x576:d=1[e${i}]`).join(";");
      const tiles = [...chunk.map((_, i) => `[t${i}]`), ...Array.from({ length: 20 - chunk.length }, (_, i) => `[e${i}]`)].join("");
      const layout = Array.from({ length: 20 }, (_, i) => `${(i % 5) * 324}_${Math.floor(i / 5) * 576}`).join("|");
      const graph = `${labels}${pads ? ";" + pads : ""};${tiles}xstack=inputs=20:layout=${layout}`;
      await ff([...inputs, "-filter_complex", graph, "-frames:v", "1", "-q:v", "3", join(outDir, `sheet-${tag}-${s + 1}.jpg`)]);
    }
  }
  await writeFile(join(outDir, "report.json"), JSON.stringify({ presets: presets.length, failures, ms: Date.now() - started }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
