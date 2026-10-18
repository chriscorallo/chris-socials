import { describe, it, expect } from "vitest";
import {
  EditTimelineSchema,
  timelineDuration,
  clipStartTimes,
  timelineCaptionWords,
  resolveGrade,
  GRADE_PRESET_VALUES,
  type MeasureText,
  type TimelineVisual,
} from "@chris/media/timeline";
import {
  splitAt,
  trimClip,
  moveClip,
  deleteClip,
  duplicateClip,
  insertClip,
  insertionIndexAt,
  addText,
  addZoom,
  updateText,
  setWordEdit,
  applyGradePreset,
  updateGrade,
  setCover,
  normalizeDoc,
  switchClipSource,
  moveSpan,
  trimSpan,
} from "./timeline-ops";
import { editorReducer, initEditorState, buildSavePayload, type EditorState } from "./reducer";
import { panAfterDrag, gradeSvgParams, vignetteGradient, joinHexAlpha, splitHexAlpha } from "./preview-math";
import { platformWarnings, safeRect } from "./platform-warnings";
import { initialEditorDoc } from "../../app/content/[id]/edit/lib/initial-timeline";
import type { EditorDoc } from "./types";

const DUR = { A: 20, B: 8 };

/** Deterministic stand-in for glyph measurement: 0.5 em per character. */
const fakeMeasure: MeasureText = (text, _fontId, px) => text.length * px * 0.5;

/** An explicit timeline (independent of the plan converter) for the op/reducer tests. */
function baseDoc(): EditorDoc {
  return EditTimelineSchema.parse({
    version: 2,
    canvas: { width: 1080, height: 1920 },
    clips: [
      { id: "c1", mediaAssetId: "A", sourceStart: 1, sourceEnd: 5 },
      { id: "c2", mediaAssetId: "A", sourceStart: 7, sourceEnd: 10 },
    ],
    texts: [
      { id: "t1", text: "Hook headline", start: 0, end: 2, preset: "HEADLINE", fontId: "inter-display-extrabold", fontSize: 72, color: "#FFFFFF", backgroundColor: "#000000B3", x: 0.5, y: 0.15 },
      { id: "t2", text: "$1,000", start: 3, end: 6.5, preset: "NUMBER_CALLOUT", fontId: "inter-display-extrabold", fontSize: 150, color: "#FFD54A", strokeColor: "#000000", x: 0.5, y: 0.42 },
    ],
    captions: { enabled: true, preset: "BOLD_HIGHLIGHT", fontId: "inter-display-bold", fontSize: 64, color: "#FFFFFF", highlightColor: "#FFD54A", y: 0.72 },
    zooms: [{ id: "z1", start: 2, end: 3, zoom: 1.2, x: 0.5, y: 0.33, mode: "CUT" }],
  });
}

function valid(doc: EditorDoc) {
  const r = EditTimelineSchema.safeParse(doc);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return true;
}

const PLAN = {
  segments: [
    { startSeconds: 1, endSeconds: 5 },
    { startSeconds: 7, endSeconds: 10 },
  ],
  targetDimensions: { width: 1080, height: 1920 },
  textOverlays: [{ text: "Hook headline", startSeconds: 0, endSeconds: 2, position: "TOP", style: "HEADLINE" }],
  captions: { enabled: true, style: "BOLD_HIGHLIGHT", position: "LOWER" },
  punchIns: [{ startSeconds: 2, endSeconds: 3, zoom: 1.2, focus: "UPPER_THIRD" }],
  normalizeAudio: true,
  bRollRequests: [],
  musicTrack: null,
  sfxEvents: [],
  transitions: [],
  targetDurationSeconds: 7,
  productionTier: "FAST",
  doNothingElse: false,
  rationale: "test",
};
const TAKE = { id: "A", duration: 20, hasWords: true, width: 1080, height: 1920 };

