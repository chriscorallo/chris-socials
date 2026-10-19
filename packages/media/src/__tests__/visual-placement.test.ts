import { describe, it, expect } from "vitest";
import {
  EditTimelineSchema,
  type EditTimeline,
  type EditTimelineInput,
} from "../timeline";
import { TimelineVisualSchema, type TimelineVisual } from "../motion-contract";
import {
  solveVisualPlacements,
  resolveVisualPlacements,
  placementWarnings,
  mapSourceBoxToCanvas,
  placementSafeArea,
  visualRect,
  intersectionArea,
  subjectRegionsForWindow,
  protectedFaceRect,
} from "../visual-placement";
import type { SubjectTrack } from "../subject-track-core";
import { PLACEMENT_SAFE_ZONE } from "../platform-profiles";
import type { Rect } from "../safe-zones";

const CANVAS = { width: 1080, height: 1920 };

function timeline(extra: Partial<EditTimelineInput> = {}): EditTimeline {
  return EditTimelineSchema.parse({
    version: 2,
    canvas: CANVAS,
    clips: [{ id: "c1", mediaAssetId: "a", sourceStart: 0, sourceEnd: 20 }],
    captions: {
      enabled: true,
      fontId: "inter-display-bold",
      fontSize: 62,
      color: "#FFFFFF",
      highlightColor: "#FFD84D",
      y: 0.78,
    },
    ...extra,
  });
}

function visual(v: Partial<TimelineVisual> & Pick<TimelineVisual, "id" | "template" | "props" | "start" | "end">): TimelineVisual {
  return TimelineVisualSchema.parse({ placement: { mode: "AUTO" }, ...v });
}

/** A constant track (head box in source fractions) sampled at 3 fps for 20 s. */
function constantTrack(box: { x: number; y: number; w: number; h: number }): SubjectTrack {
  return Array.from({ length: 61 }, (_, i) => ({ t: i / 3, box }));
}

function headPx(box: { x: number; y: number; w: number; h: number }): Rect {
  return { x: box.x * 1080, y: box.y * 1920, width: box.w * 1080, height: box.h * 1920 };
}

const safe = placementSafeArea(CANVAS, PLACEMENT_SAFE_ZONE);

function insideSafe(r: Rect): boolean {
  return r.x >= safe.x - 1 && r.y >= safe.y - 1 && r.x + r.width <= safe.x + safe.width + 1 && r.y + r.height <= safe.y + safe.height + 1;
}

const counter = (id = "v1", start = 2, end = 5) =>
  visual({ id, template: "NUMBER_COUNTER", props: { value: 24500, prefix: "$" }, start, end });
const ring = (id = "v1") => visual({ id, template: "PERCENT_RING", props: { percent: 40, label: "of income" }, start: 2, end: 5 });

