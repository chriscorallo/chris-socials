import { describe, it, expect } from "vitest";
import { EditTimelineSchema, MOTION_TEMPLATES, MotionPropsSchemas, resolveVisualPlacements, type TimelineVisual, VISUAL_INTERACTION_DEFAULTS } from "@chris/media/timeline";
import { SAMPLE_PROPS } from "@chris/motion/pure";
import {
  TEMPLATE_FIELDS,
  addSfx,
  addVisual,
  autoPlaceVisuals,
  defaultVisualProps,
  deleteSfx,
  deleteVisual,
  duplicateVisual,
  firstNumber,
  freeSlotAt,
  moveVisualSpan,
  overlappingVisuals,
  phraseAt,
  placeVisualManually,
  plainRejection,
  setMusic,
  setSfxEnabled,
  trimVisualSpan,
  updateMusic,
  updateSfx,
  updateVisualProps,
  visualPropsProblem,
  visualSummary,
  visualWarnings,
  withResolvedPlacements,
  VISUAL_MIN_SECONDS,
} from "./visuals";
import { dbToGain, duckAmount, musicGainAt, musicTrackTime, speechRegions } from "./music-mix";
import { editorReducer, initEditorState, buildSavePayload } from "./reducer";
import { normalizeDoc } from "./timeline-ops";
import { sheetForSelection } from "./touch-math";
import type { EditorDoc } from "./types";

function doc(extra: Partial<EditorDoc> = {}): EditorDoc {
  return EditTimelineSchema.parse({
    version: 2,
    clips: [{ id: "c1", mediaAssetId: "A", sourceStart: 0, sourceEnd: 20 }],
    captions: { fontId: "inter-display-bold", fontSize: 64, color: "#FFFFFF", highlightColor: "#FFD84D" },
    ...extra,
  });
}

function vis(id: string, start: number, end: number, template: TimelineVisual["template"] = "ICON_3D"): TimelineVisual {
  return {
    id,
    template,
    props: SAMPLE_PROPS[template],
    start,
    end,
    ...VISUAL_INTERACTION_DEFAULTS,
    placement: { mode: "AUTO", x: 0.5, y: 0.3, scale: 1 },
    palette: "BRAND",
    enter: "AUTO",
    exit: "AUTO",
    enterSfx: "WHOOSH",
    anchorText: null,
  };
}

