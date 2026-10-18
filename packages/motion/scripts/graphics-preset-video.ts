/**
 * Renders ONE library preset as a short MP4 (alpha layer composited over a dim stand-in
 * background) for checking motion, plus frames at given seconds.
 *
 *   pnpm --filter @chris/motion exec tsx scripts/graphics-preset-video.ts <presetId> <outDir> [--theme=CINEMATIC]
 */
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FFMPEG_PATH, presetById, type MotionTheme } from "@chris/media";
import { presetVisual, renderVisualsLayer } from "../src/index";

function ff(args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let e = "";
    p.stderr.on("data", (c) => (e += c));
    p.on("close", (code) => (code === 0 ? res() : rej(new Error(e.slice(-2000)))));
  });
}

async function main() {
  const [id, outArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const lang = process.argv.find((a) => a.startsWith("--theme="))?.slice(8) as MotionTheme["motionLanguage"] | undefined;
  const preset = presetById(id);
  if (!preset || !outArg) throw new Error("usage: graphics-preset-video.ts <presetId> <outDir>");
  const out = resolve(outArg);
  await mkdir(out, { recursive: true });
  const lead = 0.5;
  const total = preset.seconds + lead + 0.6;
  const v = presetVisual(preset, lead, lead + preset.seconds);
  const theme: MotionTheme | null = lang ? { name: lang, motionLanguage: lang, iconStyle: "GOLD_METAL", primary: null, secondary: null, rationale: null } : null;
  const mov = join(out, `${id}.mov`);
  const r = await renderVisualsLayer({ timeline: { visuals: [v], canvas: { width: 1080, height: 1920 }, motionTheme: theme }, fps: 30, durationSeconds: total, outputPath: mov, strategy: "FULL_LAYER" });
  console.log(`rendered ${r.framesRendered} frames in ${(r.renderMs / 1000).toFixed(1)}s`);
  const mp4 = join(out, `${id}.mp4`);
  await ff([
    "-f", "lavfi", "-i", `color=c=0x3a3f47:s=1080x1920:d=${total},format=yuv420p`,
    "-i", mov,
    "-filter_complex", "[0][1]overlay=0:0:format=auto,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", "-t", String(total), mp4,
  ]);
  for (const t of [0.9, 1.6, 2.6, 3.6, 4.6, 5.6, 6.6, 7.6, 8.6, 9.4].filter((x) => x < total)) {
    await ff(["-ss", t.toFixed(2), "-i", mp4, "-frames:v", "1", "-vf", "scale=540:-2", join(out, `${id}-${t.toFixed(1)}.jpg`)]);
  }
  await rm(mov, { force: true });
  await rm(join(tmpdir(), `chris-motion-bundle-${process.pid}`), { recursive: true, force: true });
  console.log(mp4);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
