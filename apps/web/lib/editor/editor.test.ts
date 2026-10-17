import { describe, it, expect } from "vitest";
import { EditTimelineSchema, timelineDuration, clipStartTimes, timelineCaptionWords } from "@chris/media/timeline";
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
  setCover,
  normalizeDoc,
  switchClipSource,
  moveSpan,
  trimSpan,
} from "./timeline-ops";
import { editorReducer, initEditorState, buildSavePayload, type EditorState } from "./reducer";
import { coverLayout, panAfterDrag, zoomAt, gradeCss, estimateTextBox, joinHexAlpha, splitHexAlpha } from "./preview-math";
import { platformWarnings, safeRect } from "./platform-warnings";
import { planToEditorDoc } from "../../app/content/[id]/edit/lib/initial-timeline";
import type { EditorDoc } from "./types";

const DUR = { A: 20, B: 8 };

function baseDoc(): EditorDoc {
  return planToEditorDoc(
    {
      segments: [
        { startSeconds: 1, endSeconds: 5 },
        { startSeconds: 7, endSeconds: 10 },
      ],
      textOverlays: [
        { text: "Hook headline", startSeconds: 0, endSeconds: 2, position: "TOP", style: "HEADLINE" },
        { text: "$1,000", startSeconds: 3, endSeconds: 6.5, position: "CENTER", style: "NUMBER_CALLOUT" },
      ],
      captions: { enabled: true, style: "BOLD_HIGHLIGHT", position: "LOWER" },
      punchIns: [{ startSeconds: 2, endSeconds: 3, zoom: 1.2, focus: "UPPER_THIRD" }],
      normalizeAudio: true,
    },
    { id: "A", duration: 20, hasWords: true },
  );
}

function valid(doc: EditorDoc) {
  const r = EditTimelineSchema.safeParse(doc);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return true;
}

