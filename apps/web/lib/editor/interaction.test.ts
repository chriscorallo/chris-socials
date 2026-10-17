import { describe, it, expect } from "vitest";
import { EditTimelineSchema, anchorOffsetFor, buildVisualInteractions, VISUAL_INTERACTION_DEFAULTS, type TimelineVisual } from "@chris/media/timeline";
import {
  addVisual,
  emphasisChoiceOf,
  moveAnchoredVisual,
  setCameraCoupling,
  setEmphasisTiming,
  setIntegration,
  setMotionTheme,
  setVisualDepth,
  setVisualFollow,
  withResolvedPlacements,
} from "./visuals";
import { editorReducer, initEditorState } from "./reducer";
import type { EditorDoc } from "./types";

/** Motion v2 controls in the finishing editor: pure doc ops + one undo step each. */

function doc(extra: Partial<EditorDoc> = {}): EditorDoc {
  return EditTimelineSchema.parse({
    version: 2,
    clips: [{ id: "c1", mediaAssetId: "A", sourceStart: 0, sourceEnd: 20 }],
    captions: { fontId: "inter-display-bold", fontSize: 64, color: "#FFFFFF", highlightColor: "#FFD84D" },
    ...extra,
  });
}
const card = (extra: Partial<TimelineVisual> = {}): TimelineVisual => ({
  id: "v",
  template: "STAT_CARD",
  props: { value: "7%", label: "Return", sublabel: null, trend: "NONE" },
  start: 2,
  end: 6,
  placement: { mode: "AUTO", x: 0.5, y: 0.3, scale: 1 },
  palette: "BRAND",
  enter: "AUTO",
  exit: "AUTO",
  enterSfx: null,
  anchorText: null,
  ...VISUAL_INTERACTION_DEFAULTS,
  ...extra,
});
const head = Array.from({ length: 61 }, (_, i) => ({ t: i / 3, box: { x: 0.3, y: 0.2, w: 0.4, h: 0.25 } }));

describe("Motion v2 editor ops", () => {
  it("new graphics get the veteran defaults; existing ones are never touched", () => {
    const a = addVisual(doc(), "BAR_CHART", 1, { bars: [{ label: "a", value: 1 }, { label: "b", value: 2 }] }, "b1");
    const b = a.doc.visuals[0]!;
    expect(b.cameraCoupling).toBe(0.35);
    expect(b.integration).toEqual({ shadow: true, sceneMatch: true, lightWrap: false });
    const i = addVisual(doc(), "ICON_3D", 1, { icon: "COIN", caption: null }, "i1").doc.visuals[0]!;
    expect(i.integration.lightWrap).toBe(true);
    expect(i.cameraCoupling).toBe(0);
  });

  it("Behind me pins the graphic where it's drawn (MANUAL) and toggles depth", () => {
    const d = doc({ visuals: [card()] });
    const on = setVisualDepth(d, "v", true, { placement: { mode: "AUTO", x: 0.4, y: 0.22, scale: 0.9 } });
    expect(on.visuals[0]!.depth).toBe("BEHIND_SUBJECT");
    expect(on.visuals[0]!.placement).toEqual({ mode: "MANUAL", x: 0.4, y: 0.22, scale: 0.9 });
    expect(setVisualDepth(on, "v", false).visuals[0]!.depth).toBe("FRONT");
  });

  it("Follow me keeps the graphic exactly where it is, then dragging moves the offset", () => {
    const d = doc({ visuals: [card({ placement: { mode: "MANUAL", x: 0.5, y: 0.62, scale: 0.6 } })] });
    const ctx = { subjectTracks: { A: head } };
    const off = anchorOffsetFor(d.visuals[0]!, d, 3, ctx)!;
    const on = setVisualFollow(d, "v", off);
    expect(on.visuals[0]!.anchor.type).toBe("SUBJECT");
    const ix = buildVisualInteractions(on, ctx, 30).v!;
    // At the playhead (3 s = local frame 30) the tracked centre is where it was placed.
    expect(ix.track!.x[30]).toBeCloseTo(0.5 * 1080, 0);
    expect(ix.track!.y[30]).toBeCloseTo(0.62 * 1920, 0);
    const moved = moveAnchoredVisual(on, "v", { offsetX: 0.1, offsetY: 0.2 }, { x: 0.6, y: 0.525 });
    expect(moved.visuals[0]!.anchor).toEqual({ type: "SUBJECT", offsetX: 0.1, offsetY: 0.2 });
    const off2 = setVisualFollow(moved, "v", null, { x: 0.61, y: 0.53 });
    expect(off2.visuals[0]!.anchor.type).toBe("SCREEN");
    expect(off2.visuals[0]!.placement).toMatchObject({ mode: "MANUAL", x: 0.61, y: 0.53 });
  });

  it("camera, integration, emphasis and theme", () => {
    let d = doc({ visuals: [card()] });
    d = setCameraCoupling(d, "v", 0.456);
    expect(d.visuals[0]!.cameraCoupling).toBe(0.46);
    d = setIntegration(d, "v", { lightWrap: true });
    expect(d.visuals[0]!.integration).toEqual({ shadow: true, lightWrap: true, sceneMatch: true });
    expect(emphasisChoiceOf(d.visuals[0]!)).toBe("AUTO");
    d = setEmphasisTiming(d, "v", "OFF");
    expect(d.visuals[0]!.emphasisAt).toBe(0);
    expect(emphasisChoiceOf(d.visuals[0]!)).toBe("OFF");
    d = setEmphasisTiming(d, "v", 1.234);
    expect(d.visuals[0]!.emphasisAt).toBe(1.234);
    d = setEmphasisTiming(d, "v", "AUTO");
    expect(d.visuals[0]!.emphasisAt).toBeNull();

    d = setMotionTheme(d, { name: "Debt pressure", motionLanguage: "PUNCHY", primary: "#FF5A36" });
    expect(d.motionTheme).toMatchObject({ name: "Debt pressure", motionLanguage: "PUNCHY", primary: "#FF5A36", iconStyle: "GOLD_METAL" });
    expect(setMotionTheme(d, { primary: "red" })).toBe(d); // invalid → unchanged
    expect(setMotionTheme(d, null).motionTheme).toBeNull();
    expect(EditTimelineSchema.safeParse(d).success).toBe(true);
  });

  it("auto-depth is persisted on save for AUTO graphics", () => {
    const d = doc({ visuals: [card({ template: "KINETIC_TEXT", props: { text: "Debt free", emphasis: [], style: "PUNCH" } })] });
    const saved = withResolvedPlacements(d, [{ ...d.visuals[0]!, depth: "BEHIND_SUBJECT", placement: { mode: "AUTO", x: 0.5, y: 0.24, scale: 1 } }]);
    expect(saved.visuals[0]!.depth).toBe("BEHIND_SUBJECT");
  });

  it("each control is one undo step through the reducer", () => {
    let s = initEditorState(doc({ visuals: [card()] }));
    s = editorReducer(s, { type: "apply", recipe: (d) => setVisualDepth(d, "v", true) });
    s = editorReducer(s, { type: "apply", recipe: (d) => setCameraCoupling(d, "v", 0.5) });
    expect(s.doc.visuals[0]!.depth).toBe("BEHIND_SUBJECT");
    s = editorReducer(s, { type: "undo" });
    expect(s.doc.visuals[0]!.cameraCoupling).toBe(0);
    expect(s.doc.visuals[0]!.depth).toBe("BEHIND_SUBJECT");
    s = editorReducer(s, { type: "undo" });
    expect(s.doc.visuals[0]!.depth).toBe("FRONT");
  });
});