describe("initial timeline (the renderer's own conversion)", () => {
  it("converts an AI plan with planToTimeline (via the worker's timelineForPlan)", () => {
    const doc = initialEditorDoc(PLAN, TAKE);
    expect(valid(doc)).toBe(true);
    expect(doc.clips.map((c) => [c.mediaAssetId, c.sourceStart, c.sourceEnd])).toEqual([
      ["A", 1, 5],
      ["A", 7, 10],
    ]);
    expect(timelineDuration(doc)).toBe(7);
    expect(doc.texts[0]).toMatchObject({ preset: "HEADLINE", text: "Hook headline" });
    expect(doc.captions).toMatchObject({ enabled: true, preset: "BOLD_HIGHLIGHT" });
    expect(doc.zooms[0]).toMatchObject({ mode: "CUT", zoom: 1.2, y: 0.33 });
    expect(doc.coverFrameSeconds).toBeNull();
  });

  it("opens a saved finishing edit (plan.timeline) as-is, cover frame included", () => {
    const saved = { ...baseDoc(), coverFrameSeconds: 2.5 };
    const doc = initialEditorDoc({ ...PLAN, timeline: saved }, TAKE);
    expect(doc.texts.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(doc.coverFrameSeconds).toBe(2.5);
  });

  it("falls back to the whole take when the plan is unusable", () => {
    const doc = initialEditorDoc(null, { ...TAKE, duration: 12, hasWords: false });
    expect(doc.clips).toHaveLength(1);
    expect(doc.clips[0]).toMatchObject({ sourceStart: 0, sourceEnd: 12 });
    expect(doc.captions.enabled).toBe(false);
  });
});

describe("clip operations", () => {
  it("splits the clip under the playhead into two contiguous clips", () => {
    const doc = baseDoc();
    const { doc: out, newClipId } = splitAt(doc, 2); // clip 0 covers 0..4 (source 1..5)
    expect(newClipId).toBeTruthy();
    expect(out.clips).toHaveLength(3);
    expect(out.clips[0]).toMatchObject({ sourceStart: 1, sourceEnd: 3 });
    expect(out.clips[1]).toMatchObject({ sourceStart: 3, sourceEnd: 5, id: newClipId });
    expect(timelineDuration(out)).toBe(timelineDuration(doc));
    expect(valid(out)).toBe(true);
  });

  it("ignores a split right at a clip edge", () => {
    const doc = baseDoc();
    expect(splitAt(doc, 4.02).newClipId).toBeNull();
    expect(splitAt(doc, 0).newClipId).toBeNull();
  });

  it("clamps trims to the take and to a minimum length", () => {
    let doc = baseDoc();
    const id = doc.clips[0]!.id;
    doc = trimClip(doc, id, "start", -3, DUR.A);
    expect(doc.clips[0]!.sourceStart).toBe(0);
    doc = trimClip(doc, id, "start", 99, DUR.A);
    expect(doc.clips[0]!.sourceStart).toBeCloseTo(4.9);
    doc = trimClip(doc, id, "end", 50, DUR.A);
    expect(doc.clips[0]!.sourceEnd).toBe(20);
    doc = trimClip(doc, id, "end", 0, DUR.A);
    expect(doc.clips[0]!.sourceEnd).toBeCloseTo(5);
    expect(valid(doc)).toBe(true);
  });

  it("reorders, duplicates, inserts and ripple-deletes", () => {
    let doc = baseDoc();
    const [a, b] = doc.clips;
    doc = moveClip(doc, 0, 1);
    expect(doc.clips.map((c) => c.id)).toEqual([b!.id, a!.id]);
    const dup = duplicateClip(doc, a!.id);
    expect(dup.doc.clips).toHaveLength(3);
    expect(dup.doc.clips[2]!.sourceStart).toBe(a!.sourceStart);
    const ins = insertClip(dup.doc, 1, { mediaAssetId: "B", sourceStart: 0, sourceEnd: 8 });
    expect(ins.doc.clips[1]!.mediaAssetId).toBe("B");
    expect(clipStartTimes(ins.doc)).toEqual([0, 3, 11, 15]);
    const del = deleteClip(ins.doc, ins.newClipId);
    expect(clipStartTimes(del)).toEqual([0, 3, 7]);
    // the last clip can never be deleted
    let one = baseDoc();
    one = deleteClip(one, one.clips[0]!.id);
    expect(deleteClip(one, one.clips[0]!.id).clips).toHaveLength(1);
  });

  it("finds the insertion index nearest the playhead", () => {
    const doc = baseDoc(); // clips 0..4, 4..7
    expect(insertionIndexAt(doc, 0.5)).toBe(0);
    expect(insertionIndexAt(doc, 3)).toBe(1);
    expect(insertionIndexAt(doc, 6.9)).toBe(2);
  });

  it("switches a clip's take, clamping to the new take's length", () => {
    const doc = baseDoc();
    const out = switchClipSource(doc, doc.clips[1]!.id, "B", DUR.B);
    expect(out.clips[1]).toMatchObject({ mediaAssetId: "B", sourceStart: 5, sourceEnd: 8 });
  });
});

describe("overlay clamping and normalization", () => {
  it("keeps texts/zooms/cover inside the duration after a ripple delete", () => {
    let doc = setCover(baseDoc(), 6.8);
    doc = normalizeDoc(deleteClip(doc, doc.clips[1]!.id), DUR); // duration 7 -> 4
    expect(timelineDuration(doc)).toBe(4);
    const callout = doc.texts[1]!;
    expect(callout.end).toBeLessThanOrEqual(4);
    expect(callout.end - callout.start).toBeCloseTo(3.5);
    expect(doc.coverFrameSeconds).toBeLessThanOrEqual(4);
    expect(valid(doc)).toBe(true);
  });

  it("clamps clips to their take duration", () => {
    const doc = baseDoc();
    const out = normalizeDoc({ ...doc, clips: [{ ...doc.clips[0]!, sourceEnd: 40 }] }, DUR);
    expect(out.clips[0]!.sourceEnd).toBe(20);
  });

  it("moves and trims spans within bounds", () => {
    const doc = baseDoc();
    const t = doc.texts[0]!;
    expect(moveSpan(t, 6.5, 7)).toMatchObject({ start: 5, end: 7 });
    expect(moveSpan(t, -1, 7)).toMatchObject({ start: 0, end: 2 });
    expect(trimSpan(t, "end", 99, 7).end).toBe(7);
    expect(trimSpan(t, "start", 5, 7).start).toBeCloseTo(1.9);
  });

  it("adds texts and zooms at the playhead and clamps to the end", () => {
    const doc = baseDoc();
    const t = addText(doc, 6.5);
    const added = t.doc.texts.find((x) => x.id === t.id)!;
    expect(added.start).toBe(6.5);
    expect(added.end).toBe(7);
    const z = addZoom(doc, 1);
    expect(z.doc.zooms.find((x) => x.id === z.id)).toMatchObject({ start: 1, end: 2.5 });
    expect(valid(t.doc) && valid(z.doc)).toBe(true);
  });
});

describe("captions word edits", () => {
  it("writes and clears wordEdits keyed by asset:index, and the shared chunker honors them", () => {
    let doc = baseDoc();
    const words = { A: [{ word: "hello", start: 1.2, end: 1.6 }, { word: "wrld", start: 1.7, end: 2.1 }, { word: "um", start: 2.2, end: 2.4 }] };
    doc = setWordEdit(doc, "A:1", "world");
    doc = setWordEdit(doc, "A:2", "");
    expect(doc.captions.wordEdits).toEqual({ "A:1": "world", "A:2": "" });
    expect(timelineCaptionWords(doc, words).map((w) => w.word)).toEqual(["hello", "world"]);
    doc = setWordEdit(doc, "A:2", null);
    expect(doc.captions.wordEdits).toEqual({ "A:1": "world" });
    expect(valid(doc)).toBe(true);
  });
});

describe("reducer: history", () => {
  function apply(s: EditorState, recipe: (d: EditorDoc) => EditorDoc, coalesce?: string) {
    return editorReducer(s, { type: "apply", recipe, coalesce });
  }

  it("undoes and redoes edits", () => {
    let s = initEditorState(baseDoc(), DUR);
    const original = s.doc;
    s = apply(s, (d) => splitAt(d, 2).doc);
    expect(s.doc.clips).toHaveLength(3);
    s = editorReducer(s, { type: "undo" });
    expect(s.doc).toBe(original);
    s = editorReducer(s, { type: "redo" });
    expect(s.doc.clips).toHaveLength(3);
    // a new edit clears the redo stack
    s = editorReducer(s, { type: "undo" });
    s = apply(s, (d) => applyGradePreset(d, "WARM"));
    expect(s.future).toHaveLength(0);
  });

  it("coalesces a drag gesture into one undo step", () => {
    let s = initEditorState(baseDoc(), DUR);
    const id = s.doc.texts[0]!.id;
    for (const y of [0.2, 0.25, 0.3, 0.35]) s = apply(s, (d) => updateText(d, id, { y }), `move:${id}`);
    s = editorReducer(s, { type: "commit" });
    s = apply(s, (d) => updateText(d, id, { y: 0.5 }), `move:${id}`);
    expect(s.past).toHaveLength(2);
    s = editorReducer(s, { type: "undo" });
    expect(s.doc.texts[0]!.y).toBe(0.35);
    s = editorReducer(s, { type: "undo" });
    expect(s.doc.texts[0]!.y).toBe(0.15);
  });

  it("drops a selection whose item was deleted (and restores nothing on no-op edits)", () => {
    let s = initEditorState(baseDoc(), DUR);
    const id = s.doc.clips[1]!.id;
    s = editorReducer(s, { type: "select", selection: { kind: "clip", id } });
    s = apply(s, (d) => deleteClip(d, id));
    expect(s.selection).toBeNull();
    const before = s;
    s = apply(s, (d) => d);
    expect(s).toBe(before);
  });

  it("builds a schema-valid save payload including the cover frame", () => {
    const doc = setCover(baseDoc(), 1.5);
    const p = buildSavePayload(doc);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.timeline.coverFrameSeconds).toBe(1.5);
      expect(p.durationSeconds).toBe(7);
    }
    const bad = buildSavePayload({ ...doc, texts: [{ ...doc.texts[0]!, color: "red" }] });
    expect(bad.ok).toBe(false);
  });
});

