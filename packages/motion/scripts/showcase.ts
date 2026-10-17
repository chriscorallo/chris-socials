/**
 * Quality loop: renders every template over a realistic stand-in background (dark AND light),
 * through the real pipeline (renderVisualsLayer -> renderTimeline with SFX + music), then
 * extracts entrance / mid / exit frames per template and builds contact sheets.
 *
 *   pnpm --filter @chris/motion exec tsx scripts/showcase.ts [outDir] [--only=T1,T2] [--seconds=2.6]
 *
 * Output: <outDir>/showcase-{dark,light}.mp4, frames/<template>-{in,mid,out}-{dark,light}.png,
 * contact-{dark,light}.png, timings.json.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { FFMPEG_PATH, MOTION_TEMPLATES, renderTimeline, type MotionTemplate, type SfxSound } from "@chris/media";
import { renderVisualsLayer, sampleVisual, sfxFiles } from "../src/index";

const ENTER_SFX: Record<MotionTemplate, SfxSound> = {
  KINETIC_TEXT: "WHOOSH",
  NUMBER_COUNTER: "RISER",
  STAT_CARD: "SOFT_POP",
  BAR_CHART: "SWOOSH_UP",
  LINE_CHART: "SWOOSH_UP",
  COMPARISON: "IMPACT",
  PERCENT_RING: "SHIMMER",
  LIST_STEPS: "CLICK",
  ICON_3D: "SHIMMER",
  MONEY_STACK_3D: "CASH",
  CALLOUT: "SOFT_POP",
  TIMELINE: "TICK",
  DEFINITION: "WHOOSH",
  TITLE_CARD: "IMPACT",
};

function ff(args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let e = "";
    p.stderr.on("data", (c) => (e += c));
    p.on("close", (code) => (code === 0 ? res() : rej(new Error(e.slice(-2000)))));
  });
}

/** A "talking head" stand-in: lit backdrop + soft-focus person silhouette + gentle drift, with a voice-like tone. */
async function makeBackground(path: string, seconds: number, light: boolean): Promise<void> {
  const [c0, c1] = light ? ["0xEDE6DA", "0xBFC8D2"] : ["0x1B2233", "0x6B5440"];
  const person = light ? "0x5A4A40" : "0x2A2420";
  const skin = light ? "0xC99A7C" : "0x8A6450";
  await ff([
    "-f", "lavfi", "-i", `gradients=s=1080x1920:r=30:d=${seconds}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=1080:y1=1920:speed=0.004`,
    "-f", "lavfi", "-i", `sine=frequency=180:sample_rate=48000:duration=${seconds}`,
    "-filter_complex",
    // shoulders + head (soft ellipses), blurred like shallow depth of field
    `[0:v]drawbox=x=170:y=1300:w=740:h=700:color=${person}@1:t=fill,` +
      `drawbox=x=380:y=780:w=320:h=420:color=${skin}@1:t=fill,` +
      `gblur=sigma=40,eq=saturation=1.05,format=yuv420p[v];` +
      `[1:a]volume='0.35*(0.6+0.4*sin(2*PI*3*t))*gt(sin(2*PI*0.23*t),-0.4)':eval=frame[a]`,
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", path,
  ]);
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = resolve(args.find((a) => !a.startsWith("--")) ?? join(tmpdir(), "chris-motion-showcase"));
  const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",") as MotionTemplate[] | undefined;
  const per = Number(args.find((a) => a.startsWith("--seconds="))?.slice(10) ?? 2.6);
  const templates = only ?? [...MOTION_TEMPLATES];
  await mkdir(join(outDir, "frames"), { recursive: true });

  const gap = 0.15;
  const visuals = templates.map((t, i) => {
    const start = Math.round((0.3 + i * (per + gap)) * 100) / 100;
    return sampleVisual(t, start, Math.round((start + per) * 100) / 100, { enterSfx: ENTER_SFX[t] });
  });
  const duration = Math.ceil(visuals[visuals.length - 1]!.end + 0.6);
  const canvas = { width: 1080, height: 1920 };
  const fps = 30;

  const t0 = Date.now();
  const layer = await renderVisualsLayer({ timeline: { visuals, canvas }, fps, durationSeconds: duration, outputPath: join(outDir, "layer"), onProgress: () => undefined });
  const layerMs = Date.now() - t0;
  console.log(`visuals layer: ${layer.framesRendered} frames in ${(layerMs / 1000).toFixed(1)}s (bundle ${(layer.bundleMs / 1000).toFixed(1)}s)`);

  const timings: Record<string, unknown> = { templates: templates.length, duration, fps, framesRendered: layer.framesRendered, layerMs, bundleMs: layer.bundleMs };
  // A music bed (procedural pad) to show ducking.
  const music = join(outDir, "bed.wav");
  await ff(["-f", "lavfi", "-i", `aevalsrc='0.2*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.25*t))+0.15*sin(2*PI*277.18*t)+0.12*sin(2*PI*329.63*t)':s=48000:d=${duration + 2}`, "-ac", "2", music]);

  for (const mode of ["dark", "light"] as const) {
    const bg = join(outDir, `bg-${mode}.mp4`);
    await makeBackground(bg, duration, mode === "light");
    const out = join(outDir, `showcase-${mode}.mp4`);
    const t1 = Date.now();
    const res = await renderTimeline({
      timeline: {
        version: 2,
        canvas,
        clips: [{ id: "c", mediaAssetId: "BG", sourceStart: 0, sourceEnd: duration }],
        captions: { enabled: false, fontId: "inter-display-bold", fontSize: 60, color: "#FFFFFF", highlightColor: "#FFD54A" },
        visuals,
        audio: { normalize: true, sfxEnabled: true, music: { musicAssetId: "MUSIC", levelDb: -20, duckDb: 10 } },
      },
      sources: { BG: bg },
      sourceWords: {},
      outputPath: out,
      encode: { preset: "veryfast", crf: 18 },
      visualsLayer: { segments: layer.segments },
      musicPath: music,
      sfxFiles: sfxFiles(),
    });
    timings[`composite_${mode}_ms`] = Date.now() - t1;
    console.log(`${mode}: composited in ${((Date.now() - t1) / 1000).toFixed(1)}s, warnings: ${JSON.stringify(res.warnings)}`);
    const tiles: string[] = [];
    for (const v of visuals) {
      const len = v.end - v.start;
      for (const [tag, at] of [["in", v.start + 0.22], ["mid", v.start + len * 0.55], ["out", v.end - 0.12]] as const) {
        const png = join(outDir, "frames", `${v.template.toLowerCase()}-${tag}-${mode}.png`);
        await ff(["-ss", at.toFixed(3), "-i", out, "-frames:v", "1", "-vf", "scale=540:960", png]);
        tiles.push(png);
      }
    }
    // Contact sheet: one row per template (in / mid / out), scaled down.
    const cols = 6; // two templates per row
    const rows = Math.ceil(tiles.length / cols);
    const inputs = tiles.flatMap((t) => ["-i", t]);
    const layout = tiles.map((_, i) => `${(i % cols) * 270}_${Math.floor(i / cols) * 480}`).join("|");
    await ff([...inputs, "-filter_complex", `${tiles.map((_, i) => `[${i}:v]scale=270:480[t${i}]`).join(";")};${tiles.map((_, i) => `[t${i}]`).join("")}xstack=inputs=${tiles.length}:layout=${layout}:fill=black`, "-frames:v", "1", join(outDir, `contact-${mode}.png`)]);
    console.log(`contact sheet ${mode}: ${rows} rows`);
  }
  await writeFile(join(outDir, "timings.json"), JSON.stringify(timings, null, 2));
  console.log(`done -> ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