describe("initial timeline (fallback converter)", () => {
  it("maps segments, overlays, captions and punch-ins to a valid timeline", () => {
    const doc = baseDoc();
    expect(valid(doc)).toBe(true);
    expect(doc.clips.map((c) => [c.mediaAssetId, c.sourceStart, c.sourceEnd])).toEqual([
      ["A", 1, 5],
      ["A", 7, 10],
    ]);
    expect(timelineDuration(doc)).toBe(7);
    expect(doc.texts[0]).toMatchObject({ preset: "HEADLINE", fontSize: 72, backgroundColor: "#000000B3", y: 0.15 });
    expect(doc.texts[1]).toMatchObject({ preset: "NUMBER_CALLOUT", fontSize: 150, color: "#FFD54A", strokeColor: "#000000", y: 0.42 });
    expect(doc.captions).toMatchObject({ enabled: true, preset: "BOLD_HIGHLIGHT", fontId: "inter-display-bold", fontSize: 64, y: 0.72 });
    expect(doc.zooms[0]).toMatchObject({ mode: "CUT", zoom: 1.2, y: 0.33 });
    expect(doc.grade.preset).toBe("NONE");
  });

  it("passes a saved plan.timeline through, keeping coverFrameSeconds", () => {
    const saved = { ...baseDoc(), coverFrameSeconds: 2.5 };
    const doc = planToEditorDoc({ segments: [{ startSeconds: 0, endSeconds: 1 }], timeline: saved }, { id: "A", duration: 20, hasWords: false });
    expect(doc.clips).toHaveLength(2);
    expect(doc.coverFrameSeconds).toBe(2.5);
  });

  it("falls back to the whole take when the plan has no segments", () => {
    const doc = planToEditorDoc(null, { id: "A", duration: 12, hasWords: false });
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

  it("builds a schema-valid save payload and re-attaches the cover frame", () => {
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

describe("preview math", () => {
  it("covers the canvas and pans across the overflow", () => {
    // 16:9 source into 9:16 canvas: height-bound.
    const l = coverLayout(1920, 1080, 1080, 1920, { zoom: 1, panX: 0, panY: 0 });
    expect(l.baseH).toBeCloseTo(1920);
    expect(l.baseW).toBeCloseTo(3413.33, 1);
    expect(l.tx).toBeCloseTo(-(3413.33 - 1080) / 2, 0);
    expect(coverLayout(1920, 1080, 1080, 1920, { zoom: 1, panX: -1, panY: 0 }).tx).toBeCloseTo(0);
    expect(coverLayout(1920, 1080, 1080, 1920, { zoom: 1, panX: 1, panY: 0 }).tx).toBeCloseTo(-(3413.33 - 1080), 0);
    // dragging the picture right pans toward the left edge
    expect(panAfterDrag({ zoom: 1, panX: 0, panY: 0 }, 1920, 1080, 1080, 1920, 100, 0).panX).toBeLessThan(0);
  });

  it("eases zoom in and cuts hard otherwise", () => {
    const zooms = [{ id: "z", start: 1, end: 3, zoom: 1.5, x: 0.5, y: 0.4, mode: "EASE" as const, easeSeconds: 1 }];
    expect(zoomAt(zooms, 0.5).scale).toBe(1);
    expect(zoomAt(zooms, 1.5).scale).toBeCloseTo(1.25);
    expect(zoomAt(zooms, 2.5).scale).toBe(1.5);
    expect(zoomAt([{ ...zooms[0]!, mode: "CUT" }], 1.01).scale).toBe(1.5);
  });

  it("maps grade to CSS", () => {
    expect(gradeCss({ brightness: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0 }).filter).toBe("none");
    const g = gradeCss({ brightness: 0.1, contrast: 1.2, saturation: 0, temperature: 0.4, vignette: 0.3 });
    expect(g.filter).toBe("brightness(1.1) contrast(1.2) saturate(0)");
    expect(g.wash?.color).toBe("#ff9a3c");
  });

  it("splits and joins #RRGGBBAA", () => {
    expect(splitHexAlpha("#000000B3")).toEqual({ rgb: "#000000", alpha: 0xb3 / 255 });
    expect(joinHexAlpha("#000000", 0xb3 / 255)).toBe("#000000B3");
    expect(joinHexAlpha("#ffffff", 1)).toBe("#FFFFFF");
  });
});

describe("platform warnings", () => {
  it("flags text under platform UI and duration limits; All = union", () => {
    let doc = baseDoc();
    const id = doc.texts[0]!.id;
    doc = updateText(doc, id, { y: 0.04 }); // into every app's top bar
    const all = platformWarnings(doc, ["TIKTOK", "INSTAGRAM", "YOUTUBE"], {});
    const w = all.find((x) => x.id === `text:${id}`)!;
    expect(w.platforms.sort()).toEqual(["INSTAGRAM", "TIKTOK", "YOUTUBE"]);
    expect(w.target).toEqual({ kind: "text", id });
    // a headline at y=0.13 clears TikTok's 150px top bar but not Reels' 220px
    const high = updateText(baseDoc(), id, { y: 0.13 });
    const reels = platformWarnings(high, ["INSTAGRAM"], {});
    const tiktok = platformWarnings(high, ["TIKTOK"], {});
    expect(reels.some((x) => x.id.startsWith("text:"))).toBe(true);
    expect(tiktok.some((x) => x.id.startsWith("text:"))).toBe(false);
    // too short everywhere
    const short = { ...doc, clips: [{ ...doc.clips[0]!, sourceStart: 1, sourceEnd: 1.5 }] };
    expect(platformWarnings(short, ["TIKTOK"], {}).some((x) => x.id === "duration-min:TIKTOK")).toBe(true);
    expect(safeRect(["TIKTOK", "INSTAGRAM"]).y0).toBe(220);
  });

  it("estimates text boxes centred on x/y", () => {
    const b = estimateTextBox(baseDoc().texts[0]!);
    expect((b.x0 + b.x1) / 2).toBeCloseTo(540);
    expect((b.y0 + b.y1) / 2).toBeCloseTo(0.15 * 1920);
  });
});
