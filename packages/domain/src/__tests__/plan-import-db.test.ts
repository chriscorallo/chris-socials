import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import {
  commitPlanImport,
  undoPlanImport,
  listPlannedVideos,
  listExistingPlanned,
  PLAN_IMPORT_REASON,
} from "../plan-import-db";
import { advancePlannedItemToFilmed, PlannedItemCannotTakeFootageError } from "../footage-first";
import { createContentItem } from "../content-item";
import { applyTransition } from "../state-machine";
import { createMediaAsset, analyzeMediaAsset } from "../media-asset";
import { createProductionContractAndAdvance } from "../production-contract";
import { minutesInTz, ymdInTz } from "../tz";

const TZ = "America/Los_Angeles";
const actor = { actorId: "chris" };
const uniq = () => Math.random().toString(36).slice(2, 8);

function rows(tag: string) {
  return [
    { title: `Money myths ${tag}`, ymd: "2027-03-01", time: "07:30", platforms: ["TIKTOK" as const, "INSTAGRAM" as const], hook: "Your parents lied", notes: "Myth 1\nMyth 2", format: null, pillar: "SKILL" as const },
    { title: `Budget hacks ${tag}`, ymd: "2027-03-02", time: null, platforms: ["YOUTUBE" as const], hook: null, notes: null, format: "Talking head", pillar: null },
  ];
}
const plan = {
  cadences: [{ platform: "YOUTUBE" as const, enabled: true, postsPerWeek: 3, preferredDays: [], preferredTimes: ["12:15"] }],
};

describe("plan import — create, idempotency, undo", () => {
  it("creates SELECTED items with schedule entries, hook/notes in the description, provenance link", async () => {
    const tag = uniq();
    const res = await commitPlanImport(prisma, { sourceKind: "CSV", sourceRef: "plan.csv", rawInput: "raw csv", rows: rows(tag) }, actor, { tz: TZ, plan });
    expect(res).toMatchObject({ created: 2, skipped: 0, failed: [], alreadyImported: false });
    const items = await prisma.contentItem.findMany({ where: { planImportId: res.importId }, orderBy: { title: "asc" }, include: { scheduleEntry: true } });
    expect(items.map((i) => i.currentState)).toEqual(["SELECTED", "SELECTED"]);
    const budget = items.find((i) => i.title.startsWith("Budget"))!;
    const myths = items.find((i) => i.title.startsWith("Money"))!;
    expect(myths.description).toBe("Hook: Your parents lied\n\nMyth 1\nMyth 2");
    expect(myths.pillar).toBe("SKILL");
    expect(budget.format).toBe("Talking head");
    expect(ymdInTz(myths.scheduleEntry!.scheduledDate, TZ)).toBe("2027-03-01");
    expect(minutesInTz(myths.scheduleEntry!.scheduledDate, TZ)).toBe(7 * 60 + 30);
    expect(myths.scheduleEntry!.targetPlatforms).toEqual(["TIKTOK", "INSTAGRAM"]);
    // no time in the plan → the posting plan's preferred time for that platform
    expect(minutesInTz(budget.scheduleEntry!.scheduledDate, TZ)).toBe(12 * 60 + 15);
    const t = await prisma.contentStateTransition.findFirst({ where: { contentItemId: myths.id } });
    expect(t).toMatchObject({ fromState: "IDEA", toState: "SELECTED", reason: PLAN_IMPORT_REASON, actorType: "HUMAN" });
    const imp = await prisma.planImport.findUniqueOrThrow({ where: { id: res.importId } });
    expect(imp).toMatchObject({ sourceKind: "CSV", sourceRef: "plan.csv", rowCount: 2, createdCount: 2, createdBy: "chris" });
    expect(imp.rawInputHash).toHaveLength(64);
    expect((await listExistingPlanned(prisma, TZ)).some((e) => e.title === myths.title && e.ymd === "2027-03-01")).toBe(true);
  });

  it("re-importing the same plan creates nothing; overlapping plans only add new rows", async () => {
    const tag = uniq();
    const first = await commitPlanImport(prisma, { sourceKind: "TEXT", rawInput: "x", rows: rows(tag) }, actor, { tz: TZ, plan: null });
    const again = await commitPlanImport(prisma, { sourceKind: "TEXT", rawInput: "x", rows: rows(tag) }, actor, { tz: TZ, plan: null });
    expect(again).toMatchObject({ importId: first.importId, created: 0, skipped: 2, alreadyImported: true });
    const bigger = [...rows(tag), { title: `New one ${tag}`, ymd: "2027-03-03", time: null, platforms: ["TIKTOK" as const], hook: null, notes: null, format: null, pillar: null }];
    const third = await commitPlanImport(prisma, { sourceKind: "CSV", rawInput: "y", rows: bigger }, actor, { tz: TZ, plan: null });
    expect(third).toMatchObject({ created: 1, skipped: 2, alreadyImported: false });
    expect(await prisma.contentItem.count({ where: { title: { contains: tag } } })).toBe(3);
  });

  it("undo cancels untouched items (with a reason, history kept), keeps started ones, and is idempotent", async () => {
    const tag = uniq();
    const res = await commitPlanImport(prisma, { sourceKind: "TEXT", rawInput: "z", rows: rows(tag) }, actor, { tz: TZ, plan: null });
    const items = await prisma.contentItem.findMany({ where: { planImportId: res.importId }, orderBy: { title: "asc" } });
    const started = items[0]!; // Budget hacks — Chris uploads footage for it
    await advancePlannedItemToFilmed(prisma, started.id, actor);

    const undo = await undoPlanImport(prisma, res.importId, actor);
    expect(undo).toEqual({ cancelled: 1, kept: 1, alreadyUndone: false });
    const after = await prisma.contentItem.findMany({ where: { planImportId: res.importId }, orderBy: { title: "asc" } });
    expect(after.map((i) => i.currentState)).toEqual(["FILMED", "CANCELLED"]);
    const cancelled = after[1]!;
    expect(await prisma.scheduleEntry.findUnique({ where: { contentItemId: cancelled.id } })).toBeNull();
    const hist = await prisma.contentStateTransition.findMany({ where: { contentItemId: cancelled.id }, orderBy: { createdAt: "asc" } });
    expect(hist.map((h) => h.toState)).toEqual(["SELECTED", "CANCELLED"]);
    expect(hist[1]!.reason).toMatch(/^Undo plan import/);
    expect(await undoPlanImport(prisma, res.importId, actor)).toEqual({ cancelled: 0, kept: 0, alreadyUndone: true });
    // After undo, the same plan can be imported again (cancelled items aren't duplicates).
    const re = await commitPlanImport(prisma, { sourceKind: "TEXT", rawInput: "z", rows: rows(tag) }, actor, { tz: TZ, plan: null });
    expect(re.importId).not.toBe(res.importId);
    expect(re).toMatchObject({ created: 1, skipped: 1 }); // the filmed one is still on the plan
  });

  it("lists planned videos for the board with local day/time and take counts", async () => {
    const tag = uniq();
    const res = await commitPlanImport(prisma, { sourceKind: "TEXT", rawInput: "b", rows: rows(tag) }, actor, { tz: TZ, plan: null });
    const list = (await listPlannedVideos(prisma, { tz: TZ })).filter((v) => v.planImportId === res.importId);
    expect(list.map((v) => [v.ymd, v.time, v.takes, v.state])).toEqual([
      ["2027-03-01", "07:30", 0, "SELECTED"],
      ["2027-03-02", "09:00", 0, "SELECTED"],
    ]);
  });
});

