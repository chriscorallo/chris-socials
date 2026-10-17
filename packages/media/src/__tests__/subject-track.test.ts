import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runFfmpegRaw } from "./ffmpeg-test-helpers";
import {
  analyzeSubjectTrackDetailed,
  decodeUltraFace,
  letterbox,
} from "../subject-track";
import {
  chooseDominantFace,
  expandFaceToProtectedRegion,
  nonMaxSuppression,
  parseSubjectTrack,
  smoothFaceTrack,
  subjectBoxAt,
  bodyRegionFromHead,
  type SubjectTrack,
} from "../subject-track-core";

const here = dirname(fileURLToPath(import.meta.url));
/** Public-domain portrait (US federal government work) — see fixtures/NOTICE.txt. */
const FACE = join(here, "fixtures", "face-portrait-pd.jpg");

describe("subject-track core (pure)", () => {
  it("fills short gaps, keeps long ones null", () => {
    const box = { x: 0.4, y: 0.2, w: 0.2, h: 0.1 };
    const track: SubjectTrack = [
      { t: 0, box },
      { t: 0.33, box: null },
      { t: 0.67, box: { ...box, x: 0.5 } },
      { t: 1, box: null },
      { t: 1.33, box: null },
      { t: 1.67, box: null },
      { t: 2, box: null },
      { t: 2.33, box: { ...box, x: 0.5 } },
    ];
    const out = smoothFaceTrack(track, { medianWindow: 1, emaAlpha: 1 });
    expect(out[1]!.box!.x).toBeCloseTo(0.45, 2);
    expect(out[3]!.box).toBeNull();
    expect(out[6]!.box).toBeNull();
  });

  it("median filter removes a single-frame jump (e.g. a false detection)", () => {
    const box = { x: 0.4, y: 0.2, w: 0.2, h: 0.1 };
    const track: SubjectTrack = Array.from({ length: 9 }, (_, i) => ({ t: i / 3, box: i === 4 ? { ...box, x: 0.9 } : box }));
    const out = smoothFaceTrack(track);
    expect(Math.max(...out.map((s) => s.box!.x))).toBeCloseTo(0.4, 5);
  });

  it("prefers the big, confident, continuous face over a small background one", () => {
    const speaker = { box: { x: 0.3, y: 0.2, w: 0.35, h: 0.2 }, score: 0.9 };
    const poster = { box: { x: 0.8, y: 0.1, w: 0.08, h: 0.05 }, score: 0.99 };
    expect(chooseDominantFace([poster, speaker], null)).toBe(speaker);
    expect(chooseDominantFace([], null)).toBeNull();
  });

  it("NMS merges overlapping detections", () => {
    const a = { box: { x: 0.3, y: 0.2, w: 0.2, h: 0.2 }, score: 0.9 };
    const b = { box: { x: 0.31, y: 0.21, w: 0.2, h: 0.2 }, score: 0.8 };
    const c = { box: { x: 0.7, y: 0.2, w: 0.1, h: 0.1 }, score: 0.75 };
    expect(nonMaxSuppression([b, a, c])).toEqual([a, c]);
  });

  it("expands the face to a protected head region (hair above, margin around) and derives the body", () => {
    const face = { x: 0.4, y: 0.3, w: 0.2, h: 0.1 };
    const p = expandFaceToProtectedRegion(face);
    expect(p.x).toBeLessThan(face.x);
    expect(p.y).toBeCloseTo(0.3 - 0.06, 5);
    expect(p.x + p.w).toBeGreaterThan(face.x + face.w);
    expect(p.y + p.h).toBeGreaterThan(face.y + face.h);
    const body = bodyRegionFromHead(p);
    expect(body.y).toBeCloseTo(p.y + p.h, 5);
    expect(body.y + body.h).toBeCloseTo(1, 5);
    expect(body.w).toBeGreaterThan(p.w);
  });

  it("subjectBoxAt interpolates between samples and gives up across long gaps", () => {
    const track: SubjectTrack = [
      { t: 0, box: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 } },
      { t: 0.5, box: { x: 0.4, y: 0.2, w: 0.2, h: 0.2 } },
      { t: 5, box: { x: 0.4, y: 0.2, w: 0.2, h: 0.2 } },
    ];
    expect(subjectBoxAt(track, 0.25)!.x).toBeCloseTo(0.3, 5);
    expect(subjectBoxAt(track, 2.5)).toBeNull();
    expect(subjectBoxAt(track, 5.2)!.x).toBeCloseTo(0.4, 5);
    expect(subjectBoxAt([], 1)).toBeNull();
  });

  it("parseSubjectTrack is defensive", () => {
    expect(parseSubjectTrack(null)).toBeNull();
    expect(parseSubjectTrack([{ t: "x" }])).toBeNull();
    expect(parseSubjectTrack([{ t: 0, box: null }])).toEqual([{ t: 0, box: null }]);
  });

  it("decodes UltraFace boxes back through the letterbox into source fractions", () => {
    const input = { width: 640, height: 480 };
    const geom = letterbox({ width: 1080, height: 1920 }, input); // portrait -> pillarboxed
    expect(geom.ch).toBe(480);
    expect(geom.cw).toBe(270);
    expect(geom.padX).toBe(185);
    // One anchor: face covering the middle of the content area.
    const x1 = (185 + 0.25 * 270) / 640;
    const x2 = (185 + 0.75 * 270) / 640;
    const dets = decodeUltraFace(new Float32Array([0.1, 0.9, 0.9, 0.1]), new Float32Array([x1, 0.25, x2, 0.5, 0, 0, 0.1, 0.1]), geom, input, 0.7);
    expect(dets).toHaveLength(1);
    expect(dets[0]!.box.x).toBeCloseTo(0.25, 3);
    expect(dets[0]!.box.w).toBeCloseTo(0.5, 3);
    expect(dets[0]!.box.y).toBeCloseTo(0.25, 3);
  });
});

