import { describe, expect, it } from "vitest";
import { EditTimelineSchema, type EditTimelineInput } from "../timeline";
import { cropGeometry } from "../timeline-layout";
import { TimelineVisualSchema, VISUAL_INTERACTION_DEFAULTS } from "../motion-contract";
import {
  anchorOffsetFor,
  applyCoupledTransform,
  applyInteractionDefaults,
  buildVisualInteractions,
  cameraCouplingTransform,
  canvasRectToSourceRect,
  mapSourcePointToCanvas,
  matteDimensionsFor,
  mergeSceneStats,
  outputEmphasisWords,
  pickEmphasisHit,
  sceneLook,
  sceneStatsFromRgb,
  unzoomRect,
  visualMotionTrack,
  zeroPhaseSmooth,
  type EmphasisWord,
} from "../visual-interaction";
import { solveVisualPlacements } from "../visual-placement";
import { windowLevels } from "../scene-analysis";
import { rgbToModnetInput, stabilizeAlpha, tightenAlpha, matteInferenceSize, matteStorageKeyFor } from "../person-matte";

const canvas = { width: 1080, height: 1920 };
const base = (extra: Partial<EditTimelineInput> = {}) =>
  EditTimelineSchema.parse({
    version: 2,
    clips: [{ id: "c1", mediaAssetId: "A", sourceStart: 0, sourceEnd: 10 }],
    captions: { enabled: false, fontId: "inter-display-bold", fontSize: 60, color: "#FFFFFF", highlightColor: "#FFD54A" },
    ...extra,
  });
const visual = (extra: Record<string, unknown> = {}) =>
  TimelineVisualSchema.parse({
    id: "v1",
    template: "STAT_CARD",
    props: { value: "7%", label: "Return" },
    start: 2,
    end: 6,
    placement: { mode: "MANUAL", x: 0.5, y: 0.3, scale: 1 },
    ...extra,
  });

describe("matte ↔ crop mapping", () => {
  it("a matte with the source aspect maps through the crop exactly like the footage", () => {
    const src = { width: 1080, height: 1920 };
    const m = matteDimensionsFor(src, 512);
    expect(m).toEqual({ width: 288, height: 512 });
    for (const crop of [{ zoom: 1, panX: 0, panY: 0 }, { zoom: 1.4, panX: 0.7, panY: -0.3 }]) {
      const a = cropGeometry(src, canvas, crop);
      const b = cropGeometry(m, canvas, crop);
      expect(b.scaledWidth).toBeCloseTo(a.scaledWidth, 3);
      expect(b.offsetX).toBeCloseTo(a.offsetX, 3);
      expect(b.offsetY).toBeCloseTo(a.offsetY, 3);
    }
    // Landscape source: aspect kept, even dims, never upscaled.
    expect(matteDimensionsFor({ width: 1920, height: 1080 }, 512)).toEqual({ width: 910, height: 512 });
    expect(matteDimensionsFor({ width: 320, height: 240 }, 512)).toEqual({ width: 320, height: 240 });
    expect(matteInferenceSize({ width: 1080, height: 1920 })).toEqual({ width: 288, height: 512 });
    expect(matteStorageKeyFor("ci", "ma")).toBe("mattes/ci/ma.mp4");
  });

  it("source point → canvas through crop then zoom; zoom inverse round-trips", () => {
    const src = { width: 1080, height: 1920 };
    const z = { zoom: 1.5, x: 0.4, y: 0.3 };
    const p = mapSourcePointToCanvas({ x: 0.5, y: 0.5 }, src, canvas, { zoom: 1, panX: 0, panY: 0 }, z);
    expect(p.x).toBeCloseTo(432 + (540 - 432) * 1.5, 6);
    expect(p.y).toBeCloseTo(576 + (960 - 576) * 1.5, 6);
    const r = { x: 100, y: 200, width: 300, height: 400 };
    const u = unzoomRect(r, z, canvas);
    const back = { x: 432 + (u.x - 432) * 1.5, w: u.width * 1.5 };
    expect(back.x).toBeCloseTo(100, 6);
    expect(back.w).toBeCloseTo(300, 6);
    const s = canvasRectToSourceRect({ x: 0, y: 0, width: 1080, height: 1920 }, { width: 540, height: 960 }, canvas, { zoom: 1, panX: 0, panY: 0 });
    expect(s).toEqual({ x: 0, y: 0, width: 540, height: 960 });
  });
});

