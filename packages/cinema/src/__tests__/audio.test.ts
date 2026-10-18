import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { duckEnvelope, encodeStereoWav, renderScore, type ScorePlan } from "../audio/score";
import { mixFilm, premixArgs, TARGET_LUFS, voiceBusArgs } from "../audio/mix";
import { measureLoudness } from "../audio/ffmpeg";
import { encodeWav } from "../narration/kokoro";
import { cinemaSfxFiles } from "../audio/sfx";

const plan: ScorePlan = {
  durationSeconds: 6,
  bpm: 84,
  key: "D minor",
  seed: 3,
  duckDb: -10,
  sections: [
    { start: 0, end: 3, intensity: 0.4, hit: true },
    { start: 3, end: 6, intensity: 0.8 },
  ],
  speech: [{ start: 1, end: 2.5 }],
};

describe("procedural score", () => {
  it("is deterministic for a plan + seed", () => {
    const a = createHash("sha1").update(Buffer.from(renderScore(plan).buffer)).digest("hex");
    const b = createHash("sha1").update(Buffer.from(renderScore(plan).buffer)).digest("hex");
    expect(a).toBe(b);
  });

  it("ducks under speech with a pre-roll and a release", () => {
    expect(duckEnvelope(plan, 0.5)).toBe(1);
    expect(duckEnvelope(plan, 1.5)).toBeCloseTo(Math.pow(10, -10 / 20), 5);
    expect(duckEnvelope(plan, 0.94)).toBeLessThan(1); // already ducking before the first syllable
    expect(duckEnvelope(plan, 2.7)).toBeLessThan(1);
    expect(duckEnvelope(plan, 3.1)).toBe(1);
  });
});

describe("mix graph", () => {
  it("places each narration line at its time", () => {
    const args = voiceBusArgs([{ path: "a.wav", start: 0 }, { path: "b.wav", start: 2.345 }], 5, "out.wav");
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("adelay=2345|2345");
    expect(graph).toContain("amix=inputs=2:normalize=0");
  });

  it("sets SFX relative to the voice and trims to the film", () => {
    const args = premixArgs({ voiceBus: "v.wav", voiceGainDb: 2, music: "m.wav", musicGainDb: -20, sfx: [{ path: "s.wav", time: 1.5, gainDb: -3 }], duration: 7, out: "o.wav" });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("volume=-10.00dB,adelay=1500|1500"); // 2 + (−9 house) + (−3)
    expect(graph).toContain("atrim=0:7.000");
  });

  it("masters to −14 LUFS with the voice on top (real ffmpeg)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cinema-mix-"));
    // a "voice": syllable-like bursts of a 180 Hz buzz with harmonics
    const sr = 24000;
    const v = new Float32Array(sr * 3);
    for (let i = 0; i < v.length; i++) {
      const t = i / sr;
      const env = Math.max(0, Math.sin(t * Math.PI * 4)) ** 2;
      v[i] = env * 0.3 * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t) + 0.25 * Math.sin(2 * Math.PI * 720 * t));
    }
    await writeFile(join(dir, "line.wav"), encodeWav(v, sr));
    const music = join(dir, "score.wav");
    await writeFile(music, encodeStereoWav(renderScore(plan), 48000, -1));
    const sfx = await cinemaSfxFiles(join(dir, "sfx"));
    const out = join(dir, "mix.wav");
    const report = await mixFilm({ workDir: dir, voice: [{ path: join(dir, "line.wav"), start: 1 }], music, musicUnderVoiceDb: -8, sfx: [{ path: sfx.COIN_CLINK!, time: 0.5, gainDb: 0 }], duration: 6, out });
    expect(Math.abs(report.final.integratedLufs - TARGET_LUFS)).toBeLessThan(1);
    expect(report.final.truePeakDb).toBeLessThanOrEqual(-1);
    expect(report.musicGainDb).toBeLessThan(0);
    const final = await measureLoudness(out);
    expect(final.integratedLufs).toBeCloseTo(report.final.integratedLufs, 1);
  }, 60000);
});
