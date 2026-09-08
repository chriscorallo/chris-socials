import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { applyTransition } from "../state-machine";
import {
  createProductionContractAndAdvance,
  getProductionContract,
  ContractRequiresSelectedStateError,
} from "../production-contract";

async function makeSelectedItem() {
  const item = await createContentItem(prisma, { title: "Contract test idea" }, {
    actorId: "test-user",
  });
  await applyTransition(prisma, { contentItemId: item.id, to: "SELECTED", actorType: "SYSTEM" });
  return item;
}

const baseContract = {
  purpose: "Acquisition",
  primaryIdea: "Debt payoff math is simpler than it looks",
  audiencePromise: "You'll know exactly what to pay off first",
  topic: "Debt",
  format: "Talking head",
  productionTier: "FAST" as const,
  targetLengthMinSeconds: 30,
  targetLengthMaxSeconds: 60,
  researchDepth: "LIGHT" as const,
  factualRisk: "MEDIUM" as const,
  platformOpportunities: ["instagram", "tiktok"],
  requiredAssets: [],
  scope: "Explain avalanche vs snowball method with one concrete example.",
  doNotExpandInto: "Do not get into tax implications of debt settlement.",
};

describe("production contracts", () => {
  it("issuing a contract advances SELECTED -> CONTRACTED atomically", async () => {
    const item = await makeSelectedItem();

    const contract = await createProductionContractAndAdvance(
      prisma,
      { contentItemId: item.id, ...baseContract },
      { actorId: "chris" },
    );

    expect(contract.doNotExpandInto).toContain("tax implications");

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("CONTRACTED");

    const fetched = await getProductionContract(prisma, item.id);
    expect(fetched?.id).toBe(contract.id);
  });

  it("rejects issuing a contract from a state other than SELECTED", async () => {
    const item = await createContentItem(prisma, { title: "Still an idea" }, {
      actorId: "test-user",
    });

    await expect(
      createProductionContractAndAdvance(
        prisma,
        { contentItemId: item.id, ...baseContract },
        { actorId: "chris" },
      ),
    ).rejects.toBeInstanceOf(ContractRequiresSelectedStateError);

    const unchanged = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.currentState).toBe("IDEA");
  });

  it("rejects a target length range where max < min", async () => {
    const item = await makeSelectedItem();
    await expect(
      createProductionContractAndAdvance(
        prisma,
        {
          contentItemId: item.id,
          ...baseContract,
          targetLengthMinSeconds: 90,
          targetLengthMaxSeconds: 30,
        },
        { actorId: "chris" },
      ),
    ).rejects.toThrow();
  });

  it("requires DO_NOT_EXPAND_INTO to be non-empty", async () => {
    const item = await makeSelectedItem();
    await expect(
      createProductionContractAndAdvance(
        prisma,
        { contentItemId: item.id, ...baseContract, doNotExpandInto: "" },
        { actorId: "chris" },
      ),
    ).rejects.toThrow();
  });
});