describe("camera coupling", () => {
  it("scales a fraction of the zoom around the focal point", () => {
    const z = { zoom: 1.4, x: 0.5, y: 0.4 };
    expect(cameraCouplingTransform(z, 0, canvas).scale).toBe(1);
    expect(cameraCouplingTransform(z, 1, canvas).scale).toBeCloseTo(1.4, 9);
    const t = cameraCouplingTransform(z, 0.5, canvas);
    expect(t.scale).toBeCloseTo(1.2, 9);
    expect(t.originX).toBe(540);
    expect(t.originY).toBe(768);
    // coupling 1 moves a point exactly like the footage does.
    const p = applyCoupledTransform({ x: 900, y: 300 }, cameraCouplingTransform(z, 1, canvas));
    const f = mapSourcePointToCanvas({ x: 900 / 1080, y: 300 / 1920 }, canvas, canvas, { zoom: 1, panX: 0, panY: 0 }, z);
    expect(p.x).toBeCloseTo(f.x, 6);
    expect(p.y).toBeCloseTo(f.y, 6);
  });

  it("track: static outside zooms, coupled inside; none without a zoom", () => {
    const t = base({ zooms: [{ id: "z", start: 3, end: 5, zoom: 1.5, mode: "CUT", easeSeconds: 0, x: 0.5, y: 0.5 }] });
    const v = visual({ cameraCoupling: 0.4, placement: { mode: "MANUAL", x: 0.5, y: 0.4, scale: 0.8 } });
    const tr = visualMotionTrack(v, t, { subjectTracks: {} }, 30)!;
    expect(tr.s).toHaveLength(120);
    expect(tr.s[0]).toBe(1); // t=2.0
    expect(tr.s[45]).toBeCloseTo(1.2, 4); // t=3.5, 1 + 0.5*0.4
    expect(tr.y[45]).toBeCloseTo(960 + (768 - 960) * 1.2, 0);
    expect(tr.s[100]).toBe(1); // t=5.33
    expect(visualMotionTrack(v, base(), { subjectTracks: {} }, 30)).toBeNull();
    expect(visualMotionTrack({ ...v, cameraCoupling: 0 }, t, { subjectTracks: {} }, 30)).toBeNull();
  });
});

