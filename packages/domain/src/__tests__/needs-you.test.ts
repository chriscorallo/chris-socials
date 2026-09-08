import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../prisma";
import { getNeedsYouQueue } from "../needs-you";
import { upsertWeeklyThesis } from "../weekly-thesis";

async function createContentItem(title: string) {
  return prisma.contentItem.create({ data: { title } });
}

describe("NEEDS YOU queue", () => {
  it("surfaces a QC_BLOCKED item under UNRESOLVED_QC", async () => {
    const title = `qc-blocked-${randomUUID()}`;
    const item = await createContentItem(title);
    await prisma.contentItem.update({ where: { id: item.id }, data: { currentState: "QC_BLOCKED" } });

    const { entries } = await getNeedsYouQueue(prisma, { limit: 200 });
    const entry = entries.find((e) => e.title === title);
    expect(entry?.category).toBe("UNRESOLVED_QC");
    expect(entry?.href).toBe(`/content/${item.id}`);
  });

  it("surfaces a RESEARCH_BLOCKED item under FACTUAL_NUANCE", async () => {
    const title = `research-blocked-${randomUUID()}`;
    const item = await createContentItem(title);
    await prisma.contentItem.update({
      where: { id: item.id },
      data: { currentState: "RESEARCH_BLOCKED" },
    });

    const { entries } = await getNeedsYouQueue(prisma, { limit: 200 });
    expect(entries.find((e) => e.title === title)?.category).toBe("FACTUAL_NUANCE");
  });

  it("surfaces a FAILED publication under PLATFORM_ISSUE, but not one superseded by a later success", async () => {
    const failedTitle = `pub-failed-${randomUUID()}`;
    const failedItem = await createContentItem(failedTitle);
    const failedPkg = await prisma.platformPackage.create({
      data: { contentItemId: failedItem.id, platform: "INSTAGRAM", caption: "x", hashtags: [] },
    });
    await prisma.publication.create({
      data: {
        contentItemId: failedItem.id,
        platform: "INSTAGRAM",
        platformPackageId: failedPkg.id,
        attempt: 1,
        idempotencyKey: `idem-${randomUUID()}`,
        status: "FAILED",
        errorMessage: "simulated platform outage",
      },
    });

    const recoveredTitle = `pub-recovered-${randomUUID()}`;
    const recoveredItem = await createContentItem(recoveredTitle);
    const recoveredPkg = await prisma.platformPackage.create({
      data: { contentItemId: recoveredItem.id, platform: "TIKTOK", caption: "x", hashtags: [] },
    });
    await prisma.publication.create({
      data: {
        contentItemId: recoveredItem.id,
        platform: "TIKTOK",
        platformPackageId: recoveredPkg.id,
        attempt: 1,
        idempotencyKey: `idem-${randomUUID()}`,
        status: "FAILED",
        errorMessage: "transient error",
      },
    });
    await prisma.publication.create({
      data: {
        contentItemId: recoveredItem.id,
        platform: "TIKTOK",
        platformPackageId: recoveredPkg.id,
        attempt: 2,
        idempotencyKey: `idem-${randomUUID()}`,
        status: "SUCCESS",
      },
    });

    const { entries } = await getNeedsYouQueue(prisma, { limit: 200 });
    expect(entries.some((e) => e.title.startsWith(failedTitle))).toBe(true);
    expect(entries.some((e) => e.title.startsWith(recoveredTitle))).toBe(false);
  });

  it("surfaces the current week's humanDecisionsNeeded under STRATEGY_DECISION", async () => {
    const decisionText = `decide-something-${randomUUID()}`;
    // Push weekStartDate far into the future so this becomes "the current" thesis
    // (getCurrentWeekThesis orders by weekStartDate desc) regardless of other tests' rows.
    await upsertWeeklyThesis(
      prisma,
      {
        weekStartDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 5),
        thesis: "test thesis",
        humanDecisionsNeeded: [decisionText],
      },
      { actorId: "test" },
    );

    const { entries } = await getNeedsYouQueue(prisma, { limit: 200 });
    const entry = entries.find((e) => e.title === decisionText);
    expect(entry?.category).toBe("STRATEGY_DECISION");
    expect(entry?.href).toBe("/strategy");
  });

  it("surfaces a PROPOSED belief under SUBJECTIVE_CHOICE, not an ACCEPTED one", async () => {
    const proposedStatement = `proposed-belief-${randomUUID()}`;
    const acceptedStatement = `accepted-belief-${randomUUID()}`;
    await prisma.belief.create({
      data: {
        statement: proposedStatement,
        isExperimentalEvidence: false,
        status: "PROPOSED",
        evidenceIds: ["ev-1"],
        sampleSize: 10,
        confidence: 0.7,
        confounders: [],
        contradictoryEvidence: [],
        proposedBy: "test",
      },
    });
    await prisma.belief.create({
      data: {
        statement: acceptedStatement,
        isExperimentalEvidence: false,
        status: "ACCEPTED",
        evidenceIds: ["ev-1"],
        sampleSize: 10,
        confidence: 0.7,
        confounders: [],
        contradictoryEvidence: [],
        proposedBy: "test",
        reviewedBy: "chris",
        reviewedAt: new Date(),
      },
    });

    const { entries } = await getNeedsYouQueue(prisma, { limit: 200 });
    expect(entries.find((e) => e.title === proposedStatement)?.category).toBe("SUBJECTIVE_CHOICE");
    expect(entries.some((e) => e.title === acceptedStatement)).toBe(false);
  });

  it("surfaces an AdversarialCritique with real concerns under UNCERTAINTY, not a clean one", async () => {
    const flaggedItem = await createContentItem(`critique-flagged-${randomUUID()}`);
    const cleanItem = await createContentItem(`critique-clean-${randomUUID()}`);

    await prisma.adversarialCritique.create({
      data: {
        artifactType: "ScriptVersion",
        artifactId: "artifact-1",
        contentItemId: flaggedItem.id,
        concerns: [{ description: "Claim reads as broader than the evidence supports", whyItMatters: "x", evidence: "y" }],
        noMaterialWeaknessesFound: false,
      },
    });
    await prisma.adversarialCritique.create({
      data: {
        artifactType: "ScriptVersion",
        artifactId: "artifact-2",
        contentItemId: cleanItem.id,
        concerns: [],
        noMaterialWeaknessesFound: true,
      },
    });

    const { entries } = await getNeedsYouQueue(prisma, { limit: 200 });
    expect(entries.some((e) => e.category === "UNCERTAINTY" && e.href === `/content/${flaggedItem.id}`)).toBe(true);
    expect(entries.some((e) => e.href === `/content/${cleanItem.id}`)).toBe(false);
  });

  it("caps the queue and reports the true count separately (no approval fatigue)", async () => {
    for (let i = 0; i < 5; i++) {
      const item = await createContentItem(`cap-test-${randomUUID()}`);
      await prisma.contentItem.update({ where: { id: item.id }, data: { currentState: "QC_BLOCKED" } });
    }

    const { entries, totalBeforeCap } = await getNeedsYouQueue(prisma, { limit: 3 });
    expect(entries.length).toBeLessThanOrEqual(3);
    expect(totalBeforeCap).toBeGreaterThanOrEqual(entries.length);
  });
});
