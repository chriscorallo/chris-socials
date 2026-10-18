import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FFMPEG_PATH, bakeFrameAt, graphicBakeKey, stableStringify, type GraphicBakeInput } from "@chris/media";
import { buildFrameIndex, decodeRange, findMoov, frameAt, parseMp4, samplePts, type Mp4Info } from "./mp4";
import { audioPieces, planSegments, segmentAt, segmentsFrom, sourceTimeAt, CUT_FADE_S } from "./plan";
import { MasterClock, type ClockSource } from "./clock";
import { chooseEngine } from "./select";
import { adtsHeader, CHUNK_FRAMES } from "./audio";
import { EditorHealth, percentile, scrubErrorText, HEALTH_GLITCH_WINDOW_MS } from "../health";
import { EditorHealthReportSchema } from "../health-schema";

/**
 * The compositor preview engine's pure pieces (docs/decisions-pending/editor-rebuild.md):
 * demuxing our own ffmpeg output, the decode/audio plan, the master clock, engine selection,
 * bake keys (sprite cache invalidation) and the health recorder.
 */

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let err = "";
    p.stderr.on("data", (c) => (err += String(c)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-800)))));
  });
}

const clip = (id: string, asset: string, s: number, e: number, volume = 1) => ({ id, mediaAssetId: asset, sourceStart: s, sourceEnd: e, volume, crop: { zoom: 1, panX: 0, panY: 0 } });

describe("mp4 demuxer on real ffmpeg output (proxy-like: H.264 B-frames, 0.5 s GOP, AAC, faststart)", () => {
  let dir = "";
  let bytes: Uint8Array;
  let info: Mp4Info;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-mp4-"));
    const f = join(dir, "p.mp4");
    await ffmpeg([
      "-f", "lavfi", "-i", "testsrc2=s=180x320:r=30",
      "-f", "lavfi", "-i", "sine=f=440:sample_rate=48000",
      "-t", "2", "-c:v", "libx264", "-profile:v", "high", "-g", "15", "-keyint_min", "15", "-sc_threshold", "0", "-bf", "2",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-movflags", "+faststart", f,
    ]);
    bytes = new Uint8Array(await readFile(f));
    info = parseMp4(bytes)!;
  }, 60_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("finds moov only once it has fully arrived (progressive download)", () => {
    const m = findMoov(bytes)!;
    expect(m.start).toBeLessThan(200); // faststart: right after ftyp
    expect(findMoov(bytes.subarray(0, m.end - 1))).toBeNull();
    expect(parseMp4(bytes.subarray(0, m.end))?.tracks.length).toBe(2);
  });

  it("video: codec string, size, 60 frames, a key frame every 15, pts from 0 in 1/30 steps", () => {
    const v = info.tracks.find((t) => t.kind === "video")!;
    expect(v.codec).toMatch(/^avc1\.64/);
    expect(v.description?.length).toBeGreaterThan(10);
    expect([v.width, v.height]).toEqual([180, 320]);
    expect(v.count).toBe(60);
    expect(Array.from(v.keys).reduce((a, b) => a + b, 0)).toBe(4);
    const fi = buildFrameIndex(v);
    expect(fi.pts[0]).toBeCloseTo(0, 6);
    expect(fi.frameDur).toBeCloseTo(1 / 30, 6);
    for (let i = 1; i < fi.pts.length; i++) expect(fi.pts[i]! - fi.pts[i - 1]!).toBeCloseTo(1 / 30, 4);
    // B-frames: decode order differs from presentation order somewhere
    expect(Array.from(fi.order).some((d, p) => d !== p)).toBe(true);
    // every sample's bytes are inside the file
    for (let i = 0; i < v.count; i++) expect(v.offsets[i]! + v.sizes[i]!).toBeLessThanOrEqual(bytes.length);
  });

  it("decodeRange starts at the key frame before the span and covers every frame in it", () => {
    const v = info.tracks.find((t) => t.kind === "video")!;
    const fi = buildFrameIndex(v);
    const r = decodeRange(v, fi, 0.6, 0.9); // frames 18..26, GOP starts at 15
    expect(r.from).toBe(15);
    expect(v.keys[r.from]).toBe(1);
    for (let p = frameAt(fi, 0.6); p <= frameAt(fi, 0.9 - 1e-6); p++) {
      const d = fi.order[p]!;
      expect(d).toBeGreaterThanOrEqual(r.from);
      expect(d).toBeLessThanOrEqual(r.to);
    }
    expect(frameAt(fi, 0.61)).toBe(18);
    expect(samplePts(v, fi.order[18]!)).toBeCloseTo(0.6, 4);
  });

  it("audio: AAC config, 48 kHz stereo, priming shift from the edit list; ADTS headers frame it", () => {
    const a = info.tracks.find((t) => t.kind === "audio")!;
    expect(a.codec).toBe("mp4a.40.2");
    expect([a.sampleRate, a.channels]).toEqual([48000, 2]);
    expect((a.description?.[0] ?? 0) >> 3).toBe(2); // AAC-LC object type in the AudioSpecificConfig
    expect(a.editShift).toBe(1024);
    expect(samplePts(a, 1)).toBeCloseTo(0, 6);
    const h = adtsHeader(300, 2, 48000, 2);
    expect([h[0], h[1]! & 0xf6]).toEqual([0xff, 0xf0]);
    expect(((h[3]! & 3) << 11) | (h[4]! << 3) | (h[5]! >> 5)).toBe(307); // frame length incl. header
    expect((h[2]! >> 2) & 0xf).toBe(3); // 48 kHz index
    expect(CHUNK_FRAMES * 1024 / 48000).toBeGreaterThan(3.5);
  });
});