describe("subject anchor", () => {
  const track = Array.from({ length: 31 }, (_, i) => ({ t: i / 3, box: { x: 0.3 + 0.02 * Math.sin(i), y: 0.15, w: 0.4, h: 0.25 } }));

  it("follows the head + offset, smoothly (no tracker steps), clamped to the safe area", () => {
    const t = base();
    const v = visual({ anchor: { type: "SUBJECT", offsetX: 0, offsetY: 0.15 } });
    const tr = visualMotionTrack(v, t, { subjectTracks: { A: track } }, 30)!;
    expect(tr.x).toHaveLength(120);
    // Centre ≈ head centre x (0.5 ± sway) and head centre y + 0.3 H.
    for (const x of tr.x) expect(Math.abs(x - 540)).toBeLessThan(0.025 * 1080);
    expect(tr.y[60]).toBeCloseTo((0.15 + 0.125 + 0.15) * 1920, -1);
    // Smooth: frame-to-frame acceleration stays tiny (the raw 3 fps track has kinks).
    let maxAcc = 0;
    for (let i = 2; i < tr.x.length; i++) maxAcc = Math.max(maxAcc, Math.abs(tr.x[i]! - 2 * tr.x[i - 1]! + tr.x[i - 2]!));
    expect(maxAcc).toBeLessThan(1.5);
    // Offset pushing it off the top is clamped inside the safe area.
    const up = visualMotionTrack({ ...v, anchor: { type: "SUBJECT", offsetX: 0, offsetY: -0.5 } }, t, { subjectTracks: { A: track } }, 30)!;
    expect(Math.min(...up.y)).toBeGreaterThan(200);
  });

  it("cuts with the picture on a cut (no glide across clips)", () => {
    const t = base({
      clips: [
        { id: "c1", mediaAssetId: "A", sourceStart: 0, sourceEnd: 4 },
        { id: "c2", mediaAssetId: "B", sourceStart: 0, sourceEnd: 4 },
      ],
    });
    const left = Array.from({ length: 31 }, (_, i) => ({ t: i / 3, box: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 } }));
    const right = Array.from({ length: 31 }, (_, i) => ({ t: i / 3, box: { x: 0.6, y: 0.2, w: 0.3, h: 0.2 } }));
    const v = visual({ start: 3, end: 5, anchor: { type: "SUBJECT", offsetX: 0, offsetY: 0.2 }, placement: { mode: "MANUAL", x: 0.5, y: 0.5, scale: 0.6 } });
    const tr = visualMotionTrack(v, t, { subjectTracks: { A: left, B: right } }, 30)!;
    const cut = 30; // t = 4.0
    expect(tr.x[cut - 1]!).toBeLessThan(450);
    expect(tr.x[cut]!).toBeGreaterThan(600);
  });

  it("anchorOffsetFor keeps the visual where it is", () => {
    const off = anchorOffsetFor(visual(), base(), 3, { subjectTracks: { A: track } })!;
    expect(off.offsetY).toBeCloseTo(0.3 - 0.275, 2);
    expect(anchorOffsetFor(visual(), base(), 3, { subjectTracks: {} })).toBeNull();
  });

  it("zeroPhaseSmooth has no lag on a symmetric step", () => {
    const xs = [...Array(20).fill(0), ...Array(20).fill(10)];
    const sm = zeroPhaseSmooth(xs, 0.3);
    expect(sm[19]! + sm[20]!).toBeCloseTo(10, 0);
  });
});

describe("scene stats → look", () => {
  it("parses rgb24 into mean colour, luma and contrast", () => {
    const buf = Buffer.from([255, 255, 255, 0, 0, 0, 255, 255, 255, 0, 0, 0]);
    const s = sceneStatsFromRgb(buf);
    expect(s).toEqual({ r: 127.5, g: 127.5, b: 127.5, luma: 0.5, lumaStd: 0.5 });
    expect(() => sceneStatsFromRgb(Buffer.alloc(0))).toThrow();
    expect(mergeSceneStats([s, null, { ...s, r: 27.5 }])!.r).toBe(77.5);
    expect(mergeSceneStats([])).toBeNull();
  });

  it("bright footage → stronger scrim and shadow; warm → warmer whites; never extreme", () => {
    const dark = sceneLook({ r: 30, g: 30, b: 35, luma: 0.12, lumaStd: 0.05 });
    const bright = sceneLook({ r: 230, g: 220, b: 200, luma: 0.86, lumaStd: 0.1 });
    expect(bright.scrim).toBeGreaterThan(dark.scrim + 0.2);
    expect(bright.shadow.opacity).toBeGreaterThan(dark.shadow.opacity);
    expect(bright.gain.r).toBeGreaterThan(1);
    expect(bright.gain.b).toBeLessThan(1);
    for (const l of [dark, bright]) {
      expect(Math.abs(l.gain.r - 1)).toBeLessThanOrEqual(0.04);
      expect(l.lift).toBeLessThanOrEqual(0.03);
      expect(l.scrim).toBeLessThanOrEqual(0.5);
    }
    expect(bright.shadow.color).not.toBe("#000000");
    expect(sceneLook(null).scrim).toBe(0);
  });
});