/**
 * SLOW (real ffmpeg + real ONNX detector): a real public-domain face composited onto a
 * 1080x1920 frame, sliding left -> right; the track must follow it.
 */
describe("analyzeSubjectTrack on a real moving face (slow)", () => {
  let dir: string;
  let video: string;
  // Overlay placement: portrait scaled to 500 px wide; its face spans roughly x 205-415,
  // y 115-355 of the 500x625 image (centre ~ (310, 235)).
  const overlayX = (t: number) => 40 + 90 * t;
  const overlayY = 420;
  const faceCentre = (t: number) => ({ x: (overlayX(t) + 310) / 1080, y: (overlayY + 235) / 1920 });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-subject-track-"));
    video = join(dir, "moving-face.mp4");
    await runFfmpegRaw([
      "-y",
      "-f", "lavfi", "-i", "color=c=0x3a4452:s=1080x1920:d=6:r=30",
      "-loop", "1", "-i", FACE,
      "-filter_complex", `[1:v]scale=500:-2[f];[0:v][f]overlay=x='40+90*t':y=${overlayY}:shortest=1,format=yuv420p`,
      "-t", "6",
      "-c:v", "libx264", "-preset", "ultrafast",
      video,
    ]);
  }, 60000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("follows the face across the frame", async () => {
    await analyzeSubjectTrackDetailed(video, { fps: 3 }); // warm: loads onnxruntime + model once per process
    const started = Date.now();
    const res = await analyzeSubjectTrackDetailed(video, { fps: 3 });
    const elapsed = (Date.now() - started) / 1000;
    expect(res.source).toEqual({ width: 1080, height: 1920 });
    expect(res.framesAnalyzed).toBeGreaterThanOrEqual(17);
    expect(res.framesWithFace / res.framesAnalyzed).toBeGreaterThan(0.85);
    // Well under real time (6 s clip at 1080x1920).
    expect(elapsed).toBeLessThan(4);

    for (const t of [1, 3, 5]) {
      const box = subjectBoxAt(res.track, t)!;
      expect(box).not.toBeNull();
      const want = faceCentre(t);
      // The protected region contains the face centre...
      expect(want.x).toBeGreaterThan(box.x);
      expect(want.x).toBeLessThan(box.x + box.w);
      expect(want.y).toBeGreaterThan(box.y);
      expect(want.y).toBeLessThan(box.y + box.h);
      // ...and is centred on it horizontally (smoothing lag allowed).
      expect(Math.abs(box.x + box.w / 2 - want.x)).toBeLessThan(0.08);
      // A head, not the whole frame.
      expect(box.w).toBeLessThan(0.5);
    }
    const c1 = subjectBoxAt(res.track, 1)!;
    const c5 = subjectBoxAt(res.track, 5)!;
    expect(c5.x - c1.x).toBeGreaterThan(0.25);
  }, 60000);
});
