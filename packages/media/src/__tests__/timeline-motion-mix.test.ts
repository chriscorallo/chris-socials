import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG_PATH } from "../ffmpeg-paths";
import { probeMedia } from "../probe";
import {
  SFX_HOUSE_GAIN,
  VISUAL_SFX_VOLUME,
  buildAudioMix,
  musicDuckVolumeExpr,
  renderTimeline,
  sidechainRatioFor,
  speechRegions,
  timelineSfxEvents,
} from "../timeline-render";
import { EditTimelineSchema, type EditTimelineInput } from "../timeline";
import { countRgb, grabRgbRegion, runFfmpegRaw } from "./ffmpeg-test-helpers";

const visual = (id: string, start: number, end: number, enterSfx: string | null = "WHOOSH") => ({
  id,
  template: "STAT_CARD" as const,
  props: { value: "7%", label: "Return" },
  start,
  end,
  placement: { mode: "MANUAL" as const, x: 0.5, y: 0.3, scale: 1 },
  enterSfx: enterSfx as "WHOOSH" | null,
});

const base = (extra: Partial<EditTimelineInput> = {}): EditTimelineInput => ({
  version: 2,
  clips: [{ id: "c1", mediaAssetId: "A", sourceStart: 0, sourceEnd: 6 }],
  captions: { enabled: false, fontId: "inter-display-bold", fontSize: 60, color: "#FFFFFF", highlightColor: "#FFD54A" },
  ...extra,
});