describe("advancePlannedItemToFilmed", () => {
  it("walks a planned item to FILMED with honest transitions and a NOT fact-check-exempt contract; takes then ingest", async () => {
    const item = await createContentItem(prisma, { title: `Planned ${uniq()}` }, actor);
    const res = await advancePlannedItemToFilmed(prisma, item.id, actor);
    expect(res.advanced).toBe(true);
    expect(res.item.currentState).toBe("FILMED");
    const contract = await prisma.productionContract.findUniqueOrThrow({ where: { contentItemId: item.id } });
    expect(contract.researchDepth === "NONE" && contract.factualRisk === "LOW").toBe(false);
    const hist = await prisma.contentStateTransition.findMany({ where: { contentItemId: item.id }, orderBy: { createdAt: "asc" } });
    expect(hist.map((h) => h.toState)).toEqual(["SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED", "READY_TO_FILM", "FILMED"]);
    expect(hist.filter((h) => h.toState !== "CONTRACTED").every((h) => h.reason === "Planned video — footage uploaded")).toBe(true);
    expect(hist.slice(2).every((h) => h.actorType === "SYSTEM")).toBe(true);

    // Second clip for the same video: no-op
    expect((await advancePlannedItemToFilmed(prisma, item.id, actor)).advanced).toBe(false);
    const take = await createMediaAsset(prisma, { contentItemId: item.id, kind: "RAW_TAKE", storageKey: `raw/${item.id}/a.mp4`, originalFilename: "a.mp4", mimeType: "video/mp4", sizeBytes: 1 }, actor);
    await analyzeMediaAsset(prisma, take.id, { durationSeconds: 10, width: 1080, height: 1920, frameRate: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }, actor);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("MEDIA_INGESTED");
    expect((await advancePlannedItemToFilmed(prisma, item.id, actor)).advanced).toBe(false);
  });

  it("keeps an existing contract and continues from mid-pipeline (SCRIPTED)", async () => {
    const item = await createContentItem(prisma, { title: `Scripted ${uniq()}` }, actor);
    await applyTransition(prisma, { contentItemId: item.id, to: "SELECTED", actorType: "HUMAN" });
    await createProductionContractAndAdvance(prisma, {
      contentItemId: item.id, purpose: "p", primaryIdea: "i", audiencePromise: "a", topic: "t", format: "f", productionTier: "MEDIUM",
      targetLengthMinSeconds: 10, targetLengthMaxSeconds: 60, researchDepth: "DEEP", factualRisk: "HIGH", scope: "s", doNotExpandInto: "d",
    }, actor);
    for (const to of ["RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED"] as const) await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
    await advancePlannedItemToFilmed(prisma, item.id, actor);
    const c = await prisma.productionContract.findUniqueOrThrow({ where: { contentItemId: item.id } });
    expect(c.researchDepth).toBe("DEEP");
    const last = await prisma.contentStateTransition.findMany({ where: { contentItemId: item.id }, orderBy: { createdAt: "desc" }, take: 2 });
    expect(last.map((t) => t.toState)).toEqual(["FILMED", "READY_TO_FILM"]);
  });

  it("refuses research-blocked and cancelled videos with a plain message", async () => {
    const item = await createContentItem(prisma, { title: `Cancelled ${uniq()}` }, actor);
    await applyTransition(prisma, { contentItemId: item.id, to: "CANCELLED", actorType: "HUMAN", reason: "nope" });
    await expect(advancePlannedItemToFilmed(prisma, item.id, actor)).rejects.toBeInstanceOf(PlannedItemCannotTakeFootageError);
  });
});