describe("placement engine", () => {
  it("never puts a graphic over a centred face and stays in the platform-safe area", () => {
    const head = { x: 0.3, y: 0.15, w: 0.4, h: 0.25 };
    const tl = timeline({ visuals: [counter()] });
    const res = solveVisualPlacements(tl, { subjectTracks: { a: constantTrack(head) } });
    const r = visualRect(res.visuals[0]!, CANVAS);
    expect(intersectionArea(r, headPx(head))).toBe(0);
    expect(insideSafe(r)).toBe(true);
    expect(res.details.v1!.confidence).toBe("HIGH");
    expect(res.warnings.filter((w) => w.code === "LOW_CONFIDENCE")).toEqual([]);
    // Head occupies the top band, so the counter goes below it.
    expect(r.y).toBeGreaterThanOrEqual((head.y + head.h) * 1920);
  });

  it("puts a narrow graphic on the side opposite the face (face left)", () => {
    const head = { x: 0.06, y: 0.2, w: 0.38, h: 0.32 };
    const [v] = resolveVisualPlacements(timeline({ visuals: [ring()] }), { subjectTracks: { a: constantTrack(head) } });
    expect(v!.placement.x).toBeGreaterThan(0.5);
    expect(intersectionArea(visualRect(v!, CANVAS), headPx(head))).toBe(0);
  });

  it("puts a narrow graphic on the side opposite the face (face right)", () => {
    const head = { x: 0.5, y: 0.2, w: 0.38, h: 0.32 };
    const [v] = resolveVisualPlacements(timeline({ visuals: [ring()] }), { subjectTracks: { a: constantTrack(head) } });
    expect(v!.placement.x).toBeLessThan(0.5);
    expect(intersectionArea(visualRect(v!, CANVAS), headPx(head))).toBe(0);
  });

  it("avoids a caption band that sits in the middle of the frame", () => {
    const head = { x: 0.3, y: 0.15, w: 0.4, h: 0.1 };
    const tl = timeline({
      captions: { enabled: true, fontId: "inter-display-bold", fontSize: 62, color: "#FFFFFF", highlightColor: "#FFD84D", y: 0.5 },
      visuals: [counter()],
    });
    const res = solveVisualPlacements(tl, { subjectTracks: { a: constantTrack(head) } });
    const r = res.details.v1!.rect;
    const bandTop = 0.5 * 1920 - 90;
    const bandBottom = 0.5 * 1920 + 90;
    expect(r.y + r.height <= bandTop || r.y >= bandBottom).toBe(true);
    expect(intersectionArea(r, headPx(head))).toBe(0);
  });

  it("avoids a text overlay active at the same time, but ignores one that isn't", () => {
    const head = { x: 0.05, y: 0.15, w: 0.3, h: 0.1 };
    const text = {
      id: "t1",
      text: "THE 3 RULES",
      start: 0,
      end: 6,
      fontId: "inter-display-bold",
      fontSize: 90,
      color: "#FFFFFF",
      x: 0.5,
      y: 0.5,
    };
    const tl = timeline({ texts: [text], visuals: [counter("v1", 2, 5), counter("v2", 8, 11)] });
    const res = solveVisualPlacements(tl, { subjectTracks: { a: constantTrack(head) } });
    const textBand = { x: 0, y: 0.5 * 1920 - 70, width: 1080, height: 140 };
    expect(intersectionArea(res.details.v1!.rect, textBand)).toBe(0);
    // v2 runs after the text is gone; it's free to use the middle.
    expect(res.warnings.filter((w) => w.code === "LOW_CONFIDENCE")).toEqual([]);
  });

  it("keeps two graphics on screen at once apart", () => {
    const head = { x: 0.05, y: 0.15, w: 0.2, h: 0.1 };
    const tl = timeline({ visuals: [counter("v1", 2, 6), ring("v2")] });
    const res = solveVisualPlacements(tl, { subjectTracks: { a: constantTrack(head) } });
    expect(intersectionArea(res.details.v1!.rect, res.details.v2!.rect)).toBe(0);
    expect(res.warnings.filter((w) => w.code === "LOW_CONFIDENCE")).toEqual([]);
  });

  it("shrinks a big chart (not below 0.7) when that's what it takes, and says so", () => {
    const head = { x: 0.25, y: 0.15, w: 0.5, h: 0.15 };
    const chart = visual({
      id: "c",
      template: "BAR_CHART",
      props: { bars: [{ label: "A", value: 1 }, { label: "B", value: 2 }] },
      start: 1,
      end: 4,
    });
    const res = solveVisualPlacements(timeline({ visuals: [chart] }), { subjectTracks: { a: constantTrack(head) } });
    const v = res.visuals[0]!;
    expect(v.placement.scale).toBeLessThan(1);
    expect(v.placement.scale).toBeGreaterThanOrEqual(0.7);
    expect(res.warnings.some((w) => w.code === "SHRUNK" && w.visualId === "c")).toBe(true);
    expect(intersectionArea(res.details.c!.rect, headPx(head))).toBe(0);
  });

  it("selfie close-up (head fills the frame): finds a spot clear of the eyes→mouth core instead of giving up", () => {
    const head = { x: 0.0, y: 0.1, w: 1.0, h: 0.6 };
    const res = solveVisualPlacements(timeline({ visuals: [counter()] }), { subjectTracks: { a: constantTrack(head) } });
    const core = protectedFaceRect(headPx(head), placementSafeArea({ width: 1080, height: 1920 }, PLACEMENT_SAFE_ZONE));
    expect(res.details.v1!.confidence).toBe("HIGH");
    expect(intersectionArea(res.details.v1!.rect, core)).toBe(0);
  });

  it("reports LOW_CONFIDENCE (never a silent overlap) when there is no clear spot", () => {
    // A tracked close-up AND the rest of the frame tiled with manually placed graphics.
    const head = { x: 0.0, y: 0.1, w: 1.0, h: 0.6 };
    const tiles: TimelineVisual[] = [];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 12; j++) tiles.push(visual({ ...counter(), id: `m${i}-${j}`, placement: { mode: "MANUAL", x: 0.05 + i * 0.18, y: 0.05 + j * 0.08, scale: 1 } }));
    const res = solveVisualPlacements(timeline({ visuals: [...tiles, counter()] }), { subjectTracks: { a: constantTrack(head) } });
    expect(res.details.v1!.confidence).toBe("LOW");
    expect(res.warnings.some((w) => w.code === "LOW_CONFIDENCE" && w.visualId === "v1")).toBe(true);
  });

  it("never moves a MANUAL graphic, and warns when it covers the face", () => {
    const head = { x: 0.3, y: 0.15, w: 0.4, h: 0.25 };
    const manual = visual({ ...counter(), placement: { mode: "MANUAL", x: 0.5, y: 0.25, scale: 1 } });
    const res = solveVisualPlacements(timeline({ visuals: [manual] }), { subjectTracks: { a: constantTrack(head) } });
    expect(res.visuals[0]).toEqual(manual);
    expect(res.warnings.map((w) => w.code)).toContain("MANUAL_COVERS_SUBJECT");
  });

  it("AUTO graphics avoid a MANUAL graphic on screen at the same time", () => {
    const head = { x: 0.3, y: 0.15, w: 0.4, h: 0.15 };
    const manual = visual({ ...counter("m", 2, 5), placement: { mode: "MANUAL", x: 0.5, y: 0.55, scale: 1 } });
    const res = solveVisualPlacements(timeline({ visuals: [manual, ring("auto")] }), { subjectTracks: { a: constantTrack(head) } });
    expect(intersectionArea(res.details.auto!.rect, res.details.m!.rect)).toBe(0);
  });

  it("falls back to an assumed centred head (with a warning) when a take has no track", () => {
    const res = solveVisualPlacements(timeline({ visuals: [counter()] }), { subjectTracks: { a: null } });
    expect(res.warnings.map((w) => w.code)).toContain("NO_SUBJECT_TRACK");
    const assumed = { x: 0.26 * 1080, y: 0.12 * 1920, width: 0.48 * 1080, height: 0.36 * 1920 };
    expect(intersectionArea(res.details.v1!.rect, assumed)).toBe(0);
  });

  it("keeps TITLE_CARD full-frame and centred", () => {
    const tc = visual({ id: "t", template: "TITLE_CARD", props: { title: "Rule #1" }, start: 0, end: 2, placement: { mode: "AUTO", x: 0.2, y: 0.8, scale: 0.5 } });
    const [v] = resolveVisualPlacements(timeline({ visuals: [tc] }), { subjectTracks: { a: constantTrack({ x: 0.3, y: 0.2, w: 0.4, h: 0.3 }) } });
    expect(v!.placement).toMatchObject({ x: 0.5, y: 0.5, scale: 1 });
  });

  it("places a CALLOUT label near its target but off the face and not on the target", () => {
    const head = { x: 0.3, y: 0.15, w: 0.4, h: 0.25 };
    const c = visual({ id: "co", template: "CALLOUT", props: { text: "this card", pointTo: { x: 0.75, y: 0.55 } }, start: 3, end: 5 });
    const res = solveVisualPlacements(timeline({ visuals: [c] }), { subjectTracks: { a: constantTrack(head) } });
    const r = res.details.co!.rect;
    const target = { x: 0.75 * 1080, y: 0.55 * 1920 };
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    expect(Math.hypot(cx - target.x, cy - target.y)).toBeLessThan(520);
    expect(target.x >= r.x && target.x <= r.x + r.width && target.y >= r.y && target.y <= r.y + r.height).toBe(false);
    expect(intersectionArea(r, headPx(head))).toBe(0);
  });

  it("is deterministic and stable when re-solved (no jumping, no compounding shrink)", () => {
    const head = { x: 0.25, y: 0.15, w: 0.5, h: 0.15 };
    const tl = timeline({
      visuals: [
        counter("v1", 1, 3),
        visual({ id: "c", template: "BAR_CHART", props: { bars: [{ label: "A", value: 1 }, { label: "B", value: 2 }] }, start: 4, end: 7 }),
      ],
    });
    const opts = { subjectTracks: { a: constantTrack(head) } };
    const once = resolveVisualPlacements(tl, opts);
    expect(resolveVisualPlacements(tl, opts)).toEqual(once);
    const twice = resolveVisualPlacements({ ...tl, visuals: once }, opts);
    expect(twice).toEqual(once);
  });

  it("follows the subject through a clip that uses a different take and crop", () => {
    // Take b is landscape 1920x1080 with the face on the right; center-crop shows its middle.
    const tl = timeline({
      clips: [
        { id: "c1", mediaAssetId: "a", sourceStart: 0, sourceEnd: 5 },
        { id: "c2", mediaAssetId: "b", sourceStart: 0, sourceEnd: 5, crop: { zoom: 1, panX: 0.5, panY: 0 } },
      ],
      visuals: [ring("v1")],
    });
    tl.visuals[0] = { ...tl.visuals[0]!, start: 6, end: 8 };
    const res = solveVisualPlacements(tl, {
      subjectTracks: { a: constantTrack({ x: 0.3, y: 0.2, w: 0.4, h: 0.2 }), b: constantTrack({ x: 0.6, y: 0.15, w: 0.12, h: 0.2 }) },
      sourceDimensions: { a: CANVAS, b: { width: 1920, height: 1080 } },
    });
    const head = res.details.v1!.head!;
    // Mapped head of take b (not take a's box) and the graphic stays off it.
    const g = mapSourceBoxToCanvas({ x: 0.6, y: 0.15, w: 0.12, h: 0.2 }, { width: 1920, height: 1080 }, CANVAS, { zoom: 1, panX: 0.5, panY: 0 }, { zoom: 1, x: 0.5, y: 0.5 })!;
    expect(head.x).toBeCloseTo(g.x, 0);
    expect(intersectionArea(res.details.v1!.rect, head)).toBe(0);
    expect(res.details.v1!.confidence).toBe("HIGH");
  });
});

