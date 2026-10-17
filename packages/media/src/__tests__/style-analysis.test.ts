import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectCuts,
  isClipping,
  measureFrameChanges,
  measureStyleLoudness,
  measureVoiceBackground,
  parseStyleLoudnessStderr,
  parseVideoProbe,
  probeVideo,
  type FrameChange,
} from "../style-analysis";
import { runFfmpegRaw } from "./ffmpeg-test-helpers";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "face-portrait-pd.jpg");
const FPS = 30;

/**
 * Cut detection on synthetic talking-head edits with KNOWN cut times: a continuous "head-bob"
 * source (the public-domain portrait drifting + sensor grain), cut up the way a jump-cut edit
 * removes pauses (segments from non-contiguous times), plus a punch-in and a hard cut to other
 * footage. The full accuracy study (148 cuts, 3 motion styles, held-out set) is in
 * docs/decisions-pending/reference-videos.md.
 */
describe("cut detection on synthetic edits", () => {
  let dir: string;
  let edited: string;
  let truth: number[];
  let continuous: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-cuts-test-"));
    const src = join(dir, "src.mp4");
    await runFfmpegRaw([
      "-y", "-v", "error", "-loop", "1", "-framerate", String(FPS), "-i", FIXTURE, "-t", "16",
      "-vf", "scale=1200:2134,setsar=1,crop=1080:1920:60+40*sin(2*PI*t/3.1)+15*sin(2*PI*t/1.7):107+20*sin(2*PI*t/2.3),noise=alls=8:allf=t,scale=360:640,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", src,
    ]);
    continuous = join(dir, "continuous.mp4");
    await runFfmpegRaw(["-y", "-v", "error", "-i", src, "-t", "6", "-c", "copy", continuous]);
    // Segments in frames: [fromFrame, frames, zoom?, broll?]
    const segs: Array<{ from: number; frames: number; zoom?: number; broll?: boolean }> = [
      { from: 0, frames: 66 },
      { from: 90, frames: 51 },
      { from: 170, frames: 57, zoom: 1.2 }, // punch-in
      { from: 240, frames: 36 },
      { from: 0, frames: 30, broll: true }, // hard cut to other footage
      { from: 300, frames: 75 },
      { from: 400, frames: 45 },
    ];
    const parts = segs.map((s, i) => {
      if (s.broll) return `testsrc2=s=360x640:r=${FPS}:d=${s.frames / FPS},format=yuv420p,setsar=1[v${i}]`;
      const z = s.zoom ?? 1;
      const w = Math.round(360 / z / 2) * 2;
      const h = Math.round(640 / z / 2) * 2;
      return `[0:v]trim=start_frame=${s.from}:end_frame=${s.from + s.frames},setpts=PTS-STARTPTS,crop=${w}:${h}:${(360 - w) / 2}:${(640 - h) / 4},scale=360:640,setsar=1[v${i}]`;
    });
    edited = join(dir, "edited.mp4");
    await runFfmpegRaw([
      "-y", "-v", "error", "-i", src,
      "-filter_complex", `${parts.join(";")};${segs.map((_, i) => `[v${i}]`).join("")}concat=n=${segs.length}:v=1:a=0[out]`,
      "-map", "[out]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-r", String(FPS), edited,
    ]);
    truth = [];
    let f = 0;
    segs.forEach((s, i) => {
      if (i > 0) truth.push(f / FPS);
      f += s.frames;
    });
  }, 120_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds every jump cut, the punch-in and the hard cut, at the right frame, with no extras", async () => {
    const frames = await measureFrameChanges(edited);
    expect(frames.length).toBe(360);
    const cuts = detectCuts(frames);
    expect(cuts).toHaveLength(truth.length);
    cuts.forEach((c, i) => expect(Math.abs(c - truth[i]!)).toBeLessThanOrEqual(1 / FPS + 1e-6));
  }, 60_000);

  it("finds nothing in one continuous moving shot", async () => {
    expect(detectCuts(await measureFrameChanges(continuous))).toEqual([]);
  }, 60_000);

  it("pure rules: a one-frame spike is a cut, smooth motion isn't, flashes merge", () => {
    const mk = (mads: number[], scene: number[] = []): FrameChange[] => mads.map((mad, i) => ({ t: i / FPS, mad, scene: scene[i] ?? 0 }));
    const smooth = Array.from({ length: 60 }, (_, i) => 3 + Math.sin(i / 5));
    expect(detectCuts(mk(smooth))).toEqual([]);
    const spiked = [...smooth];
    spiked[30] = 9;
    expect(detectCuts(mk(spiked))).toEqual([1]);
    // Below the absolute floor: a tiny spike in a near-static shot is noise.
    const still = Array.from({ length: 60 }, () => 0.3);
    still[30] = 2;
    expect(detectCuts(mk(still))).toEqual([]);
    // Scene score alone counts; two candidates 3 frames apart keep only the stronger.
    const sc = Array.from({ length: 60 }, () => 0);
    sc[20] = 0.2;
    sc[23] = 0.5;
    expect(detectCuts(mk(Array.from({ length: 60 }, () => 1), sc))).toEqual([Math.round((23 / FPS) * 1000) / 1000]);
  });
});