describe("vocal emphasis → hit", () => {
  const words: EmphasisWord[] = [
    { word: "about", start: 2.3, end: 2.5, score: 0.1 },
    { word: "$24,500", start: 3.0, end: 3.6, score: 1.0 },
    { word: "really", start: 4.0, end: 4.3, score: 2.2 },
    { word: "debt", start: 5.6, end: 5.9, score: 3.0 },
  ];
  const counter = visual({ template: "NUMBER_COUNTER", props: { value: 24500, prefix: "$" }, start: 2, end: 6 });

  it("auto: prefers the very number the graphic shows; respects lead/hold", () => {
    expect(pickEmphasisHit(counter, words)).toBeCloseTo(3.04, 3);
    // without the number, the strongest word inside [start+0.45, end-0.9] — "debt" at 5.6 is too late
    const ring = { ...counter, props: { value: 7 } };
    expect(pickEmphasisHit(ring, words)).toBeCloseTo(4.04, 3);
  });

  it("emphasisAt: snaps to the nearest strong word, else lands exactly there; 0 = template timing", () => {
    expect(pickEmphasisHit({ ...counter, emphasisAt: 2.2 }, words)).toBeCloseTo(4.04, 3);
    expect(pickEmphasisHit({ ...counter, emphasisAt: 2.8 }, [])).toBeCloseTo(4.8, 3);
    expect(pickEmphasisHit({ ...counter, emphasisAt: 0 }, words)).toBeNull();
    // non-emphasis templates have no auto hit
    expect(pickEmphasisHit(visual(), words)).toBeNull();
  });

  it("z-scores loudness within each clip, maps to output time, numbers get a bonus", () => {
    const t = base({
      clips: [
        { id: "c1", mediaAssetId: "A", sourceStart: 1, sourceEnd: 3 },
        { id: "c2", mediaAssetId: "B", sourceStart: 0, sourceEnd: 2 },
      ],
    });
    const out = outputEmphasisWords(t, {
      A: [
        { word: "so", start: 1.1, end: 1.3, rmsDb: -30, peakDb: -20 },
        { word: "BIG", start: 1.5, end: 1.9, rmsDb: -18, peakDb: -8 },
        { word: "x", start: 2.0, end: 2.2, rmsDb: -30, peakDb: -20 },
      ],
      B: [
        { word: "5", start: 0.5, end: 0.7, rmsDb: -40, peakDb: -30 },
        { word: "years", start: 1.0, end: 1.3, rmsDb: -40, peakDb: -30 },
      ],
    });
    expect(out.map((w) => w.start)).toEqual([0.1, 0.5, 1, 2.5, 3]);
    const big = out.find((w) => w.word === "BIG")!;
    expect(big.score).toBeGreaterThan(1);
    expect(out.find((w) => w.word === "5")!.score).toBeCloseTo(0.8, 3);
  });

  it("buildVisualInteractions converts the hit to a local frame", () => {
    const t = base({ visuals: [counter] });
    const out = buildVisualInteractions(t, { subjectTracks: {}, emphasisWords: words }, 30);
    expect(out.v1!.hitAtFrame).toBe(Math.round(3.04 * 30) - 60);
    expect(out.v1!.track).toBeNull();
    expect(out.v1!.look.scrim).toBe(0);
  });

  it("windowLevels measures RMS/peak in dBFS", () => {
    const pcm = new Float32Array(16000).fill(0.5);
    const l = windowLevels(pcm, 16000, 0.1, 0.2);
    expect(l.rmsDb).toBeCloseTo(-6.02, 1);
    expect(l.peakDb).toBeCloseTo(-6.02, 1);
  });
});

describe("matte post-processing", () => {
  it("tightens haze, keeps solid values, stabilises flicker but not motion", () => {
    expect(tightenAlpha(0.03)).toBe(0);
    expect(tightenAlpha(0.97)).toBe(1);
    expect(tightenAlpha(0.5)).toBeCloseTo(0.5, 6);
    const prev = new Float32Array([0.5, 0.0]);
    const next = new Float32Array([0.55, 0.9]);
    stabilizeAlpha(prev, next);
    expect(next[0]).toBeCloseTo(0.55 * 0.55 + 0.5 * 0.45, 6);
    expect(next[1]).toBeCloseTo(0.9, 6);
    const inp = rgbToModnetInput(Buffer.from([255, 0, 127.5]), 1, 1);
    expect(inp[0]).toBe(1);
    expect(inp[1]).toBe(-1);
  });
});

