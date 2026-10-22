import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareToHandEdit, diffGolden, GoldenFixtureSchema, replayGolden, spliceMetrics, summariseSplices, type GoldenFixture, type GoldenReplay } from "../golden";
import { EditTimelineSchema, type EditTimeline } from "../timeline";
import type { TranscriptWord } from "../caption-chunking";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const GOLDEN = join(ROOT, "fixtures/golden");

function take(lines: string[], gap = 0.6, lead = 0.8) {
  const words: TranscriptWord[] = [];
  const silences: Array<{ start: number; end: number }> = [{ start: 0, end: lead }];
  let t = lead;
  for (const line of lines) {
    for (const w of line.split(" ")) {
      words.push({ word: w, start: +t.toFixed(3), end: +(t + 0.16).toFixed(3) });
      t += 0.18;
    }
    silences.push({ start: +(t - 0.02).toFixed(3), end: +(t + gap).toFixed(3) });
    t += gap;
  }
  return { words, silences, duration: +(t + 0.5).toFixed(3) };
}

const tl = (clips: Array<[number, number]>): EditTimeline =>
  EditTimelineSchema.parse({
    version: 2,
    clips: clips.map(([a, b], i) => ({ id: `c${i}`, mediaAssetId: "take", sourceStart: a, sourceEnd: b })),
    captions: { fontId: "inter-display-extrabold", fontSize: 64, color: "#FFFFFF", highlightColor: "#FFD84D", y: 0.72 },
  });

describe("golden harness — splice metrics", () => {
  const words: TranscriptWord[] = [
    { word: "one", start: 0.5, end: 0.8 },
    { word: "two", start: 1.6, end: 1.9 },
    { word: "three", start: 2.6, end: 2.9 },
  ];

  it("measures the air the viewer hears at each splice and flags clipped words", () => {
    const s = spliceMetrics(tl([[0, 0.9], [1.55, 2.0], [2.65, 3.2]]), words, null);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ outS: 0.9, inS: 1.55, tailAirS: 0.1, leadAirS: 0.05, airS: 0.15, clippedTailMs: 0, clippedLeadMs: 0 });
    // The second cut-in lands 50 ms inside "three": a clipped word.
    expect(s[1]!.clippedLeadMs).toBe(50);
    const sum = summariseSplices(s);
    expect(sum.clippedCount).toBe(1);
    expect(sum.n).toBe(2);
  });

  it("a hand edit compared with itself is 0 ms off and fully agreed", () => {
    const hand = tl([[0, 0.9], [1.55, 2.0], [2.55, 3.2]]);
    const c = compareToHandEdit(hand, hand, "take");
    expect(c).toMatchObject({ handCuts: 2, medianDeltaMs: 0, within30ms: 4, machineKeptOfHand: 1, handKeptOfMachine: 1 });
  });
});

describe("golden harness — replay", () => {
  const t = take([
    "Two people both make a hundred grand a year.",
    "One of them saves seven hundred dollars a month.",
    "The other saves over four thousand every month.",
    "Same salary, same city, same age.",
    "Which one are you?",
  ]);
  const fixture: GoldenFixture = GoldenFixtureSchema.parse({
    version: 1,
    slug: "synthetic",
    contentItemId: "c-synthetic",
    title: "Same salary",
    exportedAt: "2026-10-21T00:00:00.000Z",
    take: { mediaAssetId: "take", durationSeconds: t.duration, width: 1080, height: 1920, words: t.words, subjectTrack: null },
    audio: { silences: t.silences, envelope: null },
    base: tl([[0, t.duration]]),
    brief: null,
    profile: null,
    editorPlan: {
      storyline: [
        { sentenceId: 4, role: "HOOK", headline: "WHICH ONE?" },
        { sentenceId: 0, role: "SETUP", headline: "SAME $100K" },
        { sentenceId: 1, role: "TENSION", headline: "$700 SAVED" },
        { sentenceId: 2, role: "PAYOFF", headline: "$4,000 SAVED" },
      ],
      cut: [{ sentenceId: 3, why: "repeats the setup" }],
      pacing: "LONG_SHOTS_ZOOMS",
      rationale: "",
    },
    machine: null,
    handEdit: null,
  });

  it("is deterministic: replaying twice gives an empty diff, for the free cut and the Editor's cut", async () => {
    const a = await replayGolden(fixture);
    const b = await replayGolden(fixture);
    expect(a.free.ok).toBe(true);
    expect(a.editor?.ok).toBe(true);
    expect(a.editor!.kept.map((k) => k.sentenceId)).toEqual([4, 0, 1, 2]);
    expect(diffGolden(a, b)).toEqual([]);
  });

  it("the diff names what changed", async () => {
    const a = await replayGolden(fixture);
    const changed: GoldenReplay = JSON.parse(JSON.stringify(a));
    changed.editor!.kept = changed.editor!.kept.slice(1);
    changed.editor!.title = "Other";
    const d = diffGolden(a, changed);
    expect(d.some((x) => x.startsWith("editor: kept order"))).toBe(true);
    expect(d.some((x) => x.startsWith("editor: title"))).toBe(true);
  });
});

// The real golden set: Chris's takes pulled with `pnpm golden:pull`, expected replays written by
// `pnpm golden:replay --update`. Green = every fixture replays and matches its expected file.
const fixtures = existsSync(GOLDEN) ? readdirSync(GOLDEN).filter((f) => f.endsWith(".json")) : [];

describe("golden set", () => {
  if (fixtures.length === 0) {
    it.skip("no fixtures pulled yet (fixtures/golden/*.json)", () => {});
    return;
  }
  for (const file of fixtures) {
    it(`${file} replays and matches its expected cut`, async () => {
      const fixture = GoldenFixtureSchema.parse(JSON.parse(readFileSync(join(GOLDEN, file), "utf8")));
      const actual = await replayGolden(fixture);
      expect(actual.free.ok, actual.free.error).toBe(true);
      const expectedPath = join(GOLDEN, "expected", file);
      if (existsSync(expectedPath)) {
        const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as GoldenReplay;
        expect(diffGolden(expected, actual)).toEqual([]);
      }
    }, 120_000);
  }
});
