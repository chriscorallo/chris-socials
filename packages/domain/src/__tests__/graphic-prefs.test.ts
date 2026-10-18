import { describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { RECENT_PRESETS_LIMIT, getGraphicPrefs, recordGraphicPresetUse, setGraphicFavorite } from "../graphic-prefs";

describe("graphics library prefs (favourites + recents)", () => {
  it("stars and unstars idempotently, per user", async () => {
    const u = `u-fav-${Date.now()}`;
    expect(await getGraphicPrefs(prisma, u)).toEqual({ favorites: [], recents: [] });
    await setGraphicFavorite(prisma, u, "income-3-people-12-months", true, new Date("2026-10-01"));
    await setGraphicFavorite(prisma, u, "income-3-people-12-months", true, new Date("2026-10-01"));
    const p = await setGraphicFavorite(prisma, u, "donut-50-30-20", true, new Date("2026-10-02"));
    expect(p.favorites).toEqual(["donut-50-30-20", "income-3-people-12-months"]);
    expect((await getGraphicPrefs(prisma, `${u}-other`)).favorites).toEqual([]);
    const after = await setGraphicFavorite(prisma, u, "donut-50-30-20", false);
    expect(after.favorites).toEqual(["income-3-people-12-months"]);
    expect(await prisma.graphicPresetPref.count({ where: { userId: u } })).toBe(2);
  });
  it("records recent use most-recent first, counts uses, caps the list", async () => {
    const u = `u-rec-${Date.now()}`;
    await recordGraphicPresetUse(prisma, u, "hero-salary", new Date("2026-10-01T10:00:00Z"));
    await recordGraphicPresetUse(prisma, u, "cta-follow", new Date("2026-10-01T11:00:00Z"));
    const p = await recordGraphicPresetUse(prisma, u, "hero-salary", new Date("2026-10-01T12:00:00Z"));
    expect(p.recents).toEqual(["hero-salary", "cta-follow"]);
    const row = await prisma.graphicPresetPref.findUniqueOrThrow({ where: { userId_presetId: { userId: u, presetId: "hero-salary" } } });
    expect(row.useCount).toBe(2);
    for (let i = 0; i < RECENT_PRESETS_LIMIT + 3; i++) await recordGraphicPresetUse(prisma, u, `p-${i}`, new Date(Date.UTC(2026, 9, 2, 0, i)));
    const all = await getGraphicPrefs(prisma, u);
    expect(all.recents).toHaveLength(RECENT_PRESETS_LIMIT);
    expect(all.recents[0]).toBe(`p-${RECENT_PRESETS_LIMIT + 2}`);
  });
  it("rejects malformed preset ids", async () => {
    await expect(setGraphicFavorite(prisma, "u", "../../etc", true)).rejects.toThrow(/Invalid preset id/);
    await expect(recordGraphicPresetUse(prisma, "u", "")).rejects.toThrow(/Invalid preset id/);
  });
});
