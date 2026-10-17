import { describe, it, expect } from "vitest";
import { describeUngroundedVisualNumbers, findUngroundedVisualNumbers } from "../quality-gate-job";

/** The FACTUAL gate's on-screen-number check is pure arithmetic — no DB, no model. */
const research = {
  primaryClaim: "Most people need an emergency fund of three to six months of expenses.",
  numericInputs: [
    { label: "Median monthly expenses", value: "$4,080" },
    { label: "Share living paycheck to paycheck", value: "62%" },
  ],
  facts: [{ statement: "A 7% return doubles money in about 10 years.", type: "FACT" }],
  calculationNotes: "6 x 4,080 = 24,480",
};
const script = { spokenScript: "If you save $500 a month, you'll get there in about four years." };

function visual(template: string, props: Record<string, unknown>, id = "v1", start = 2, end = 4) {
  return { id, template: template as never, props, start, end };
}

describe("findUngroundedVisualNumbers", () => {
  it("passes numbers that come from the research or the gated script, including honest roundings", () => {
    const found = findUngroundedVisualNumbers(
      [
        visual("NUMBER_COUNTER", { value: 24480, from: 0, prefix: "$", suffix: "", decimals: 0, label: "Six months of expenses" }),
        visual("STAT_CARD", { value: "$24K", label: "Your target", sublabel: null, trend: "NONE" }, "v2"),
        visual("PERCENT_RING", { percent: 62, label: "live paycheck to paycheck" }, "v3"),
        visual("KINETIC_TEXT", { text: "Save $500 a month for four years", emphasis: [], style: "PUNCH" }, "v4"),
        visual("ICON_3D", { icon: "PIGGY_BANK", caption: null }, "v5"),
      ],
      research,
      script,
    );
    expect(found).toEqual([]);
  });

  it("flags every number that isn't grounded, with the field it came from", () => {
    const found = findUngroundedVisualNumbers(
      [
        visual("BAR_CHART", {
          title: "Where it goes",
          bars: [
            { label: "Rent", value: 1800 },
            { label: "Food", value: 4080 },
          ],
          unit: "$",
          highlightIndex: 1,
          depth3d: true,
        }),
        visual("NUMBER_COUNTER", { value: 30000, from: 0, prefix: "$", suffix: "", decimals: 0, label: null }, "v2", 6, 9),
      ],
      research,
      script,
    );
    expect(found.map((f) => f.visualId)).toEqual(["v1", "v2"]);
    expect(found[0]!.numbers).toEqual([{ value: 1800, field: "bars[0].value" }]);
    expect(found[1]!.numbers.map((n) => n.value)).toEqual([30000]);
    const reason = describeUngroundedVisualNumbers(found);
    expect(reason).toMatch(/bar chart at 2\.0s shows 1,800/);
    expect(reason).toMatch(/number counter at 6\.0s shows 30,000/);
  });

  it("with no research and no gated script, any shown number is ungrounded; structural fields never count", () => {
    const found = findUngroundedVisualNumbers(
      [
        visual("CALLOUT", { text: "This fee", pointTo: { x: 0.7, y: 0.6 } }),
        visual("NUMBER_COUNTER", { value: 12, from: 0, prefix: "", suffix: "", decimals: 0, label: null }, "v2"),
      ],
      null,
      null,
    );
    expect(found.map((f) => f.visualId)).toEqual(["v2"]);
  });
});
