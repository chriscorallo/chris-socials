import { describe, expect, it } from "vitest";
import { EditTimelineSchema, GRAPHIC_PRESETS, GraphicPropsSchema, MotionPropsSchemas, presetById } from "@chris/media/timeline";
import {
  addColumn,
  addItem,
  addPresetVisual,
  addRow,
  fillRow,
  graphicPropsOf,
  moveItem,
  quickEntryInto,
  removeColumn,
  removeItem,
  removeRow,
  setCell,
  setGraphic,
} from "./graphics";
import { visualPropsProblem, visualSummary } from "./visuals";
import type { EditorDoc } from "./types";

function doc(): EditorDoc {
  return EditTimelineSchema.parse({
    version: 2,
    clips: [{ id: "c1", mediaAssetId: "A", sourceStart: 0, sourceEnd: 30 }],
    captions: { fontId: "inter-display-bold", fontSize: 64, color: "#FFFFFF", highlightColor: "#FFD84D" },
  });
}
const chris = () => GraphicPropsSchema.parse(presetById("income-3-people-12-months")!.props);

describe("library presets in the editor", () => {
  it("every preset inserts as a valid, renderable visual", () => {
    for (const p of GRAPHIC_PRESETS) {
      const r = addPresetVisual(doc(), p, 2, { id: "x" });
      expect(r.id, p.id).toBe("x");
      const v = r.doc.visuals[0]!;
      expect(visualPropsProblem(v), p.id).toBeNull();
      expect(MotionPropsSchemas[v.template].safeParse(v.props).success).toBe(true);
      expect(v.end - v.start).toBeCloseTo(Math.min(p.seconds, 28), 1);
      expect(EditTimelineSchema.safeParse(r.doc).success, p.id).toBe(true);
    }
  });
  it("uses the preset's length, placement and sound; labels with the preset name", () => {
    const p = presetById("income-3-people-12-months")!;
    const r = addPresetVisual(doc(), p, 1, { id: "g", anchorText: "as an employee" });
    const v = r.doc.visuals[0]!;
    expect(v.end - v.start).toBeCloseTo(9, 3);
    expect(v.placement).toMatchObject({ mode: "AUTO", x: 0.5, y: 0.5 });
    expect(v.enterSfx).toBe("SWOOSH_UP");
    expect(v.anchorText).toBe("as an employee");
    expect(visualSummary(v)).toMatch(/^Income comparison — 3 people × 12 months · Monthly income/);
    const manual = addPresetVisual(doc(), presetById("annotate-circle")!, 1, { id: "a" }).doc.visuals[0]!;
    expect(manual.placement.mode).toBe("MANUAL");
  });
  it("refuses when there's no room (graphics never overlap)", () => {
    let d = doc();
    for (let i = 0; i < 4; i++) d = addPresetVisual(d, presetById("income-3-people-12-months")!, i * 9, { id: `g${i}` }).doc;
    expect(addPresetVisual(d, presetById("hero-salary")!, 5, { id: "n" }).id).toBeNull();
  });
});

describe("data table + entries (pure)", () => {
  it("edits cells, rows and columns within the component's bounds", () => {
    let p = chris();
    p = setCell(p, 2, 9, 7000); // Business owner had 8 values: pads with 0
    expect(p.series[2]!.values).toHaveLength(10);
    expect(p.series[2]!.values[9]).toBe(7000);
    p = addRow(p);
    expect(p.series).toHaveLength(4);
    expect(p.series[3]!.values).toHaveLength(12);
    expect(addRow(p).series).toHaveLength(4); // VALUE_COLUMNS max 4
    p = removeRow(p, 3);
    expect(p.series).toHaveLength(3);
    p = removeColumn(p, 0);
    expect(p.series[0]!.values).toHaveLength(11);
    p = addColumn(p);
    expect(Math.max(...p.series.map((s) => s.values.length))).toBe(12);
    expect(addColumn(p).series[0]!.values).toHaveLength(12); // max 12 per column
    expect(GraphicPropsSchema.safeParse(p).success).toBe(true);
  });
  it("won't remove below the minimum", () => {
    const p = GraphicPropsSchema.parse(presetById("versus-rent-own")!.props);
    expect(removeRow(p, 0).series).toHaveLength(2);
  });
  it("fills a row from repeat text", () => {
    const r = fillRow(chris(), 1, "3k x12");
    expect(r.ok).toBe(true);
    expect(r.props.series[1]!.values).toEqual(Array(12).fill(3000));
    expect(fillRow(chris(), 1, "nope").ok).toBe(false);
  });
  it("adds formula terms before the result, removes and reorders entries", () => {
    let p = GraphicPropsSchema.parse(presetById("formula-take-home")!.props);
    p = addItem(p);
    expect(p.items.map((i) => i.op)).toEqual(["NONE", "MINUS", "MINUS", "PLUS", "EQUALS"]);
    p = removeItem(p, 3);
    expect(p.items).toHaveLength(4);
    p = moveItem(p, 1, -1);
    expect(p.items[0]!.text).toBe("Taxes");
    expect(moveItem(p, 0, -1)).toBe(p);
  });
  it("quick entry fills the graphic and stays valid", () => {
    const r = quickEntryInto(chris(), "Employee: 4k x12 | Freelance: 2k,6k,0,8k,3k,… | Business owner: 0, 5k, -15k, -5k, 50k, 5k, 0, 100k");
    expect(r.changed).toBe(true);
    expect(r.summary).toMatch(/3 rows/);
    expect(r.props.series[1]!.values).toEqual([2000, 6000, 0, 8000, 3000]);
    expect(quickEntryInto(chris(), "").changed).toBe(false);
  });
  it("writes back through the doc as one visual's props", () => {
    const d = addPresetVisual(doc(), presetById("income-3-people-12-months")!, 1, { id: "g" }).doc;
    const next = setGraphic(d, "g", { ...chris(), title: "My year" });
    expect(graphicPropsOf(next.visuals[0]!)!.title).toBe("My year");
  });
});

describe("library 2 in the editor (conversations, dialects)", () => {
  const chat = () => GraphicPropsSchema.parse({ component: "DM_CHAT", title: "Mom", items: [{ text: "you up?", side: "THEM" }] });
  it("quick entry speaks the component's dialect", () => {
    const r = quickEntryInto(chat(), "Mom: did you pay rent | Me: yes | Me: twice, apparently");
    expect(r.changed).toBe(true);
    expect(r.props.items.map((i) => i.side)).toEqual(["THEM", "ME", "ME"]);
    expect(quickEntryInto(chat(), "   ").changed).toBe(false);
  });
  it("adding a message alternates the side", () => {
    const a = addItem(chat());
    expect(a.items[1]!.side).toBe("ME");
    expect(addItem(a).items[2]!.side).toBe("THEM");
  });
  it("every library-2 preset inserts and validates", () => {
    for (const p of GRAPHIC_PRESETS.slice(171)) {
      const d = addPresetVisual(doc(), p, 0, { id: "v" }).doc;
      expect(d.visuals.length, p.id).toBe(1);
      expect(MotionPropsSchemas[p.template].safeParse(d.visuals[0]!.props).success, p.id).toBe(true);
    }
  });
});
