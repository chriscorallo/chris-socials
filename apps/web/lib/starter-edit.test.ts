import { describe, it, expect } from "vitest";
import { buildStarterPlan } from "@chris/domain";
import { EditPlanOutputSchema } from "@chris/agents";
import { timelineDuration } from "@chris/media/timeline";
import { initialEditorDoc } from "../app/content/[id]/edit/lib/initial-timeline";

// The no-AI starter edit (packages/domain starter-edit.ts) must be a plan the renderer and the
// editor accept exactly like an AI plan — domain can't import packages/agents, so the contract
// is pinned here. See docs/decisions-pending/flow.md.
describe("starter edit plan", () => {
  const plan = buildStarterPlan({ durationSeconds: 14.2, productionTier: "FAST", takeCount: 1 });
  const take = { id: "A", duration: 14.2, width: 1080, height: 1920 };

  it("is a valid EditPlanOutput (what render/QC/auto-repair parse)", () => {
    expect(EditPlanOutputSchema.safeParse(plan).success).toBe(true);
  });

  it("opens in the editor as the whole take with BOLD_HIGHLIGHT captions once word timings exist", () => {
    const doc = initialEditorDoc(plan, { ...take, hasWords: true });
    expect(doc.clips).toHaveLength(1);
    expect(doc.clips[0]).toMatchObject({ mediaAssetId: "A", sourceStart: 0, sourceEnd: 14.2 });
    expect(timelineDuration(doc)).toBeCloseTo(14.2);
    expect(doc.canvas).toEqual({ width: 1080, height: 1920 });
    expect(doc.captions).toMatchObject({ enabled: true, preset: "BOLD_HIGHLIGHT" });
  });

  it("holds captions off only while the transcript hasn't landed (derived at load time)", () => {
    const before = initialEditorDoc(plan, { ...take, hasWords: false });
    expect(before.captions.enabled).toBe(false);
    const after = initialEditorDoc(plan, { ...take, hasWords: true });
    expect(after.captions.enabled).toBe(true);
  });
});
