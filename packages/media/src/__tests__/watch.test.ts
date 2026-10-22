import { describe, it, expect } from "vitest";
import { EditTimelineSchema, type EditTimeline } from "../timeline";
import { applyWatchFixes, auditStory, type WatchFix } from "../watch";
import type { EditorPlan } from "../full-edit/editor-plan";

const tl = (): EditTimeline =>
  EditTimelineSchema.parse({
    version: 2,
    clips: [
      { id: "c1", mediaAssetId: "take", sourceStart: 0, sourceEnd: 5 },
      { id: "c2", mediaAssetId: "take", sourceStart: 5.4, sourceEnd: 12 },
      { id: "c3", mediaAssetId: "take", sourceStart: 13, sourceEnd: 20 },
    ],
    texts: [{ id: "fe-beat-1", text: "SAME SALARY", start: 5.5, end: 10, preset: "HEADLINE", fontId: "inter-display-extrabold", fontSize: 60, color: "#FFFFFF", backgroundColor: null, strokeColor: null, x: 0.5, y: 0.2, maxWidth: 0.8 }],
    zooms: [{ id: "fe-z-1", start: 6, end: 9, zoom: 1.08, x: 0.5, y: 0.4, mode: "EASE", easeSeconds: 0.4 }],
    visuals: [{ id: "g1", template: "KINETIC_TEXT", start: 14, end: 16, props: { text: "x" }, placement: { mode: "AUTO", x: 0.5, y: 0.3, scale: 1 } }],
    captions: { fontId: "inter-display-extrabold", fontSize: 44, color: "#FFFFFF", highlightColor: "#FFD84D", y: 0.72 },
  });

describe("watch-back — typed fixes applied to the timeline", () => {
  it("SCREEN moves, shrinks, drops and retimes elements; SPLICE retimes a cut within bounds; EDITOR fixes become re-cut choices", () => {
    const fixes: WatchFix[] = [
      { stage: "SCREEN", op: "MOVE", elementId: "fe-beat-1", to: "NEAR_SPEAKER", why: "on the face" },
      { stage: "SCREEN", op: "SHRINK", elementId: "g1", why: "loud" },
      { stage: "SCREEN", op: "RETIME", elementId: "fe-z-1", deltaS: 1, why: "late" },
      { stage: "SPLICE", op: "RETIME", cutIndex: 0, deltaMs: -100, side: "BOTH", why: "a gap" },
      { stage: "EDITOR", op: "DROP_LINE", sentenceId: 4, why: "repeats" },
    ];
    const r = applyWatchFixes(tl(), fixes);
    const text = r.timeline.texts[0]!;
    expect(text.anchor).toBe("NEAR_SPEAKER");
    expect(text.y).toBe(0.6);
    expect(r.timeline.visuals[0]!.placement.scale).toBe(0.8);
    expect(r.timeline.zooms[0]).toMatchObject({ start: 7, end: 10 });
    // tighten 100 ms: 50 ms off each side of the cut
    expect(r.timeline.clips[0]!.sourceEnd).toBe(4.95);
    expect(r.timeline.clips[1]!.sourceStart).toBe(5.45);
    expect(r.editor.forceDrop).toEqual([4]);
    expect(r.applied).toHaveLength(5);
    expect(r.skipped).toEqual([]);
  });
  it("unknown elements and impossible cuts are skipped, never applied; at most five fixes", () => {
    const fixes: WatchFix[] = [
      { stage: "SCREEN", op: "DROP", elementId: "nope", why: "" },
      { stage: "SPLICE", op: "RETIME", cutIndex: 7, deltaMs: 50, side: "BOTH", why: "" },
      { stage: "SCREEN", op: "DROP", elementId: "g1", why: "" },
    ];
    const r = applyWatchFixes(tl(), fixes);
    expect(r.skipped).toHaveLength(2);
    expect(r.timeline.visuals).toHaveLength(0);
    const six = Array.from({ length: 6 }, (): WatchFix => ({ stage: "SCREEN", op: "SHRINK", elementId: "fe-beat-1", why: "" }));
    expect(applyWatchFixes(tl(), six).applied).toHaveLength(5);
  });
});

describe("watch-back — the free story audit", () => {
  const plan: EditorPlan = {
    storyline: [
      { sentenceId: 1, role: "HOOK", headline: "H" },
      { sentenceId: 3, role: "TENSION", headline: "T" },
      { sentenceId: 5, role: "PAYOFF", headline: "P" },
      { sentenceId: 7, role: "ENDING", headline: "E" },
    ],
    cut: [],
    pacing: "LONG_SHOTS_ZOOMS",
    rationale: "",
  };
  const lines = [
    { id: 1, text: "Two people make the same money." },
    { id: 2, text: "One rents." },
    { id: 3, text: "The saver wins by four thousand." },
    { id: 5, text: "The number is the point." },
    { id: 7, text: "Which one are you?" },
  ];
  it("a clean cut is clean", () => {
    expect(auditStory(plan, [1, 3, 5, 7].map((id) => ({ sentenceId: id, text: lines.find((l) => l.id === id)!.text })), lines)).toEqual([]);
  });
  it("names a missing line, a changed order, a dependent opener whose referent was cut, and an ending that isn't last", () => {
    const dependent = lines.map((l) => (l.id === 3 ? { ...l, text: "So that's why the saver wins." } : l));
    const kept = [1, 5, 3].map((id) => ({ sentenceId: id, text: dependent.find((l) => l.id === id)!.text }));
    const kinds = auditStory(plan, kept, dependent).map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(["LINE_MISSING", "ORDER_CHANGED", "DEPENDENT_OPENER", "ENDING_NOT_LAST"]));
  });
});
