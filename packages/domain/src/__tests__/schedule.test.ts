import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import {
  setScheduleEntry,
  getScheduleEntry,
  listScheduleEntries,
  listUnscheduledReadyItems,
  scheduleContentItemForPublishing,
} from "../schedule";

async function makeReadyItem(title: string) {
  const item = await createContentItem(prisma, { title }, { actorId: "test-user" });
  // Bypasses the real state-machine path (see publish-pipeline.test.ts's makeReadyItem for the
  // full research->script->...->READY route) — this test is about the unscheduled-READY query,
  // not state-machine legality, so a direct state write is the right amount of setup.
  return prisma.contentItem.update({ where: { id: item.id }, data: { currentState: "READY" } });
}

describe("schedule entries (calendar shell)", () => {
  it("sets a schedule entry for a content item and can fetch it back", async () => {
    const item = await createContentItem(prisma, { title: "Calendar test idea" }, {
      actorId: "test-user",
    });
    const date = new Date("2026-09-14T15:00:00Z");

    await setScheduleEntry(prisma, { contentItemId: item.id, scheduledDate: date }, {
      actorId: "chris",
    });

    const entry = await getScheduleEntry(prisma, item.id);
    expect(entry?.scheduledDate.toISOString()).toBe(date.toISOString());
  });

  it("upserts — setting a new date for the same item replaces the old one, not duplicates it", async () => {
    const item = await createContentItem(prisma, { title: "Reschedule test idea" }, {
      actorId: "test-user",
    });

    await setScheduleEntry(
      prisma,
      { contentItemId: item.id, scheduledDate: new Date("2026-09-10T12:00:00Z") },
      { actorId: "chris" },
    );
    await setScheduleEntry(
      prisma,
      { contentItemId: item.id, scheduledDate: new Date("2026-09-12T12:00:00Z") },
      { actorId: "chris" },
    );

    const all = await prisma.scheduleEntry.findMany({ where: { contentItemId: item.id } });
    expect(all).toHaveLength(1);
    expect(all[0]?.scheduledDate.toISOString()).toBe("2026-09-12T12:00:00.000Z");
  });

  it("lists schedule entries with their content item", async () => {
    const item = await createContentItem(prisma, { title: "List calendar test idea" }, {
      actorId: "test-user",
    });
    await setScheduleEntry(
      prisma,
      { contentItemId: item.id, scheduledDate: new Date("2026-09-20T12:00:00Z") },
      { actorId: "chris" },
    );

    const entries = await listScheduleEntries(prisma);
    const found = entries.find((e) => e.contentItemId === item.id);
    expect(found?.contentItem.title).toBe("List calendar test idea");
  });
});

describe("listUnscheduledReadyItems — the Auto-Fill Week / manual-placement pool", () => {
  it("includes a READY item with no ScheduleEntry yet", async () => {
    const tag = randomUUID();
    const item = await makeReadyItem(`unscheduled-ready-${tag}`);

    const pool = await listUnscheduledReadyItems(prisma);
    expect(pool.some((i) => i.id === item.id)).toBe(true);
  });

  it("excludes a READY item that already has a ScheduleEntry", async () => {
    const tag = randomUUID();
    const item = await makeReadyItem(`scheduled-ready-${tag}`);
    await scheduleContentItemForPublishing(
      prisma,
      { contentItemId: item.id, scheduledDate: new Date(), targetPlatforms: ["INSTAGRAM"] },
      { actorId: "chris" },
    );

    const pool = await listUnscheduledReadyItems(prisma);
    expect(pool.some((i) => i.id === item.id)).toBe(false);
  });

  it("excludes an IDEA-state item even with no schedule entry", async () => {
    const tag = randomUUID();
    const item = await createContentItem(prisma, { title: `idea-${tag}` }, { actorId: "test-user" });

    const pool = await listUnscheduledReadyItems(prisma);
    expect(pool.some((i) => i.id === item.id)).toBe(false);
  });
});
