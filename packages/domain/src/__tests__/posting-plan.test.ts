import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../prisma";
import {
  getActivePostingPlan,
  savePostingPlan,
  listPostingPlanVersions,
  dismissNudge,
  listDismissedNudgeKeys,
} from "../posting-plan";
import { defaultPostingPlanData } from "../posting-plan-core";
import { loadCourseInput, getTodoData } from "../todo";
import { createContentItem } from "../content-item";

describe("PostingPlan persistence (append-only, single active)", () => {
  beforeEach(async () => {
    await prisma.postingPlan.deleteMany({});
  });

  it("returns null before any plan is saved", async () => {
    expect(await getActivePostingPlan(prisma)).toBeNull();
  });

  it("each save writes a new version and deactivates the previous one", async () => {
    const v1 = defaultPostingPlanData("2026-10-19", "America/Los_Angeles");
    await savePostingPlan(prisma, v1, { actorId: "chris" });
    const v2 = { ...v1, readyLeadDays: 2, cadences: v1.cadences.map((c) => (c.platform === "TIKTOK" ? { ...c, postsPerWeek: 7 } : c)) };
    await savePostingPlan(prisma, v2, { actorId: "chris" });

    const all = await listPostingPlanVersions(prisma);
    expect(all.map((r) => r.version)).toEqual([2, 1]);
    expect(all.filter((r) => r.active)).toHaveLength(1);
    const active = await getActivePostingPlan(prisma);
    expect(active?.version).toBe(2);
    expect(active?.readyLeadDays).toBe(2);
    expect(active?.cadences.find((c) => c.platform === "TIKTOK")?.postsPerWeek).toBe(7);
    // The old row is untouched (history, not overwrite).
    const old = all.find((r) => r.version === 1)!;
    expect((old.cadences as { postsPerWeek: number; platform: string }[]).find((c) => c.platform === "TIKTOK")?.postsPerWeek).toBe(5);

    const audits = await prisma.auditLog.findMany({ where: { action: "POSTING_PLAN_SAVED" } });
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects invalid input and duplicate platforms without writing", async () => {
    const bad = defaultPostingPlanData("2026-10-19", "America/Los_Angeles");
    await expect(savePostingPlan(prisma, { ...bad, cadences: [bad.cadences[0]!, bad.cadences[0]!] }, { actorId: "chris" })).rejects.toThrow(/only once/);
    await expect(
      savePostingPlan(prisma, { ...bad, cadences: [{ ...bad.cadences[0]!, preferredTimes: ["7pm"] }] }, { actorId: "chris" }),
    ).rejects.toThrow();
    expect(await listPostingPlanVersions(prisma)).toHaveLength(0);
  });
});

describe("nudge dismissals", () => {
  it("are per key per day and idempotent", async () => {
    await dismissNudge(prisma, "setup:cron", "2026-10-17");
    await dismissNudge(prisma, "setup:cron", "2026-10-17");
    expect([...(await listDismissedNudgeKeys(prisma, "2026-10-17"))]).toContain("setup:cron");
    expect((await listDismissedNudgeKeys(prisma, "2026-10-18")).has("setup:cron")).toBe(false);
  });
});

describe("loadCourseInput / getTodoData", () => {
  it("gathers items with schedule + publication data and builds a to-do list", async () => {
    const item = await createContentItem(prisma, { title: "Course gather test" }, { actorId: "test" });
    await prisma.contentItem.update({ where: { id: item.id }, data: { currentState: "SCHEDULED" } });
    await prisma.scheduleEntry.create({
      data: { contentItemId: item.id, scheduledDate: new Date("2026-10-15T02:00:00Z"), targetPlatforms: ["TIKTOK"] },
    });
    const now = new Date("2026-10-17T17:00:00Z");
    const input = await loadCourseInput(prisma, { now, tz: "America/Los_Angeles", plan: null });
    const mine = input.items.find((i) => i.id === item.id)!;
    expect(mine.scheduledAt?.toISOString()).toBe("2026-10-15T02:00:00.000Z");
    expect(mine.targetPlatforms).toEqual(["TIKTOK"]);

    const { todo, course } = await getTodoData(prisma, { now, tz: "America/Los_Angeles", anthropicKeyConfigured: true, voiceSamplesEmpty: false });
    expect(course.stuck.some((s) => s.kind === "MISSED" && s.contentItemId === item.id)).toBe(true);
    expect(todo.nudges.some((n) => n.key === `stuck:MISSED:${item.id}`)).toBe(true);
  });
});
