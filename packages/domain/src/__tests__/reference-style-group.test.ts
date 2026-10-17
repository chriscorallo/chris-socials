import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import {
  findOrCreateReferenceCreator,
  registerReferenceVideo,
  recordReferenceAnalysis,
  getReferenceStyleProfile,
  setReferenceCreatorStyleGroup,
  creatorStyleGroup,
  FACELESS_STYLE_FORMAT,
} from "../reference-videos";
import { fakeMetrics } from "./style-fixtures";

const actor = { actorId: "chris" };
let n = 0;

async function measured(creatorId: string, shot: number) {
  const v = await registerReferenceVideo(prisma, { referenceCreatorId: creatorId, storageKey: `reference/${creatorId}/${Date.now()}-${n++}-clip.mp4`, filename: "clip.mp4", mimeType: "video/mp4", sizeBytes: 1 }, actor);
  await recordReferenceAnalysis(prisma, v.id, { metrics: fakeMetrics({ shot }) }, actor);
}

describe("reference style groups (talking vs no-face motivational)", () => {
  it("defaults to MAIN and reads the tag", () => {
    expect(creatorStyleGroup([])).toBe("MAIN");
    expect(creatorStyleGroup(null)).toBe("MAIN");
    expect(creatorStyleGroup(["Talking head", FACELESS_STYLE_FORMAT])).toBe("FACELESS");
  });

  it("keeps a no-face creator out of the main target style and gives it its own", async () => {
    const talker = await findOrCreateReferenceCreator(prisma, { name: `Talker ${Date.now()}` }, actor);
    const faceless = await findOrCreateReferenceCreator(prisma, { name: `mindset ${Date.now()}` }, actor);
    await measured(talker.id, 1.5);
    await measured(faceless.id, 4);
    await measured(faceless.id, 5);

    const mainBefore = await getReferenceStyleProfile(prisma, { group: "MAIN" });
    await setReferenceCreatorStyleGroup(prisma, faceless.id, "FACELESS", actor);
    const mainAfter = await getReferenceStyleProfile(prisma, { group: "MAIN" });
    const own = await getReferenceStyleProfile(prisma, { group: "FACELESS" });

    expect(mainAfter.sampleSize).toBe(mainBefore.sampleSize - 2);
    expect(own.sampleSize).toBe(2);
    expect(own.creatorCount).toBe(1);

    // Idempotent, reversible, keeps other format tags, and audited.
    await setReferenceCreatorStyleGroup(prisma, faceless.id, "FACELESS", actor);
    let row = await prisma.referenceCreator.findUniqueOrThrow({ where: { id: faceless.id } });
    expect(row.formats).toEqual([FACELESS_STYLE_FORMAT]);
    await setReferenceCreatorStyleGroup(prisma, faceless.id, "MAIN", actor);
    row = await prisma.referenceCreator.findUniqueOrThrow({ where: { id: faceless.id } });
    expect(row.formats).toEqual([]);
    expect((await getReferenceStyleProfile(prisma, { group: "MAIN" })).sampleSize).toBe(mainBefore.sampleSize);
    const audits = await prisma.auditLog.count({ where: { entityId: faceless.id, action: "REFERENCE_CREATOR_STYLE_GROUP_SET" } });
    expect(audits).toBe(3);
  });
});

describe("moving a reference video to another creator", () => {
  it("moves to an existing creator or a new one by name, audits, and is a no-op onto itself", async () => {
    const { moveReferenceVideo } = await import("../reference-videos");
    const wrong = await findOrCreateReferenceCreator(prisma, { name: `Wrong ${Date.now()}` }, actor);
    const v = await registerReferenceVideo(prisma, { referenceCreatorId: wrong.id, storageKey: `reference/${wrong.id}/${Date.now()}-${n++}-x.mp4`, filename: "x.mp4" }, actor);

    const toNew = await moveReferenceVideo(prisma, v.id, { name: `Jun Yuh ${Date.now()}` }, actor);
    expect(toNew.moved).toBe(true);
    expect((await prisma.referenceContent.findUniqueOrThrow({ where: { id: v.id } })).referenceCreatorId).toBe(toNew.referenceCreatorId);

    const back = await moveReferenceVideo(prisma, v.id, { referenceCreatorId: wrong.id }, actor);
    expect(back.referenceCreatorId).toBe(wrong.id);
    expect((await moveReferenceVideo(prisma, v.id, { referenceCreatorId: wrong.id }, actor)).moved).toBe(false);
    expect(await prisma.auditLog.count({ where: { entityId: v.id, action: "REFERENCE_VIDEO_MOVED" } })).toBe(2);
    await expect(moveReferenceVideo(prisma, v.id, { name: "  " }, actor)).rejects.toThrow();
  });
});