describe("grade semantics (renderer's resolveGrade)", () => {
  it("a picked look is the pure preset; moving a slider bakes it into explicit values", () => {
    let doc = applyGradePreset(baseDoc(), "WARM");
    expect(doc.grade.preset).toBe("WARM");
    expect(resolveGrade(doc.grade)).toEqual(GRADE_PRESET_VALUES.WARM);
    doc = updateGrade(doc, { temperature: 0 });
    expect(doc.grade.preset).toBe("NONE");
    const g = resolveGrade(doc.grade);
    expect(g.temperature).toBe(0); // back to neutral really means neutral
    expect(g.contrast).toBe(GRADE_PRESET_VALUES.WARM.contrast);
    expect(valid(doc)).toBe(true);
  });
});

describe("preview math", () => {
  it("inverts the pan mapping for drag-to-reframe", () => {
    const src = { width: 1920, height: 1080 };
    const canvas = { width: 1080, height: 1920 };
    // dragging the picture right reveals more of the left side → pan toward -1
    expect(panAfterDrag({ zoom: 1, panX: 0, panY: 0 }, src, canvas, 100, 0).panX).toBeLessThan(0);
    // dragging by half the overflow from centre lands on the edge
    const overflow = 1920 * (1920 / 1080) - 1080;
    expect(panAfterDrag({ zoom: 1, panX: 0, panY: 0 }, src, canvas, overflow / 2, 0).panX).toBe(-1);
    // no vertical overflow at zoom 1 → panY stays 0
    expect(panAfterDrag({ zoom: 1, panX: 0, panY: 0 }, src, canvas, 0, 300).panY).toBe(0);
  });

  it("expresses the grade as the renderer's eq/saturation/temperature parameters", () => {
    const p = gradeSvgParams({ brightness: 0.1, contrast: 1.2, saturation: 0.5, temperature: 1, vignette: 0 });
    expect(p.slope).toBe(1.2);
    expect(p.intercept).toBeCloseTo(0.5 * (1 - 1.2) + 0.1);
    expect(p.saturation).toBe(0.5);
    expect(p.matrix.startsWith("1.1 0 0 0 0  0 1 0 0 0  0 0 0.88")).toBe(true);
    expect(vignetteGradient(0)).toBeNull();
    expect(vignetteGradient(0.5)).toMatch(/^radial-gradient\(circle farthest-corner at 50% 50%, rgba\(0,0,0,0\) 0%/);
  });

  it("splits and joins #RRGGBBAA", () => {
    expect(splitHexAlpha("#000000B3")).toEqual({ rgb: "#000000", alpha: 0xb3 / 255 });
    expect(joinHexAlpha("#000000", 0xb3 / 255)).toBe("#000000B3");
    expect(joinHexAlpha("#ffffff", 1)).toBe("#FFFFFF");
  });
});

describe("platform warnings (renderer layouts + PLATFORM_PROFILES)", () => {
  it("flags text under platform UI and duration limits; All = union", () => {
    let doc = baseDoc();
    doc = updateText(doc, "t1", { y: 0.04 }); // into every app's top bar
    const all = platformWarnings(doc, ["TIKTOK", "INSTAGRAM", "YOUTUBE"], {}, fakeMeasure);
    const w = all.find((x) => x.id === "text:t1")!;
    expect(w.platforms.sort()).toEqual(["INSTAGRAM", "TIKTOK", "YOUTUBE"]);
    expect(w.target).toEqual({ kind: "text", id: "t1" });
    // headline just below the apps' top bars (best-estimate 230 px): no warning anywhere
    const high = updateText(baseDoc(), "t1", { y: 0.161 });
    expect(platformWarnings(high, ["INSTAGRAM", "TIKTOK", "YOUTUBE"], {}, fakeMeasure).some((x) => x.id === "text:t1")).toBe(false);
    expect(safeRect(["TIKTOK", "INSTAGRAM"]).y0).toBe(269); // the derived conservative rectangle
    // too short everywhere
    const short = { ...doc, clips: [{ ...doc.clips[0]!, sourceStart: 1, sourceEnd: 1.5 }] };
    expect(platformWarnings(short, ["TIKTOK"], {}, fakeMeasure).some((x) => x.id === "duration-min:TIKTOK")).toBe(true);
  });

  it("uses each app's UI regions: right rail, caption block, edges", () => {
    // a short text at the right edge, mid-height: under TikTok's rail (from y 760), clear of
    // Reels' (from y 1050)
    const right = updateText(baseDoc(), "t1", { text: "Hi", x: 0.88, y: 0.5, backgroundColor: null });
    const tt = platformWarnings(right, ["TIKTOK"], {}, fakeMeasure).find((x) => x.id === "text:t1");
    expect(tt?.message).toContain("like/comment buttons");
    expect(platformWarnings(right, ["INSTAGRAM"], {}, fakeMeasure).some((x) => x.id === "text:t1")).toBe(false);
    // low on the left: under the username/caption block
    const low = updateText(baseDoc(), "t1", { text: "Hi", x: 0.2, y: 0.86, backgroundColor: null });
    expect(platformWarnings(low, ["YOUTUBE"], {}, fakeMeasure).find((x) => x.id === "text:t1")?.message).toContain("caption & username");
    // hard against the left edge: cut off on tall phones
    const edge = updateText(baseDoc(), "t1", { text: "Hi", x: 0.02, y: 0.5, backgroundColor: null });
    expect(platformWarnings(edge, ["INSTAGRAM"], {}, fakeMeasure).find((x) => x.id === "text:t1")?.message).toContain("edge");
    // centred captions at the default height are clear everywhere
    const words = { A: [{ word: "hi", start: 1.2, end: 1.6 }, { word: "there", start: 1.7, end: 2.1 }] };
    expect(platformWarnings(baseDoc(), ["TIKTOK", "INSTAGRAM", "YOUTUBE"], words, fakeMeasure).some((x) => x.id === "captions")).toBe(false);
    // captions dragged down into the caption block are flagged
    const capsLow = { ...baseDoc(), captions: { ...baseDoc().captions, y: 0.86 } };
    expect(platformWarnings(capsLow, ["TIKTOK"], words, fakeMeasure).find((x) => x.id === "captions")?.message).toContain("caption & username");
  });

  it("flags a graphic and a face under an app's buttons", () => {
    const doc = baseDoc();
    const visual = { id: "v1", template: "STAT_CARD", start: 1, end: 3, placement: { mode: "MANUAL", x: 0.75, y: 0.5, scale: 1 } } as unknown as TimelineVisual;
    const ws = platformWarnings(doc, ["TIKTOK"], {}, fakeMeasure, {}, { visuals: [visual] });
    expect(ws.find((x) => x.id === "visual-ui:v1")?.target).toEqual({ kind: "visual", id: "v1" });
    // face (protected head box) low on the right of the source = under the rail
    const track = [0, 2, 4, 6, 8, 10].map((t) => ({ t, box: { x: 0.78, y: 0.45, w: 0.2, h: 0.15 } }));
    const centred = [0, 2, 4, 6, 8, 10].map((t) => ({ t, box: { x: 0.35, y: 0.2, w: 0.3, h: 0.2 } }));
    const sizes = { A: { width: 1080, height: 1920 } };
    expect(platformWarnings(doc, ["TIKTOK"], {}, fakeMeasure, sizes, { tracks: { A: track } }).find((x) => x.id === "face:TIKTOK")?.message).toContain("like/comment");
    expect(platformWarnings(doc, ["TIKTOK"], {}, fakeMeasure, sizes, { tracks: { A: centred } }).some((x) => x.id.startsWith("face:"))).toBe(false);
  });

  it("flags captions overlapping a text (the Quality Gate's collision check)", () => {
    const doc = updateText(baseDoc(), "t1", { y: 0.72, start: 0, end: 7 });
    const words = { A: [{ word: "hello", start: 1.2, end: 1.6 }, { word: "there", start: 1.7, end: 2.1 }] };
    const ws = platformWarnings(doc, ["TIKTOK"], words, fakeMeasure);
    expect(ws.some((x) => x.id.startsWith("overlap:CAPTION_TEXT"))).toBe(true);
  });

  it("flags a clip reframed so tight it will look soft", () => {
    const doc = { ...baseDoc(), clips: [{ ...baseDoc().clips[0]!, crop: { zoom: 2, panX: 0, panY: 0 } }] };
    const ws = platformWarnings(doc, ["TIKTOK"], {}, fakeMeasure, { A: { width: 1080, height: 1920 } });
    expect(ws.some((x) => x.id === "soft:c1")).toBe(true);
  });
});