describe("mapSourceBoxToCanvas", () => {
  it("maps through a cover crop (landscape source, centred)", () => {
    const r = mapSourceBoxToCanvas({ x: 0.45, y: 0.2, w: 0.1, h: 0.3 }, { width: 1920, height: 1080 }, CANVAS, { zoom: 1, panX: 0, panY: 0 }, { zoom: 1, x: 0.5, y: 0.5 })!;
    const scale = 1920 / 1080;
    const offsetX = (1920 * scale - 1080) / 2;
    expect(r.x).toBeCloseTo(0.45 * 1920 * scale - offsetX, 3);
    expect(r.width).toBeCloseTo(0.1 * 1920 * scale, 3);
    expect(r.y).toBeCloseTo(0.2 * 1920, 3);
  });

  it("clips a subject that is cropped out to null", () => {
    expect(
      mapSourceBoxToCanvas({ x: 0.0, y: 0.2, w: 0.1, h: 0.3 }, { width: 1920, height: 1080 }, CANVAS, { zoom: 1, panX: 0, panY: 0 }, { zoom: 1, x: 0.5, y: 0.5 }),
    ).toBeNull();
  });

  it("applies an output zoom around its focal point", () => {
    const box = { x: 0.4, y: 0.4, w: 0.2, h: 0.1 };
    const r = mapSourceBoxToCanvas(box, CANVAS, CANVAS, { zoom: 1, panX: 0, panY: 0 }, { zoom: 2, x: 0.5, y: 0.5 })!;
    // Centre stays at the centre, size doubles.
    expect(r.x + r.width / 2).toBeCloseTo(540, 3);
    expect(r.width).toBeCloseTo(0.2 * 1080 * 2, 3);
  });

  it("subject window unions a punch-in into the head region", () => {
    const tl = timeline({ zooms: [{ id: "z", start: 3, end: 4, zoom: 1.5, x: 0.5, y: 0.3 }] });
    const track = constantTrack({ x: 0.4, y: 0.2, w: 0.2, h: 0.15 });
    const plain = subjectRegionsForWindow(tl, 0, 2, { subjectTracks: { a: track } }).head!;
    const withZoom = subjectRegionsForWindow(tl, 2, 5, { subjectTracks: { a: track } }).head!;
    expect(withZoom.width).toBeGreaterThan(plain.width);
  });
});

