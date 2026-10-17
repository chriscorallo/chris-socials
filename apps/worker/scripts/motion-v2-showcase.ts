/**
 * Motion v2 quality loop — graphics that interact with a real portrait clip, rendered through
 * the worker's own render path (withResolvedPlacements → prepareInteraction → prepareMotion →
 * renderTimeline), minus the database rows.
 *
 *   TRANSCRIPTION_CACHE_DIR=<repo>/.cache/transformers \
 *   pnpm --filter @chris/worker exec tsx scripts/motion-v2-showcase.ts <video> <outDir> [--matte=<matte.mp4>]
 *
 * Output: <outDir>/showcase.mp4, frames/*.png, timeline.json, report.json.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  EditTimelineSchema,
  FFMPEG_PATH,
  analyzeSubjectTrackDetailed,
  computePersonMatte,
  anchorOffsetFor,
  displayDimensions,
  probeMedia,
  renderTimeline,
  type EditTimelineInput,
  type StorageAdapter,
  type TranscriptWord,
} from "@chris/media";
import { LocalWhisperTranscriptionProvider } from "@chris/media/transcription";
import type { PrismaClient } from "@chris/domain";
import { prepareInteraction, prepareMotion, withResolvedPlacements } from "../src/render-job";

const args = process.argv.slice(2);
const video = resolve(args[0] ?? "");
const outDir = resolve(args[1] ?? "motion-v2-out");
const matteArg = args.find((a) => a.startsWith("--matte="))?.slice(8);
const only = args.find((a) => a.startsWith("--frames="))?.slice(9);
const num = (name: string, d: number) => Number(args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? d);
const NUM_X = num("numx", 0.5);
const NUM_Y = num("numy", 0.226);
const NUM_S = num("nums", 1);
const CARD_Y = num("cardy", 0.7);

function ff(a: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", ...a]);
    let e = "";
    p.stderr.on("data", (c) => (e += c));
    p.on("close", (code) => (code === 0 ? res() : rej(new Error(e.slice(-2000)))));
  });
}

async function main() {
  await mkdir(join(outDir, "frames"), { recursive: true });
  const t0 = Date.now();
  const probe = await probeMedia(video);
  const dims = await displayDimensions(video);

  // 1. Matte (cached next to the output)
  const mattePath = matteArg ? resolve(matteArg) : join(outDir, "matte.mp4");
  let matteMs = 0;
  if (!existsSync(mattePath)) {
    const r = await computePersonMatte(video, mattePath);
    matteMs = r.ms;
    console.log("matte", r);
  }
  // 2. Subject track + words
  const trackRes = await analyzeSubjectTrackDetailed(video);
  const wordsPath = join(outDir, "words.json");
  let words: TranscriptWord[];
  if (existsSync(wordsPath)) words = JSON.parse(await readFile(wordsPath, "utf8"));
  else {
    words = (await new LocalWhisperTranscriptionProvider().transcribe(video)).words;
    await writeFile(wordsPath, JSON.stringify(words, null, 1));
  }
  console.log("words", words.map((w) => `${w.word}@${w.start.toFixed(2)}`).join(" "));

  const D = Math.min(probe.durationSeconds - 0.1, 11);
  const A = "take";
  const timelineIn: EditTimelineInput = {
    version: 2,
    clips: [{ id: "c1", mediaAssetId: A, sourceStart: 0, sourceEnd: D }],
    zooms: [{ id: "z1", start: 5.9, end: 9.0, zoom: 1.16, mode: "EASE", easeSeconds: 0.9, x: 0.5, y: 0.32 }],
    captions: { enabled: true, preset: "BOLD_HIGHLIGHT", fontId: "inter-display-bold", fontSize: 60, color: "#FFFFFF", highlightColor: "#FFD54A", y: 0.865 },
    grade: { preset: "CINEMATIC" },
    visuals: [
      // Big number behind the head (placed; depth BEHIND_SUBJECT; hits on the spoken number).
      { id: "num", template: "NUMBER_COUNTER", props: { value: 24500, prefix: "$" }, start: 0.35, end: 3.7, placement: { mode: "MANUAL", x: NUM_X, y: NUM_Y, scale: NUM_S }, depth: "BEHIND_SUBJECT", enterSfx: "RISER" },
      // A card that follows Chris (offset solved so it starts exactly where it's placed).
      { id: "card", template: "STAT_CARD", props: { value: "$400", label: "Extra per month", trend: "UP" }, start: 3.9, end: 6.0, placement: { mode: "MANUAL", x: 0.5, y: CARD_Y, scale: 0.6 }, anchor: { type: "SUBJECT", offsetX: 0, offsetY: 0 }, enterSfx: "SOFT_POP" },
      // A chart riding the punch-in (parallax), placed by the engine.
      { id: "bars", template: "BAR_CHART", props: { title: "Years to debt-free", bars: [{ label: "Minimum", value: 14 }, { label: "+$400", value: 5 }], unit: "", highlightIndex: 1, depth3d: false }, start: 6.1, end: 9.0, placement: { mode: "MANUAL", x: 0.5, y: 0.7, scale: 0.54 }, cameraCoupling: 0.45, enterSfx: "SWOOSH_UP" },
      // 3D icon with light wrap, placed by the engine.
      { id: "coin", template: "ICON_3D", props: { icon: "PIGGY_BANK", caption: "Free in 5 years" }, start: 9.1, end: D, placement: { mode: "AUTO", x: 0.5, y: 0.58, scale: 1 }, integration: { shadow: true, lightWrap: true, sceneMatch: true }, enterSfx: "SHIMMER" },
    ],
  };
  const parsed0 = EditTimelineSchema.parse(timelineIn);
  const off = anchorOffsetFor(parsed0.visuals.find((v) => v.id === "card")!, parsed0, 3.9, { subjectTracks: { [A]: trackRes.track }, sourceDimensions: { [A]: dims } });
  const timeline = { ...parsed0, visuals: parsed0.visuals.map((v) => (v.id === "card" && off ? { ...v, anchor: { type: "SUBJECT" as const, ...off } } : v)) };
  const asset = { id: A, storageKey: "raw/take.mp4", subjectTrack: trackRes.track, matteStorageKey: "mattes/x/take.mp4", width: dims.width, height: dims.height, hasAudio: probe.hasAudio };
  const storage: StorageAdapter = {
    put: async () => ({ url: "" }),
    get: async (key: string) => readFile(key === asset.matteStorageKey ? mattePath : video),
    signedUrl: async () => "",
    delete: async () => undefined,
  } as StorageAdapter;
  const db = {} as PrismaClient;
  const sources = { [A]: video };
  const sourceWords = { [A]: words };
  const placed = withResolvedPlacements(timeline, [asset], sourceWords);
  console.log("placed", placed.visuals.map((v) => `${v.id}:${v.depth}@${v.placement.x},${v.placement.y}x${v.placement.scale}`).join(" "));
  const warnings: string[] = [];
  const workDir = join(outDir, "work");
  await mkdir(workDir, { recursive: true });
  const tPrep = Date.now();
  const interaction = await prepareInteraction(db, storage, placed, [asset], sources, sourceWords, workDir, warnings, {});
  const prepMs = Date.now() - tPrep;
  const tMotion = Date.now();
  const motion = await prepareMotion(db, storage, placed, sources, workDir, warnings, {}, interaction.input);
  const motionMs = Date.now() - tMotion;
  const out = join(outDir, "showcase.mp4");
  const tRender = Date.now();
  const res = await renderTimeline({
    timeline,
    sources,
    sourceWords,
    outputPath: out,
    encode: { preset: "medium", crf: 17 },
    visualsLayer: motion.visualsLayer,
    sfxFiles: motion.sfxFiles,
    mattes: interaction.mattes,
  });
  const renderMs = Date.now() - tRender;
  // Same render without mattes → overhead of the depth pass.
  const tFlat = Date.now();
  await renderTimeline({ timeline, sources, sourceWords, outputPath: join(outDir, "flat.mp4"), encode: { preset: "medium", crf: 17 }, visualsLayer: motion.visualsLayer ? { segments: motion.visualsLayer.segments.map((s) => ({ ...s, depth: "FRONT" as const })) } : null, sfxFiles: motion.sfxFiles });
  const flatMs = Date.now() - tFlat;

  const times = only ? only.split(",").map(Number) : [0.6, 1.2, 2.0, 3.0, 4.4, 5.4, 6.3, 7.2, 8.4, 9.6, 10.4];
  for (const t of times) await ff(["-ss", String(t), "-i", out, "-frames:v", "1", join(outDir, "frames", `f-${t.toFixed(2)}.png`)]);
  const report = {
    warnings: [...warnings, ...res.warnings],
    interaction: interaction.report,
    hits: Object.fromEntries(Object.entries(interaction.input.emphasisWords ? motion.visualsLayer ? {} : {} : {})),
    motion: res.motion,
    timings: { matteMs, prepMs, motionLayerMs: motionMs, renderMs, renderFlatMs: flatMs, totalMs: Date.now() - t0 },
    placed: placed.visuals.map((v) => ({ id: v.id, depth: v.depth, placement: v.placement })),
  };
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, "timeline.json"), JSON.stringify(placed, null, 2));
  console.log(JSON.stringify(report.timings), report.warnings);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