describe("playback plan", () => {
  const doc = {
    clips: [clip("a", "T1", 0, 2), clip("b", "T1", 2, 3), clip("c", "T1", 4, 5, 0.5), clip("d", "T2", 1, 2)],
  };
  it("segments: output times, continuation vs jump", () => {
    const s = planSegments(doc);
    expect(s.map((x) => [x.outStart, x.outEnd])).toEqual([[0, 2], [2, 3], [3, 4], [4, 5]]);
    expect(s.map((x) => x.continues)).toEqual([false, true, false, false]);
    expect(s.map((x) => x.segIndex)).toEqual([0, 1, 2, 3]);
  });
  it("locates output time → segment / source time (a cut belongs to the next clip)", () => {
    const s = planSegments(doc);
    expect(segmentAt(s, 0)).toBe(0);
    expect(segmentAt(s, 1.999)).toBe(0);
    expect(segmentAt(s, 2)).toBe(1);
    expect(segmentAt(s, 99)).toBe(3);
    expect(sourceTimeAt(s, 3.5)).toEqual({ seg: 2, src: 4.5 });
  });
  it("segmentsFrom trims the first span to the playhead and drops slivers", () => {
    const s = planSegments(doc);
    const f = segmentsFrom(s, 2.5, 1);
    expect(f[0]).toMatchObject({ segIndex: 1, outStart: 2.5, srcStart: 2.5, continues: false });
    expect(f.map((x) => x.segIndex)).toEqual([1, 2]);
    // at (almost) the end of a span → the sliver is dropped, the plan starts at the next span
    expect(segmentsFrom(s, 2 - 1e-6, 0.5)[0]!.segIndex).toBe(1);
  });
  it("audio pieces: gain per clip, ramps at hard cuts only (continuations stay seamless)", () => {
    const p = audioPieces(planSegments(doc));
    expect(p.map((x) => [x.fadeIn, x.fadeOut])).toEqual([
      [CUT_FADE_S, 0],
      [0, CUT_FADE_S],
      [CUT_FADE_S, CUT_FADE_S],
      [CUT_FADE_S, CUT_FADE_S],
    ]);
    expect(p[2]!.gain).toBe(0.5);
  });
});