describe("sound design graph (pure)", () => {
  it("collects visual entrance SFX + free SFX, sorted, respecting sfxEnabled and duration", () => {
    const t = EditTimelineSchema.parse(
      base({
        visuals: [visual("v2", 3, 5), visual("v1", 1, 2), visual("silent", 2, 3, null), visual("late", 9, 10)],
        sfx: [{ id: "s1", at: 2.5, sound: "TICK", volume: 0.3 }],
      }),
    );
    const ev = timelineSfxEvents(t, 6);
    expect(ev.map((e) => [e.id, e.at, e.sound, e.volume])).toEqual([
      ["v1", 1, "WHOOSH", VISUAL_SFX_VOLUME],
      ["s1", 2.5, "TICK", 0.3],
      ["v2", 3, "WHOOSH", VISUAL_SFX_VOLUME],
    ]);
    const off = EditTimelineSchema.parse({ ...base({ visuals: [visual("v1", 1, 2)] }), audio: { sfxEnabled: false } });
    expect(timelineSfxEvents(off, 6)).toEqual([]);
  });

  it("maps word timings through clips into merged output speech regions", () => {
    const t = EditTimelineSchema.parse(
      base({
        clips: [
          { id: "a", mediaAssetId: "A", sourceStart: 2, sourceEnd: 4 },
          { id: "b", mediaAssetId: "A", sourceStart: 0, sourceEnd: 1 },
        ],
      }),
    );
    const words = { A: [
      { word: "x", start: 0.2, end: 0.5 },
      { word: "y", start: 2.1, end: 2.4 },
      { word: "z", start: 2.6, end: 3.0 }, // gap 0.2 < 0.45 -> merged with y
      { word: "w", start: 3.8, end: 4.5 }, // clipped at the source end
    ] };
    expect(speechRegions(t, words)).toEqual([
      { start: expect.closeTo(0.1, 6), end: expect.closeTo(1.0, 6) },
      // w (clipped to 2.0) and x (clip b, 2.2-2.5) are 0.2 s apart -> one region.
      { start: expect.closeTo(1.8, 6), end: expect.closeTo(2.5, 6) },
    ]);
  });

  it("builds a duck expression: level in gaps, level-duck under speech, ramped", () => {
    expect(musicDuckVolumeExpr([], -18, 10)).toBe(String(Math.round(Math.pow(10, -18 / 20) * 10000) / 10000));
    const e = musicDuckVolumeExpr([{ start: 1, end: 2 }], -18, 10, 0.2, 0.4);
    expect(e).toBe("pow(10,(-18-10*min(1,clip((t-0.8)/0.2,0,1)*clip((2.4-t)/0.4,0,1)))/20)");
    expect(sidechainRatioFor(10)).toBeCloseTo(2.25, 2);
  });

  it("is exactly the legacy single chain without SFX or music", () => {
    const t = EditTimelineSchema.parse(base());
    const plan = buildAudioMix({ timeline: t, duration: 6, anyAudio: true, firstInput: 1, sourceWords: {} });
    expect(plan.parts).toEqual(["[acat]dynaudnorm=f=400:g=21:m=4:p=0.9,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]"]);
    expect(plan.inputArgs).toEqual([]);
  });

  it("splits one input per sound, delays each hit, mixes and re-normalizes", () => {
    const t = EditTimelineSchema.parse(base({ visuals: [visual("v1", 1, 2), visual("v2", 3.25, 4)], sfx: [{ id: "s", at: 2, sound: "CLICK", volume: 1 }] }));
    const plan = buildAudioMix({
      timeline: t, duration: 6, anyAudio: true, firstInput: 3, sourceWords: {},
      sfxFiles: { WHOOSH: "/k/whoosh.wav", CLICK: "/k/click.wav" }, fileExists: () => true,
    });
    expect(plan.inputArgs).toEqual(["-i", "/k/whoosh.wav", "-i", "/k/click.wav"]);
    const g = plan.parts.join(";");
    expect(g).toContain("[3:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[sfx3_0][sfx3_1]");
    expect(g).toContain(`[sfx3_0]adelay=1000:all=1,volume=${VISUAL_SFX_VOLUME * SFX_HOUSE_GAIN}[hit0]`);
    expect(g).toContain("[sfx3_1]adelay=3250:all=1");
    expect(g).toContain(`[sfx4_0]adelay=2000:all=1,volume=${SFX_HOUSE_GAIN}[hit2]`);
    expect(g).toMatch(/\[voice\]\[hit0\]\[hit1\]\[hit2\]amix=inputs=4:duration=first:dropout_transition=0:normalize=0,loudnorm=I=-14/);
  });

  it("warns (never fails) on a missing SFX or music file", () => {
    const t = EditTimelineSchema.parse({ ...base({ visuals: [visual("v1", 1, 2)] }), audio: { music: { musicAssetId: "M" } } });
    const plan = buildAudioMix({ timeline: t, duration: 6, anyAudio: true, firstInput: 1, sourceWords: {}, sfxFiles: {}, musicPath: "/nope.m4a", fileExists: () => false });
    expect(plan.parts).toHaveLength(1);
    expect(plan.warnings.join("\n")).toMatch(/no file for WHOOSH/);
    expect(plan.warnings.join("\n")).toMatch(/rendered without music/);
  });

  it("music: word-timing automation when words exist, sidechain otherwise", () => {
    const t = EditTimelineSchema.parse({ ...base(), audio: { music: { musicAssetId: "M", trackStart: 4, levelDb: -20, duckDb: 12 } } });
    const withWords = buildAudioMix({ timeline: t, duration: 6, anyAudio: true, firstInput: 1, sourceWords: { A: [{ word: "hi", start: 1, end: 2 }] }, musicPath: "/m.wav", fileExists: () => true });
    expect(withWords.inputArgs).toEqual(["-ss", "4", "-i", "/m.wav"]);
    expect(withWords.music).toEqual({ path: "/m.wav", mode: "WORD_TIMINGS", regions: 1 });
    expect(withWords.parts.join(";")).toContain("volume='pow(10,(-20-12*min(1,");
    expect(withWords.parts.join(";")).toContain("afade=t=out:st=4.5:d=1.5");
    const noWords = buildAudioMix({ timeline: t, duration: 6, anyAudio: true, firstInput: 1, sourceWords: {}, musicPath: "/m.wav", fileExists: () => true });
    expect(noWords.music?.mode).toBe("SIDECHAIN");
    expect(noWords.parts.join(";")).toContain("[voice]asplit=2[voicemix][vkey]");
    expect(noWords.parts.join(";")).toContain("sidechaincompress");
    expect(noWords.parts.at(-1)).toMatch(/^\[voicemix\]\[music\]amix=inputs=2/);
  });
});

/** Mono float PCM at 8 kHz (optionally through an audio filter) — for energy measurements. */
function pcm(file: string, af = "anull"): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-af", `${af},aresample=8000`, "-ac", "1", "-f", "f32le", "-"]);
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(err));
      const b = Buffer.concat(chunks);
      resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)));
    });
  });
}
function rms(x: Float32Array, from: number, to: number, sr = 8000): number {
  const a = Math.max(0, Math.round(from * sr));
  const b = Math.min(x.length, Math.round(to * sr));
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, b - a));
}