describe("props editor spec mirrors the motion contract", () => {
  it("has exactly the contract's keys for every template", () => {
    for (const t of MOTION_TEMPLATES) {
      const schemaKeys = Object.keys((MotionPropsSchemas[t] as unknown as { shape: Record<string, unknown> }).shape).sort();
      expect(TEMPLATE_FIELDS[t].map((f) => f.key).sort(), t).toEqual(schemaKeys);
    }
  });
  it("every template's default props render (validate against the contract)", () => {
    for (const t of MOTION_TEMPLATES) {
      expect(visualPropsProblem({ template: t, props: defaultVisualProps(t, "") }), t).toBeNull();
      expect(visualPropsProblem({ template: t, props: defaultVisualProps(t, "Save $24,500 before you invest a single dollar this year") }), t).toBeNull();
    }
  });
  it("words invalid props in plain English", () => {
    expect(visualPropsProblem({ template: "STAT_CARD", props: { value: "", label: "x", sublabel: null, trend: "NONE" } })).toMatch(/value can't be empty/);
    expect(visualPropsProblem({ template: "BAR_CHART", props: { ...SAMPLE_PROPS.BAR_CHART, bars: [{ label: "a", value: 1 }] } })).toMatch(/needs more entries/);
  });
});

describe("prefill from the phrase under the playhead", () => {
  const words = [
    { word: "Most", start: 0, end: 0.3 },
    { word: "people", start: 0.3, end: 0.6 },
    { word: "need", start: 0.6, end: 0.9 },
    { word: "$24,500.", start: 0.9, end: 1.5 },
    { word: "Then", start: 3, end: 3.3 },
    { word: "invest.", start: 3.3, end: 3.8 },
  ];
  it("takes the sentence around t, stopping at pauses/punctuation", () => {
    expect(phraseAt(words, 1)).toBe("Most people need $24,500.");
    expect(phraseAt(words, 3.1)).toBe("Then invest.");
    expect(phraseAt([], 1)).toBe("");
  });
  it("drops the words into text templates and the number into numeric ones", () => {
    expect(defaultVisualProps("KINETIC_TEXT", "Most people need $24,500.").text).toBe("Most people need $24,500.");
    expect(defaultVisualProps("NUMBER_COUNTER", "Most people need $24,500.")).toMatchObject({ value: 24500, prefix: "$" });
    expect(defaultVisualProps("PERCENT_RING", "about 62% of people").percent).toBe(62);
    expect(firstNumber("no numbers")).toBeNull();
    expect(firstNumber("$2.5k")).toEqual({ value: 2500, prefix: "$", suffix: "" });
  });
});

describe("visual ops: one track, never overlapping", () => {
  it("inserts at the playhead in the free gap, and refuses when there's no room", () => {
    let d = doc();
    const a = addVisual(d, "ICON_3D", 2, SAMPLE_PROPS.ICON_3D, "a");
    d = a.doc;
    expect(d.visuals[0]).toMatchObject({ id: "a", start: 2, end: 5, placement: { mode: "AUTO" } });
    // playhead inside "a" -> lands in the next gap
    const b = addVisual(d, "COMPARISON", 3, SAMPLE_PROPS.COMPARISON, "b");
    expect(b.doc.visuals.find((v) => v.id === "b")).toMatchObject({ start: 5, end: 8 });
    // a gap shorter than the minimum is skipped
    expect(freeSlotAt([vis("x", 0, 10), vis("y", 10.5, 20)], 10.2, 20)).toBeNull();
    expect(freeSlotAt([vis("x", 0, 10), vis("y", 12, 20)], 10.2, 20)).toEqual({ start: 10.2, end: 12 });
  });
  it("move and trim stop at the neighbours", () => {
    const d = doc({ visuals: [vis("a", 2, 5), vis("b", 8, 11)] });
    expect(moveVisualSpan(d, "a", 7).visuals[0]).toMatchObject({ start: 5, end: 8 });
    expect(moveVisualSpan(d, "b", 1).visuals[1]).toMatchObject({ start: 5, end: 8 });
    expect(trimVisualSpan(d, "a", "end", 9.5).visuals[0]!.end).toBe(8);
    expect(trimVisualSpan(d, "b", "start", 0).visuals[1]!.start).toBe(5);
    expect(trimVisualSpan(d, "a", "end", 2.1).visuals[0]!.end).toBeCloseTo(2 + VISUAL_MIN_SECONDS);
    expect(overlappingVisuals(moveVisualSpan(d, "a", 7).visuals)).toEqual([]);
  });
  it("duplicate goes into the next gap; delete removes", () => {
    const d = doc({ visuals: [vis("a", 2, 5)] });
    const dup = duplicateVisual(d, "a", "a2");
    expect(dup.doc.visuals.find((v) => v.id === "a2")).toMatchObject({ start: 5, end: 8, template: "ICON_3D" });
    expect(deleteVisual(dup.doc, "a").visuals.map((v) => v.id)).toEqual(["a2"]);
    expect(duplicateVisual(doc({ visuals: [vis("a", 0, 20)] }), "a").id).toBeNull();
  });
  it("dragging = MANUAL; Auto-place hands it back to the placement engine", () => {
    const d = doc({ visuals: [vis("a", 2, 5)] });
    const manual = placeVisualManually(d, "a", { x: 0.2, y: 0.8, scale: 3 });
    expect(manual.visuals[0]!.placement).toEqual({ mode: "MANUAL", x: 0.2, y: 0.8, scale: 2.5 });
    const solve = (x: EditorDoc) => resolveVisualPlacements(x, { subjectTracks: {} });
    const auto = autoPlaceVisuals(manual, ["a"], solve);
    expect(auto.visuals[0]!.placement.mode).toBe("AUTO");
    expect(auto.visuals[0]!.placement).toEqual(solve(auto)[0]!.placement);
    // resolved AUTO placements are written into the saved doc; MANUAL ones never move
    const saved = withResolvedPlacements(doc({ visuals: [vis("a", 2, 5), { ...vis("m", 6, 8), placement: { mode: "MANUAL", x: 0.1, y: 0.1, scale: 1 } }] }), [
      { ...vis("a", 2, 5), placement: { mode: "AUTO", x: 0.4, y: 0.2, scale: 0.9 } },
      { ...vis("m", 6, 8), placement: { mode: "MANUAL", x: 0.9, y: 0.9, scale: 1 } },
    ]);
    expect(saved.visuals[0]!.placement).toMatchObject({ x: 0.4, y: 0.2, scale: 0.9 });
    expect(saved.visuals[1]!.placement).toMatchObject({ x: 0.1, y: 0.1 });
  });
  it("normalizeDoc keeps visuals and sfx inside a shortened video", () => {
    const d = doc({ visuals: [vis("a", 15, 19)], sfx: [{ id: "s", at: 19.5, sound: "CLICK", volume: 0.6 }] });
    const short = normalizeDoc({ ...d, clips: [{ ...d.clips[0]!, sourceEnd: 10 }] });
    expect(short.visuals[0]).toMatchObject({ start: 6, end: 10 });
    expect(short.sfx[0]!.at).toBeLessThan(10);
  });
  it("track labels summarise what the graphic shows", () => {
    expect(visualSummary({ template: "NUMBER_COUNTER", props: { value: 24500, prefix: "$", suffix: "" } })).toBe("Counter · $24,500");
    expect(visualSummary({ template: "BAR_CHART", props: { bars: [1, 2, 3], depth3d: true } })).toBe("Bar chart · 3 bars · 3D");
    expect(visualSummary({ template: "ICON_3D", props: { icon: "PIGGY_BANK" } })).toBe("3D icon · Piggy bank");
  });
});

describe("undo, selection and saving", () => {
  it("every graphic edit is one undo step, and deleting clears the selection", () => {
    let s = initEditorState(doc(), { A: 20 });
    s = editorReducer(s, { type: "apply", recipe: (d) => addVisual(d, "ICON_3D", 1, SAMPLE_PROPS.ICON_3D, "a").doc, select: { kind: "visual", id: "a" } });
    s = editorReducer(s, { type: "apply", recipe: (d) => updateVisualProps(d, "a", { icon: "HOUSE", caption: null }), coalesce: "p" });
    s = editorReducer(s, { type: "apply", recipe: (d) => updateVisualProps(d, "a", { icon: "LOCK", caption: null }), coalesce: "p" });
    expect(s.past).toHaveLength(2);
    expect(s.selection).toEqual({ kind: "visual", id: "a" });
    s = editorReducer(s, { type: "apply", recipe: (d) => deleteVisual(d, "a") });
    expect(s.selection).toBeNull();
    s = editorReducer(s, { type: "undo" });
    expect(s.doc.visuals[0]!.props).toEqual({ icon: "LOCK", caption: null });
  });
  it("refuses to save a graphic that wouldn't render, naming it", () => {
    const bad = doc({ visuals: [{ ...vis("a", 2, 5, "STAT_CARD"), props: { value: "", label: "Saved", sublabel: null, trend: "NONE" } }] });
    const r = buildSavePayload(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/stat card at 2\.0s: value can't be empty/);
    expect(buildSavePayload(doc({ visuals: [vis("a", 2, 5)] })).ok).toBe(true);
  });
  it("sheets follow a graphic / sound effect selection into Visuals / Sound", () => {
    expect(sheetForSelection("clip", "visual")).toBe("visuals");
    expect(sheetForSelection("text", "sfx")).toBe("sound");
    expect(sheetForSelection("visuals", null)).toBe("visuals");
  });
});

describe("sound effects + music ops", () => {
  it("adds, moves, removes effects and toggles sound design", () => {
    let d = addSfx(doc(), 3, "CASH", "s1").doc;
    d = addSfx(d, 1, "TICK", "s2").doc;
    expect(d.sfx.map((s) => s.id)).toEqual(["s2", "s1"]);
    d = updateSfx(d, "s2", { at: 99 });
    expect(d.sfx.find((s) => s.id === "s2")!.at).toBeLessThan(20);
    expect(deleteSfx(d, "s1").sfx).toHaveLength(1);
    expect(setSfxEnabled(d, false).audio.sfxEnabled).toBe(false);
  });
  it("picks a music bed with defaults and keeps the mix when switching tracks", () => {
    let d = setMusic(doc(), "M1");
    expect(d.audio.music).toMatchObject({ musicAssetId: "M1", levelDb: -18, duckDb: 10 });
    d = updateMusic(d, { levelDb: -24, trackStart: 12 });
    d = setMusic(d, "M2");
    expect(d.audio.music).toMatchObject({ musicAssetId: "M2", levelDb: -24, trackStart: 0 });
    expect(setMusic(d, null).audio.music).toBeNull();
    expect(EditTimelineSchema.safeParse(d).success).toBe(true);
  });
  it("preview mix: duck under speech with lead-in/release, fades, track offset", () => {
    const regions = speechRegions([
      { start: 1, end: 1.4 },
      { start: 1.6, end: 2 },
      { start: 5, end: 6 },
    ]);
    expect(regions).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ]);
    expect(duckAmount(regions, 0.5)).toBe(0);
    expect(duckAmount(regions, 1.5)).toBe(1);
    expect(duckAmount(regions, 0.925)).toBeCloseTo(0.5);
    expect(duckAmount(regions, 2.2)).toBeCloseTo(0.5);
    const m = { levelDb: -18, duckDb: 10, fadeInSeconds: 0.6, fadeOutSeconds: 1.5 };
    expect(musicGainAt(m, regions, 3, 10)).toBeCloseTo(dbToGain(-18));
    expect(musicGainAt(m, regions, 1.5, 10)).toBeCloseTo(dbToGain(-28));
    expect(musicGainAt(m, regions, 0.3, 10)).toBeCloseTo(dbToGain(-18) / 2);
    expect(musicGainAt(m, regions, 9.25, 10)).toBeCloseTo(dbToGain(-18) / 2);
    expect(musicTrackTime({ trackStart: 30 }, 2, 60)).toBe(32);
    expect(musicTrackTime({ trackStart: 30 }, 31, 60)).toBeNull();
  });
});