describe("master clock", () => {
  const fake = (kind: ClockSource["kind"] = "audio") => {
    const s = { t: 10, lat: 0, kind, now: () => s.t, latency: () => s.lat };
    return s;
  };
  it("holds until the scheduled start, then advances 1:1 with the source", () => {
    const src = fake();
    const c = new MasterClock();
    c.start(5, src, 10.05);
    expect(c.time()).toBe(5);
    src.t = 11.05;
    expect(c.time()).toBeCloseTo(6, 9);
    expect(c.sourceTimeFor(7)).toBeCloseTo(12.05, 9);
  });
  it("delays the picture by the output latency (what's heard)", () => {
    const src = fake();
    src.lat = 0.1;
    const c = new MasterClock();
    c.start(0, src, 10);
    src.t = 12;
    expect(c.time()).toBeCloseTo(1.9, 9);
  });
  it("stop freezes; rebase swaps the source without a jump", () => {
    const wall = fake("wall");
    const c = new MasterClock();
    c.start(3, wall, 10);
    wall.t = 11;
    const audio = fake("audio");
    audio.t = 500;
    c.rebase(audio);
    expect(c.kind).toBe("audio");
    expect(c.time()).toBeCloseTo(4, 9);
    audio.t = 501;
    expect(c.time()).toBeCloseTo(5, 9);
    expect(c.stop()).toBeCloseTo(5, 9);
    audio.t = 600;
    expect(c.time()).toBeCloseTo(5, 9);
  });
});

describe("engine selection (decoder fallback)", () => {
  const caps = { videoDecoder: true, webgl2: true, audioContext: true };
  it("compositor when WebCodecs + WebGL2 and every take has its proxy", () => {
    expect(chooseEngine({ caps, assets: [{ proxied: true }] }).engine).toBe("compositor");
  });
  it("falls back to the <video> engine", () => {
    expect(chooseEngine({ caps: { ...caps, videoDecoder: false }, assets: [{ proxied: true }] })).toMatchObject({ engine: "video", reason: expect.stringMatching(/WebCodecs/) });
    expect(chooseEngine({ caps: { ...caps, webgl2: false }, assets: [{ proxied: true }] }).engine).toBe("video");
    expect(chooseEngine({ caps, assets: [{ proxied: true }, { proxied: false }] }).reason).toMatch(/proxy/);
    expect(chooseEngine({ caps, assets: [] }).engine).toBe("video");
  });
  it("kill switch / forcing", () => {
    expect(chooseEngine({ caps, assets: [{ proxied: true }], override: "video" }).engine).toBe("video");
    expect(chooseEngine({ caps: { ...caps, videoDecoder: false }, assets: [{ proxied: true }], override: "compositor" }).engine).toBe("video");
  });
});