describe("defaults + auto depth", () => {
  it("veteran defaults for new visuals", () => {
    const card = applyInteractionDefaults({ ...visual(), ...VISUAL_INTERACTION_DEFAULTS });
    expect(card.cameraCoupling).toBe(0.35);
    expect(card.integration).toEqual({ shadow: true, sceneMatch: true, lightWrap: false });
    const icon = applyInteractionDefaults({ ...visual({ template: "ICON_3D", props: { icon: "COIN" } }) });
    expect(icon.integration.lightWrap).toBe(true);
    expect(icon.cameraCoupling).toBe(0);
  });

  const head = Array.from({ length: 31 }, (_, i) => ({ t: i / 3, box: { x: 0.33, y: 0.26, w: 0.34, h: 0.22 } }));
  const big = (extra: Record<string, unknown> = {}) =>
    visual({ template: "KINETIC_TEXT", props: { text: "DEBT FREE" }, placement: { mode: "AUTO", x: 0.5, y: 0.3, scale: 1 }, ...extra });

  it("big type in AUTO with a matte goes BEHIND, crossing the top of the head", () => {
    const t = base({ visuals: [big()] });
    const res = solveVisualPlacements(t, { subjectTracks: { A: head }, mattes: { A: true } });
    const v = res.visuals[0]!;
    expect(v.depth).toBe("BEHIND_SUBJECT");
    expect(v.placement.scale).toBeGreaterThanOrEqual(0.8);
    const r = res.details.v1!.rect;
    const headTop = 0.26 * 1920;
    expect(r.y).toBeLessThan(headTop);
    expect(r.y + r.height).toBeGreaterThan(headTop);
    expect(res.warnings.filter((w) => w.severity === "WARNING")).toEqual([]);
  });

  it("no matte, MANUAL, long text, or a label → normal solve (depth untouched)", () => {
    const t = base({ visuals: [big()] });
    expect(solveVisualPlacements(t, { subjectTracks: { A: head } }).visuals[0]!.depth).toBe("FRONT");
    expect(solveVisualPlacements(t, { subjectTracks: { A: head }, mattes: { A: false } }).visuals[0]!.depth).toBe("FRONT");
    const manual = base({ visuals: [big({ placement: { mode: "MANUAL", x: 0.5, y: 0.3, scale: 1 } })] });
    expect(solveVisualPlacements(manual, { subjectTracks: { A: head }, mattes: { A: true } }).visuals[0]!.depth).toBe("FRONT");
    const long = base({ visuals: [big({ props: { text: "This is a much longer sentence than big type" } })] });
    expect(solveVisualPlacements(long, { subjectTracks: { A: head }, mattes: { A: true } }).visuals[0]!.depth).toBe("FRONT");
    const labelled = base({ visuals: [visual({ template: "NUMBER_COUNTER", props: { value: 5, label: "years" }, placement: { mode: "AUTO", x: 0.5, y: 0.3, scale: 1 } })] });
    expect(solveVisualPlacements(labelled, { subjectTracks: { A: head }, mattes: { A: true } }).visuals[0]!.depth).toBe("FRONT");
  });

  it("a manual behind-subject graphic over the face is not flagged as covering it", () => {
    const t = base({ visuals: [visual({ depth: "BEHIND_SUBJECT", placement: { mode: "MANUAL", x: 0.5, y: 0.3, scale: 1 } })] });
    const res = solveVisualPlacements(t, { subjectTracks: { A: head } });
    expect(res.warnings.map((w) => w.code)).not.toContain("MANUAL_COVERS_SUBJECT");
  });
});