describe("audio measurements", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-loud-test-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("measures integrated loudness of a known tone and flags clipping", async () => {
    const clean = join(dir, "clean.wav");
    const clipped = join(dir, "clipped.wav");
    // EBU Tech 3341 reference: a 1 kHz sine at -23 dBFS RMS in both stereo channels reads -23 LUFS.
    // lavfi's sine peaks at 1/8 (-18.06 dBFS) → RMS -21.07 → -1.93 dB more.
    await runFfmpegRaw(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=f=1000:d=4:sample_rate=48000", "-af", "volume=-1.93dB", "-ac", "2", "-c:a", "pcm_s16le", clean]);
    await runFfmpegRaw(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=f=220:d=4:sample_rate=48000", "-af", "volume=20dB", "-c:a", "pcm_s16le", clipped]);
    const a = await measureStyleLoudness(clean);
    expect(a.integratedLufs).not.toBeNull();
    expect(Math.abs(a.integratedLufs! - -23)).toBeLessThan(0.5);
    expect(a.clipping).toBe(false);
    const b = await measureStyleLoudness(clipped);
    expect(b.clipping).toBe(true);
    expect(b.samplePeakDb!).toBeGreaterThan(-0.3);
  }, 60_000);

  it("parses the ebur128 + astats summary; clipping rule", () => {
    const stderr = `[Parsed_ebur128_0] Summary:\n\n  Integrated loudness:\n    I:         -14.2 LUFS\n  Loudness range:\n    LRA:         5.1 LU\n  True peak:\n    Peak:       -0.8 dBFS\n[Parsed_astats_1] Overall\n[Parsed_astats_1] Peak level dB: -0.900000\n[Parsed_astats_1] Flat factor: 0.000000\n[Parsed_astats_1] Peak count: 2.000000\n`;
    expect(parseStyleLoudnessStderr(stderr)).toMatchObject({ integratedLufs: -14.2, loudnessRangeLu: 5.1, truePeakDbtp: -0.8, samplePeakDb: -0.9, peakCount: 2, clipping: false });
    expect(isClipping(-0.01, 500, 0)).toBe(true); // repeated full-scale peaks
    expect(isClipping(0.0, 2, 3)).toBe(true); // flat tops
    expect(isClipping(0.9, 1, 0)).toBe(true); // a lossy encode overshooting full scale
    expect(isClipping(-0.01, 2, 0)).toBe(false); // one stray peak
    expect(isClipping(-3, 1000, 5)).toBe(false);
  });

  /** 16 kHz mono: a "voice" (syllable bursts of a 200 Hz tone) with optional steady background. */
  function synth(opts: { voiceAmp: number; bgAmp: number }): { pcm: Float32Array; words: Array<{ start: number; end: number }> } {
    const sr = 16000;
    const dur = 10;
    const pcm = new Float32Array(sr * dur);
    const words: Array<{ start: number; end: number }> = [];
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    for (let t = 0.3; t < dur - 0.5; t += 0.4) words.push({ start: t, end: t + 0.3 });
    for (let i = 0; i < pcm.length; i++) {
      const t = i / sr;
      const inWord = words.some((w) => t >= w.start && t < w.end);
      // Syllable envelope: speech energy rises and falls within a word.
      const w = words.find((x) => t >= x.start && t < x.end);
      const env = inWord && w ? Math.sin((Math.PI * (t - w.start)) / (w.end - w.start)) : 0;
      pcm[i] = opts.voiceAmp * env * Math.sin(2 * Math.PI * 200 * t) + opts.bgAmp * rnd();
    }
    return { pcm, words };
  }

  it("music bed under the voice: reports roughly how far under (±4 dB)", () => {
    // Voice peaks 0.3 → energy-mean in words ≈ -16 dBFS; noise bed RMS = amp/√3.
    for (const underDb of [12, 18, 24]) {
      const voiceDb = 20 * Math.log10(0.3 / 2); // sine RMS (0.707) × sin-envelope RMS (0.707)
      const bgRms = 10 ** ((voiceDb - underDb) / 20);
      const { pcm, words } = synth({ voiceAmp: 0.3, bgAmp: bgRms * Math.sqrt(3) });
      const r = measureVoiceBackground(pcm, 16000, words, 10);
      expect(r.background).toBe("present");
      expect(Math.abs(r.differenceDb! - underDb)).toBeLessThan(4);
    }
  });

  it("clean voice (silence between words) → no background; no words → unknown", () => {
    const { pcm, words } = synth({ voiceAmp: 0.3, bgAmp: 0.0002 });
    const r = measureVoiceBackground(pcm, 16000, words, 10);
    expect(r.background).toBe("none");
    expect(r.differenceDb).toBeNull();
    expect(measureVoiceBackground(pcm, 16000, [], 10).background).toBe("unknown");
  });
});

describe("probe", () => {
  it("honours phone rotation metadata and reads fps", () => {
    const p = parseVideoProbe({
      format: { duration: "12.5" },
      streams: [
        { codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30000/1001", side_data_list: [{ rotation: -90 }] },
        { codec_type: "audio" },
      ],
    });
    expect(p).toMatchObject({ durationS: 12.5, width: 1080, height: 1920, fps: 29.97, hasVideo: true, hasAudio: true });
    expect(parseVideoProbe({ streams: [{ codec_type: "audio" }] })).toMatchObject({ hasVideo: false, width: null });
  });

  it("probes a real file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chris-probe-test-"));
    try {
      const f = join(dir, "v.mp4");
      await runFfmpegRaw(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=180x320:r=25:d=1", "-c:v", "libx264", "-preset", "veryfast", f]);
      expect(await probeVideo(f)).toMatchObject({ width: 180, height: 320, fps: 25, hasVideo: true, hasAudio: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
