import { describe, it, expect } from "vitest";
import { computeUploadLatency, READY_BUDGET_MINUTES } from "../latency";
import { FULL_EDIT_AUTO_REASON, STYLE_CUT_AUTO_REASON } from "../style-cut-plan";

const at = (min: number) => new Date(Date.UTC(2026, 9, 21, 12, 0, 0) + min * 60_000);

describe("upload → ready latency", () => {
  it("measures from the first take to the first automatic edit after it", () => {
    const l = computeUploadLatency(
      [{ createdAt: at(1), transcribedAt: at(3) }, { createdAt: at(0), transcribedAt: at(2.5) }],
      [
        { createdAt: at(-5), revisionReason: FULL_EDIT_AUTO_REASON }, // before this upload (old footage)
        { createdAt: at(4), revisionReason: "Finishing edit by Chris" },
        { createdAt: at(9.5), revisionReason: STYLE_CUT_AUTO_REASON },
        { createdAt: at(6.25), revisionReason: FULL_EDIT_AUTO_REASON },
      ],
    );
    expect(l).toMatchObject({ uploadedAt: at(0), transcribedAt: at(2.5), readyAt: at(6.25), minutes: 6.3, overBudget: false });
  });

  it("flags over budget, and says not-ready when no automatic edit landed", () => {
    expect(computeUploadLatency([{ createdAt: at(0), transcribedAt: null }], [{ createdAt: at(READY_BUDGET_MINUTES + 1), revisionReason: FULL_EDIT_AUTO_REASON }])!.overBudget).toBe(true);
    expect(computeUploadLatency([{ createdAt: at(0), transcribedAt: null }], [])).toMatchObject({ readyAt: null, minutes: null, overBudget: false });
    expect(computeUploadLatency([], [])).toBeNull();
  });
});

describe("hand edits vs machine saves under Chris's name", () => {
  it("only the editor's own saves count as hand edits", async () => {
    const { isHandEditReason } = await import("../style-cut-plan");
    expect(isHandEditReason("Finishing edit by Chris")).toBe(true);
    expect(isHandEditReason("Finishing edit by Chris: tightened the ending")).toBe(true);
    expect(isHandEditReason("Finishing edit by Chris: Full edit — 1:02 → 0:41")).toBe(false);
    expect(isHandEditReason("Finishing edit by Chris: Style cut — 12 pauses out")).toBe(false);
    expect(isHandEditReason("Finishing edit by Chris: Plain full take (style cut off)")).toBe(false);
    expect(isHandEditReason("Finishing edit by Chris: Motion Designer: 2 visual(s) added (Design visuals with AI)")).toBe(false);
    expect(isHandEditReason("Full edit (automatic, no AI)")).toBe(false);
    expect(isHandEditReason(null)).toBe(false);
  });
});