describe("baked graphics: cache key (invalidation) and frame math", () => {
  const base: GraphicBakeInput = {
    visual: { id: "v1", start: 2, end: 6, template: "BAR_CHART", props: { bars: [{ label: "A", value: 1 }, { label: "B", value: 2 }] }, placement: { mode: "AUTO", x: 0.5, y: 0.3, scale: 1 } },
    interaction: null,
    canvas: { width: 1080, height: 1920 },
    motionTheme: null,
    fps: 30,
  };
  const key = graphicBakeKey(base);
  it("stable across key order and ids; moving the graphic in time keeps its bake", () => {
    const reordered = { ...base, visual: { placement: base.visual.placement, props: base.visual.props, template: "BAR_CHART", end: 6, start: 2, id: "v1" } };
    expect(graphicBakeKey(reordered as GraphicBakeInput)).toBe(key);
    expect(graphicBakeKey({ ...base, visual: { ...base.visual, id: "other" } })).toBe(key);
    expect(graphicBakeKey({ ...base, visual: { ...base.visual, start: 10, end: 14 } })).toBe(key);
  });
  it("changes with anything that changes pixels", () => {
    const variants: GraphicBakeInput[] = [
      { ...base, visual: { ...base.visual, end: 7 } },
      { ...base, visual: { ...base.visual, props: { bars: [{ label: "A", value: 3 }, { label: "B", value: 2 }] } } },
      { ...base, visual: { ...base.visual, placement: { mode: "AUTO", x: 0.5, y: 0.31, scale: 1 } } },
      { ...base, interaction: { track: null, hitAtFrame: 12, scene: null, look: { shadow: 0.2 } } },
      { ...base, canvas: { width: 1080, height: 1350 } },
      { ...base, motionTheme: { palette: "MONO" } },
      { ...base, fps: 60 },
    ];
    const keys = new Set(variants.map(graphicBakeKey));
    expect(keys.size).toBe(variants.length);
    expect(keys.has(key)).toBe(false);
  });
  it("stableStringify drops undefined and sorts keys", () => {
    expect(stableStringify({ b: 1, a: undefined, c: [1, undefined] })).toBe('{"b":1,"c":[1,null]}');
  });
  it("bake frame at output time = the renderer's frame (from = round(start·fps))", () => {
    const v = { start: 2.01, end: 6 };
    expect(bakeFrameAt(v, 1.99, 30)).toBeNull();
    expect(bakeFrameAt(v, 2.0, 30)).toBe(0); // round(60.3) = 60 → its frame 0 is output frame 60 (t = 2.0)
    expect(bakeFrameAt(v, 2.05, 30)).toBe(1);
    expect(bakeFrameAt(v, 5.99, 30)).toBe(119);
    expect(bakeFrameAt(v, 6.0, 30)).toBeNull();
  });
});

describe("editor health recorder", () => {
  it("counts presented vs expected frames, stalls, scrub latency; glitch keeps the last 20 s", () => {
    let now = 0;
    const h = new EditorHealth({ sessionId: "s-test", contentItemId: "c1", now: () => now });
    now = 300;
    h.mark("firstFrame");
    h.mark("firstFrame"); // first wins
    h.setPlaying(true);
    for (let i = 0; i < 60; i++) {
      now += 1000 / 30;
      if (i % 4 !== 0) h.framePresented(); // drop every 4th
    }
    h.rafGap(80); // not a stall
    h.rafGap(260);
    h.rafGap(1400);
    h.setPlaying(false);
    h.scrubLatency(20);
    h.scrubLatency(40);
    h.scrubLatency(300);
    h.error("TypeError at https://example.com/x?token=abc and /api/media/raw/secret.mov");
    now += 30_000;
    h.event("late");
    const r = h.report("session");
    expect(r.marks.firstFrame).toBe(300);
    expect(r.totals.presented).toBe(45);
    expect(r.totals.expected).toBe(60);
    expect(r.totals.dropped).toBe(15);
    expect(r.totals.droppedPct).toBe(25);
    expect([r.totals.stalls100, r.totals.stalls250, r.totals.stalls1000, r.totals.maxStallMs]).toEqual([2, 2, 1, 1400]);
    expect(r.totals.scrubP95).toBe(300);
    expect(r.errors[0]).not.toMatch(/token|secret/);
    expect(r.fps.length).toBeGreaterThan(0);
    const g = h.report("glitch", "it froze");
    expect(g.events.every((e) => e.t >= now - HEALTH_GLITCH_WINDOW_MS)).toBe(true);
    expect(g.events.map((e) => e.type)).toEqual(["late"]);
    // what the endpoint accepts
    expect(EditorHealthReportSchema.safeParse(JSON.parse(JSON.stringify(r))).success).toBe(true);
    expect(EditorHealthReportSchema.safeParse({ ...r, edit: { title: "x".repeat(400) } }).success).toBe(false);
  });
  it("helpers", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([], 0.5)).toBeNull();
    expect(scrubErrorText("x".repeat(500)).length).toBe(200);
  });
});