describe("motion compositing + sound design (real ffmpeg)", () => {
  let dir: string;
  let take: string;
  let overlay: string;
  let music: string;
  let sfx: string;
  // Speech = 440 Hz bursts at [0.5,1.5) and [3,4); silence elsewhere.
  const words = [
    { word: "one", start: 0.5, end: 1.0 },
    { word: "two", start: 1.05, end: 1.5 },
    { word: "three", start: 3.0, end: 4.0 },
  ];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-motion-mix-"));
    take = join(dir, "take.mp4");
    overlay = join(dir, "overlay.mov");
    music = join(dir, "music.wav");
    sfx = join(dir, "sfx.wav");
    await runFfmpegRaw([
      "-y", "-f", "lavfi", "-i", "color=c=0x404040:s=540x960:r=30:d=6",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
      "-filter_complex", "[1:a]volume='if(between(t,0.5,1.5)+between(t,3,4),0.5,0)':eval=frame[a]",
      "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", take,
    ]);
    // 2 s alpha clip: an opaque green square at (100,200) 300x300, transparent elsewhere.
    await runFfmpegRaw([
      "-y", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=30:d=2,format=rgba,geq=r=0:g=255:b=0:a='255*between(X,100,399)*between(Y,200,499)'",
      "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", overlay,
    ]);
    await runFfmpegRaw(["-y", "-f", "lavfi", "-i", "sine=frequency=3000:sample_rate=48000:duration=12", "-ac", "2", music]);
    await runFfmpegRaw(["-y", "-f", "lavfi", "-i", "anoisesrc=d=0.3:c=white:a=0.5:r=48000", "-ac", "2", sfx]);
  }, 60000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("overlays the alpha layer only inside its window, adds SFX hits and ducks the music under speech", async () => {
    const out = join(dir, "out.mp4");
    const timeline = base({
      visuals: [visual("v1", 2, 4)],
      sfx: [{ id: "s1", at: 5, sound: "CLICK", volume: 1 }],
      audio: { normalize: true, sfxEnabled: true, music: { musicAssetId: "M", trackStart: 1, levelDb: -18, duckDb: 12, fadeInSeconds: 0, fadeOutSeconds: 0 } },
    });
    const res = await renderTimeline({
      timeline,
      sources: { A: take },
      sourceWords: { A: words },
      outputPath: out,
      encode: { preset: "ultrafast", crf: 28 },
      visualsLayer: { segments: [{ path: overlay, start: 2, end: 4, id: "v1" }] },
      musicPath: music,
      sfxFiles: { WHOOSH: sfx, CLICK: sfx },
    });
    expect(res.warnings).toEqual([]);
    expect(res.motion.overlays).toBe(1);
    expect(res.motion.sfxEvents.map((e) => e.at)).toEqual([2, 5]);
    expect(res.motion.music?.mode).toBe("WORD_TIMINGS");
    const p = await probeMedia(out);
    expect(p.width).toBe(1080);
    expect(p.height).toBe(1920);
    expect(p.durationSeconds).toBeCloseTo(6, 1);

    const green = (r: number, g: number, b: number) => g > 180 && r < 90 && b < 90;
    const square = { x: 150, y: 250, width: 200, height: 200 };
    const inside = await grabRgbRegion(out, 3.0, square);
    expect(countRgb(inside, green) / (inside.length / 3)).toBeGreaterThan(0.95);
    const before = await grabRgbRegion(out, 1.0, square);
    expect(countRgb(before, green)).toBe(0);
    const after = await grabRgbRegion(out, 4.6, square);
    expect(countRgb(after, green)).toBe(0);
    // Transparent part of the layer leaves the picture untouched during the window.
    const outside = await grabRgbRegion(out, 3.0, { x: 600, y: 1200, width: 100, height: 100 });
    expect(countRgb(outside, green)).toBe(0);

    // SFX: broadband energy in a band between the voice (440 Hz) and music (3 kHz) tones jumps
    // at each hit, compared with the same gap just after the hit has ended.
    const hiss = await pcm(out, "highpass=f=1100,highpass=f=1100,lowpass=f=2000,lowpass=f=2000");
    expect(rms(hiss, 2.0, 2.25)).toBeGreaterThan(rms(hiss, 2.5, 2.8) * 3);
    expect(rms(hiss, 5.0, 5.25)).toBeGreaterThan(rms(hiss, 5.5, 5.8) * 3);

    // Music (3 kHz) is quieter under speech than in the gaps.
    const bed = await pcm(out, "bandpass=f=3000:width_type=q:w=8,bandpass=f=3000:width_type=q:w=8,bandpass=f=3000:width_type=q:w=8");
    const underSpeech = rms(bed, 0.8, 1.3);
    const gap = rms(bed, 2.4, 2.8);
    expect(underSpeech).toBeLessThan(gap * 0.5); // >= 6 dB of duck (12 dB requested)
    expect(rms(bed, 3.3, 3.8)).toBeLessThan(rms(bed, 4.6, 4.9) * 0.5);
  }, 120000);
});