describe("warnings + AI result wording", () => {
  it("reword placement warnings with the editor's names and times, plus broken props and overlaps", () => {
    const d = doc({ visuals: [vis("a", 2.1, 4), { ...vis("b", 3.5, 6, "STAT_CARD"), props: {} }] });
    const w = visualWarnings(d, [{ visualId: "a", code: "MANUAL_COVERS_SUBJECT", severity: "WARNING", message: "icon 3d at 2.1s covers Chris's face — switch it to Auto or move it." }]);
    expect(w.map((x) => x.message)).toEqual([
      "3D icon 2.1–4.0s covers Chris's face — switch it to Auto or move it.",
      expect.stringMatching(/^Stat card 3\.5–6\.0s won't render/),
      expect.stringMatching(/3D icon and Stat card overlap in time \(3\.5–4\.0s\)/),
    ]);
    expect(w[0]!.target).toEqual({ kind: "visual", id: "a" });
  });
  it("Motion Designer rejections read like a person wrote them", () => {
    expect(plainRejection({ template: "BAR_CHART", reason: "FACTUAL: 30000 (bars[1].value) not found in the research numeric inputs or the fact-checked script" })).toBe(
      "Dropped a bar chart: 30,000 isn't in your fact-checked research or script.",
    );
    expect(plainRejection({ template: "ICON_3D", reason: "over the FAST tier's limit of 4 new visual(s)" })).toMatch(/^Dropped a 3D icon: the video already has/);
  });
});
