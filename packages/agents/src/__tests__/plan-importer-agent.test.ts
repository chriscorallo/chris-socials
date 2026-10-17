import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { runPlanImporterAgent, enforcePlanProvenance, sourceCoverage } from "../plan-importer-agent";

const TEXT = `ok so plan for next week
monday-ish: money myths thing, hook = "your parents lied to you about money", tiktok + reels
then wed maybe the budgeting one?? (why i stopped budgeting) all platforms`;

describe("Plan Importer agent (optional AI cleanup)", () => {
  it("uses the PLAN_IMPORTER prompt at MEDIUM with a strict schema", async () => {
    const provider = new MockModelProvider(() => ({
      rows: [
        { title: "Money myths", date: "2026-10-19", dateText: "monday-ish", time: null, platforms: ["TIKTOK", "INSTAGRAM"], hook: "Your parents lied to you about money", notes: null, format: null, pillar: null },
        { title: "Why I stopped budgeting", date: "2026-10-21", dateText: "wed", time: null, platforms: ["TIKTOK", "INSTAGRAM", "YOUTUBE"], hook: null, notes: null, format: null, pillar: null },
      ],
      warnings: [],
    }));
    const out = await runPlanImporterAgent(provider, { text: TEXT, today: "2026-10-17", startDate: "2026-10-19", enabledPlatforms: ["TIKTOK", "INSTAGRAM", "YOUTUBE"] });
    expect(out.rows).toHaveLength(2);
    expect(provider.calls[0]).toMatchObject({ promptId: "PLAN_IMPORTER", modelClass: "MEDIUM" });
    expect(provider.calls[0]!.userPrompt).toContain(TEXT);
  });

  it("schema rejects malformed output (e.g. a bad date)", async () => {
    const provider = new MockModelProvider(() => ({ rows: [{ title: "x", date: "Oct 19", dateText: "", time: null, platforms: [], hook: null, notes: null, format: null, pillar: null }], warnings: [] }));
    await expect(runPlanImporterAgent(provider, { text: "x", today: "2026-10-17", startDate: "2026-10-17", enabledPlatforms: ["TIKTOK"] })).rejects.toThrow();
  });

  it("provenance: invented videos are dropped, invented hooks cleared", () => {
    const res = enforcePlanProvenance(
      {
        rows: [
          { title: "Money myths", date: null, dateText: "", time: null, platforms: [], hook: "A brand new hook the model wrote", notes: null, format: null, pillar: null },
          { title: "10 Passive Income Ideas", date: null, dateText: "", time: null, platforms: [], hook: null, notes: null, format: null, pillar: null },
        ],
        warnings: [],
      },
      TEXT,
    );
    expect(res.rows.map((r) => r.title)).toEqual(["Money myths"]);
    expect(res.rows[0]!.hook).toBeNull();
    expect(res.warnings[0]).toContain("10 Passive Income Ideas");
    expect(sourceCoverage("why I stopped budgeting", TEXT)).toBe(1);
  });
});