describe("placementWarnings", () => {
  it("is empty for a well-placed AUTO graphic", () => {
    const head = { x: 0.3, y: 0.15, w: 0.4, h: 0.2 };
    expect(placementWarnings(timeline({ visuals: [counter()] }), { subjectTracks: { a: constantTrack(head) } })).toEqual([]);
  });
});

describe("exact caption obstacles (measure + word timings)", () => {
  it("only avoids caption blocks actually on screen during the visual", async () => {
    const { nodeMeasureText } = await import("../timeline-render");
    const head = { x: 0.3, y: 0.15, w: 0.4, h: 0.1 };
    const caps = { enabled: true, fontId: "inter-display-bold", fontSize: 62, color: "#FFFFFF", highlightColor: "#FFD84D", y: 0.45 };
    const words = ["Most", "people", "never", "check", "this"].map((w, i) => ({ word: w, start: i * 0.5, end: i * 0.5 + 0.4 }));
    const opts = { subjectTracks: { a: constantTrack(head) }, measure: nodeMeasureText, wordsByAsset: { a: words } };
    // During speech (0-2.5 s): the caption block at y=0.45 is avoided.
    const during = solveVisualPlacements(timeline({ captions: caps, visuals: [counter("v1", 0.5, 2.5)] }), opts);
    const capTop = 0.45 * 1920 - 60;
    const capBottom = 0.45 * 1920 + 60;
    const r = during.details.v1!.rect;
    expect(r.y + r.height <= capTop || r.y >= capBottom).toBe(true);
    // After speech ends there are no captions on screen, so placement equals captions-off.
    const after = resolveVisualPlacements(timeline({ captions: caps, visuals: [counter("v1", 10, 12)] }), opts);
    const off = resolveVisualPlacements(timeline({ captions: { ...caps, enabled: false }, visuals: [counter("v1", 10, 12)] }), opts);
    expect(after).toEqual(off);
  });
});
