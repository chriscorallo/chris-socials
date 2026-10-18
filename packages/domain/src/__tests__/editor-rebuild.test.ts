import { describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { EDITOR_HEALTH_KEEP_DAYS, listEditorHealthReports, pruneEditorHealthReports, recordEditorHealthReport } from "../editor-health";
import { GRAPHIC_BAKE_RETRY_MS, markGraphicBakeFailed, markGraphicBakeReady, pendingGraphicBakes, pruneGraphicBakes, requestGraphicBakes } from "../graphic-bake";

/** docs/decisions-pending/editor-rebuild.md — telemetry storage + the baked-graphics cache. */

describe("editor health reports (telemetry endpoint storage)", () => {
  it("appends rows, lists the newest checkpoint per session plus every glitch, prunes old rows", async () => {
    const sid = `s-${Date.now()}`;
    const base = { userId: "u-health", contentItemId: null, engine: "compositor", userAgent: "test", report: { v: 1, totals: { playS: 1 } } };
    await recordEditorHealthReport(prisma, { ...base, sessionId: sid, kind: "session" }, new Date("2026-10-18T10:00:00Z"));
    await recordEditorHealthReport(prisma, { ...base, sessionId: sid, kind: "session", report: { v: 1, totals: { playS: 9 } } }, new Date("2026-10-18T10:02:00Z"));
    await recordEditorHealthReport(prisma, { ...base, sessionId: sid, kind: "glitch" }, new Date("2026-10-18T10:01:00Z"));
    const list = (await listEditorHealthReports(prisma)).filter((r) => r.sessionId === sid);
    expect(list.map((r) => r.kind)).toEqual(["session", "glitch"]);
    expect((list[0]!.report as { totals: { playS: number } }).totals.playS).toBe(9);
    // rows are never updated in place: all three exist
    expect(await prisma.editorHealthReport.count({ where: { sessionId: sid } })).toBe(3);
    // pruning: rows older than the retention window go
    const old = `s-old-${Date.now()}`;
    await prisma.editorHealthReport.create({ data: { ...base, sessionId: old, kind: "session", report: {}, createdAt: new Date("2026-08-01T00:00:00Z") } });
    await pruneEditorHealthReports(prisma, new Date(new Date("2026-08-01T00:00:00Z").getTime() + (EDITOR_HEALTH_KEEP_DAYS + 1) * 86_400_000));
    expect(await prisma.editorHealthReport.count({ where: { sessionId: old } })).toBe(0);
  });
});

describe("graphic bakes (preview cache rows)", () => {
  it("creates PENDING rows once, reports READY ones, retries FAILED after a while, prunes beyond the cap", async () => {
    const item = `c-bake-${Date.now()}`;
    const r1 = await requestGraphicBakes(prisma, item, [
      { key: "k1", input: { a: 1 } },
      { key: "k2", input: { a: 2 } },
      { key: "k1", input: { a: 1 } },
    ]);
    expect(r1.needsJob).toBe(true);
    expect(r1.states.map((s) => s.status).sort()).toEqual(["PENDING", "PENDING"]);
    const pending = await pendingGraphicBakes(prisma, item);
    expect(pending.map((p) => p.key).sort()).toEqual(["k1", "k2"]);
    await markGraphicBakeReady(prisma, pending.find((p) => p.key === "k1")!.id, { storageKey: `bakes/${item}/k1.mp4`, frames: 120, width: 540, height: 1920, fps: 30 });
    const failed = await markGraphicBakeFailed(prisma, pending.find((p) => p.key === "k2")!.id, "boom");
    const r2 = await requestGraphicBakes(prisma, item, [{ key: "k1", input: {} }, { key: "k2", input: {} }]);
    expect(r2.needsJob).toBe(false); // READY + recently FAILED → nothing to do
    expect(r2.states.find((s) => s.key === "k1")).toMatchObject({ status: "READY", frames: 120, storageKey: `bakes/${item}/k1.mp4` });
    const later = new Date(failed.updatedAt.getTime() + GRAPHIC_BAKE_RETRY_MS + 1000);
    const r3 = await requestGraphicBakes(prisma, item, [{ key: "k2", input: {} }], later);
    expect(r3.needsJob).toBe(true);
    expect(r3.states[0]!.status).toBe("PENDING");
    // prune keeps the newest N and returns the files of the rest
    const files = await pruneGraphicBakes(prisma, item, 1);
    expect(await prisma.graphicBake.count({ where: { contentItemId: item } })).toBe(1);
    expect(files.length).toBeLessThanOrEqual(1);
  });
});
