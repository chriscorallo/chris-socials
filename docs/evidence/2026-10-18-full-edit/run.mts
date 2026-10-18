// Full edit on a test take (real Whisper words, real face track, measured audio, local MiniLM) →
// optional render with the real renderer. Usage: tsx run.mts t1 [--render] [--cuts] [--lexical] [--hook N]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const WT = "/Users/christophercorallo/Desktop/Claude Projects/Chris Socials/.claude/worktrees/agent-aad446c9bef68772d";
const D = "/private/tmp/claude-501/-Users-christophercorallo-Desktop-Claude-Projects-Chris-Socials/2fa27366-298a-4c40-a49e-d2c8b0f369a9/scratchpad/fulledit";
const media = await import(join(WT, "packages/media/src/index.ts"));
const { LocalSentenceEmbedder } = await import(join(WT, "packages/media/src/embeddings.ts"));
const { buildStarterPlan } = await import(join(WT, "packages/domain/src/starter-edit.ts"));
const tag = process.argv[2]!;
const args = process.argv.slice(3);
const take = join(D, `${tag}.mp4`);
const words = JSON.parse(readFileSync(join(D, `${tag}-words.json`), "utf8"));
const track = JSON.parse(readFileSync(join(D, `${tag}-track.json`), "utf8"));
const audio = JSON.parse(readFileSync(join(D, `${tag}-audio.json`), "utf8"));
const probe = JSON.parse(readFileSync(join(D, `${tag}-probe.json`), "utf8"));
const plan = buildStarterPlan({ durationSeconds: probe.durationSeconds, productionTier: "FAST", takeCount: 1 });
const base = media.planToTimeline(plan, { mediaAssetId: "take", sourceWordsAvailable: true });
// The live reference profile (2026-10-17: 15 videos, 4 creators; ~60 s videos).
const profile = {
  sampleSize: 15, creatorCount: 4,
  durationS: { value: 58, n: 15, p25: 44, p75: 71 },
  shotMedianS: { value: 2.4, n: 15, p25: 1.9, p75: 4.6 },
  firstCutS: { value: 3.2, n: 15, p25: 2.2, p75: 4.4 },
  hookDurationS: { value: 3.0, n: 15, p25: 2.2, p75: 4.0 },
  gapP90S: { value: 0.1, n: 15, p25: 0.06, p75: 0.18 },
  longestGapS: { value: 0.62, n: 15, p25: 0.45, p75: 0.9 },
  integratedLufs: { value: -14, n: 15, p25: -15, p75: -13 },
};
const target = media.styleCutTargetFromProfile(profile);
const sizes = { width: probe.width, height: probe.height };
let tl;
let out: Record<string, unknown>;
if (args.includes("--cuts")) {
  const r = media.buildStyleCut({ base, mediaAssetId: "take", words, durationSeconds: probe.durationSeconds, subjectTrack: track, sourceSize: sizes, silences: audio.silences, target });
  if (!r.ok) throw new Error(r.message);
  console.log("CUTS ONLY:", r.summary, "→", media.timelineDuration(r.timeline).toFixed(1), "s");
  tl = r.timeline;
  out = { summary: r.summary };
} else {
  const embedder = args.includes("--lexical") ? media.LEXICAL_EMBEDDER : new LocalSentenceEmbedder();
  const hi = args.indexOf("--hook");
  const t0 = Date.now();
  const r = await media.buildFullEdit(
    {
      base, mediaAssetId: "take", words, durationSeconds: probe.durationSeconds, subjectTrack: track, sourceSize: sizes,
      silences: audio.silences, envelope: audio.envelope, target, story: media.storyTargetFromProfile(profile),
      measure: media.nodeMeasureText, choices: hi >= 0 ? { hookIndex: Number(args[hi + 1]) } : {},
    },
    embedder,
  );
  if (!r.ok) throw new Error(r.message);
  console.log("built in", Date.now() - t0, "ms with", embedder.id);
  for (const s of r.sentences) {
    const d = r.story.decisions[s.id];
    console.log(`${d.kept ? "  KEEP" : `  -${d.kind}`.padEnd(6)} [${s.id}] ${s.beat.padEnd(9)} v=${d.value.toFixed(2)} e=${s.energyDb ?? "-"} ${s.text}${d.why ? `   // ${d.why}` : ""}`);
  }
  console.log("word cuts:", r.story.wordCuts.map((c: { kind: string; text: string }) => `${c.kind}:"${c.text}"`).join(" | "));
  console.log("HOOK candidates:");
  for (const c of r.report.hook.candidates) console.log(`  #${c.index} ${c.score.toFixed(2)} ${c.text}  — ${c.reason}`);
  console.log("chosen:", r.report.hook.chosenIndex, "coldOpen", r.report.hook.coldOpen, "replayed", r.report.hook.replayed);
  console.log("titles:", r.report.hook.titles.map((t: { text: string }) => t.text));
  console.log("visuals:", r.report.visuals.map((v: { name: string; start: number; reason: string; match: number }) => `${v.start}s ${v.name} (${v.reason}, m=${v.match})`));
  console.log("rejected:", r.rejectedVisuals.map((x: { sentenceId: number; presetId: string; reason: string }) => `[${x.sentenceId}] ${x.presetId}: ${x.reason}`).join(" | "));
  console.log("zooms:", r.timeline.zooms.map((z: { start: number; end: number }) => `${z.start}-${z.end}`), "texts:", r.timeline.texts.map((t: { text: string; y: number; fontSize: number }) => `${t.text}@${t.y}/${t.fontSize}`));
  for (const c of r.report.checks) console.log(`  [${c.status}] ${c.name}: ${c.detail}`);
  console.log("SUMMARY:", r.report.summary);
  const chunks = media.timelineCaptionChunks(r.timeline, { take: words });
  const said = chunks.map((c: { words: Array<{ word: string }> }) => c.words.map((w) => w.word).join(" ")).join(" ");
  console.log("AFTER (what's heard):", said);
  tl = r.timeline;
  out = { report: r.report, story: r.story, sentences: r.sentences };
}
writeFileSync(join(D, `${tag}-${args.includes("--cuts") ? "cuts" : "full"}.json`), JSON.stringify({ ...out, timeline: tl }, null, 1));
if (args.includes("--render")) {
  const kind = args.includes("--cuts") ? "cuts" : "full";
  const outp = join(D, `${tag}-${kind}.mp4`);
  const visuals = media.resolveVisualPlacements(tl, { subjectTracks: { take: track }, sourceDimensions: { take: sizes }, wordsByAsset: { take: words }, measure: media.nodeMeasureText });
  // The worker's own motion step (Remotion visuals layer + SFX kit), exactly as render-job does.
  const { prepareMotion } = await import(join(WT, "apps/worker/src/render-job.ts"));
  const { mkdtempSync } = await import("node:fs");
  const work = mkdtempSync(join(D, "work-"));
  const warnings: string[] = [];
  const placed = { ...tl, visuals };
  const mi = await prepareMotion(null, null, placed, { take }, work, warnings, {});
  console.log("motion", mi.framesRendered, "frames", mi.renderMs, "ms", warnings);
  const res = await media.renderTimeline({ timeline: placed, sources: { take }, sourceWords: { take: words }, outputPath: outp, encode: { preset: "veryfast", crf: 22 }, visualsLayer: mi.visualsLayer, musicPath: null, sfxFiles: mi.sfxFiles });
  const { rmSync } = await import("node:fs");
  rmSync(work, { recursive: true, force: true });
  console.log("render", res.durationSeconds, "s", res.width, res.height, "ms", res.renderMs, "warnings", res.warnings);
}
