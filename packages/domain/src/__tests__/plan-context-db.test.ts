import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { commitPlanImport } from "../plan-import-db";
import {
  deletePlanContext,
  getActivePlanContext,
  getPlanContext,
  getPlanContextMessageTexts,
  listPlanContexts,
  savePlanContext,
  setPlanContextUseForAi,
} from "../plan-context-db";
import { findPlanCandidates, parseConversationsJsonText, parsePlanSegments } from "../plan-context";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const exportJson = readFileSync(join(ROOT, "fixtures", "chatgpt-export", "conversations.json"), "utf8");
const actor = { actorId: "chris" };
const uniq = () => Math.random().toString(36).slice(2, 8);
const TZ = "America/Los_Angeles";

function planChat(tag: string) {
  const c = parseConversationsJsonText(exportJson).find((x) => x.conversationId === "conv-plan-0001")!;
  return { ...c, conversationId: `conv-${tag}`, title: `Plan chat ${tag}` };
}

function saveInput(c: ReturnType<typeof planChat>, extra: Partial<Parameters<typeof savePlanContext>[1]> = {}) {
  return {
    source: "EXPORT" as const,
    sourceRef: "chatgpt-export.zip",
    conversationId: c.conversationId,
    title: c.title,
    conversationCreatedAt: c.createdAt,
    conversationUpdatedAt: c.updatedAt,
    messages: c.messages,
    ...extra,
  };
}

describe("Plan context (database)", () => {
  it("saves a conversation; re-importing the same chat is a no-op; an updated export adds a version", async () => {
    const tag = uniq();
    const c = planChat(tag);
    const first = await savePlanContext(prisma, saveInput(c), actor);
    expect(first).toMatchObject({ status: "created", version: 1 });

    const again = await savePlanContext(prisma, saveInput(c), actor);
    expect(again).toEqual({ ...first, status: "unchanged" });

    const updated = { ...c, messages: [...c.messages, { role: "user" as const, text: "Add a week 3 please", at: "2026-10-18T10:00:00.000Z" }] };
    const second = await savePlanContext(prisma, saveInput(updated), actor);
    expect(second).toMatchObject({ planContextId: first.planContextId, status: "new-version", version: 2 });

    const got = (await getPlanContext(prisma, first.planContextId))!;
    expect(got.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(got.isLatest).toBe(true);
    expect(got.version!.messages).toHaveLength(7);
    // The old version is still there, unchanged.
    const v1 = (await getPlanContext(prisma, first.planContextId, first.versionId))!;
    expect(v1.version!.messages).toHaveLength(6);
    expect(v1.isLatest).toBe(false);

    const audits = await prisma.auditLog.findMany({ where: { entityId: first.planContextId, action: "PLAN_CONTEXT_IMPORTED" } });
    expect(audits).toHaveLength(2);
    // Private: the audit row never carries the conversation text.
    expect(JSON.stringify(audits)).not.toContain("Money Reset");

    const listed = (await listPlanContexts(prisma)).find((x) => x.id === first.planContextId)!;
    expect(listed).toMatchObject({ versionCount: 2, useForAi: true, latest: { version: 2, messageCount: 7 } });
  });

  it("paste → explicit 'update' target; share link → same link becomes a version", async () => {
    const tag = uniq();
    const paste = await savePlanContext(prisma, { source: "PASTE", title: `Pasted ${tag}`, messages: [{ role: "unknown", text: `notes ${tag}`, at: null }] }, actor);
    const upd = await savePlanContext(prisma, { source: "PASTE", title: "x", planContextId: paste.planContextId, messages: [{ role: "unknown", text: `notes ${tag} v2`, at: null }] }, actor);
    expect(upd).toMatchObject({ planContextId: paste.planContextId, version: 2 });
    // A different paste without a target is a new conversation.
    const other = await savePlanContext(prisma, { source: "PASTE", title: `Other ${tag}`, messages: [{ role: "unknown", text: `notes ${tag} v2`, at: null }] }, actor);
    expect(other.planContextId).not.toBe(paste.planContextId);

    const link = `https://chatgpt.com/share/${tag}-0000-1111`;
    const s1 = await savePlanContext(prisma, { source: "SHARE_LINK", sourceRef: link, title: `Shared ${tag}`, messages: [{ role: "user", text: "a", at: null }] }, actor);
    const s2 = await savePlanContext(prisma, { source: "SHARE_LINK", sourceRef: link, title: `Shared ${tag}`, messages: [{ role: "user", text: "a b", at: null }] }, actor);
    expect(s2).toMatchObject({ planContextId: s1.planContextId, version: 2 });

    await expect(savePlanContext(prisma, { source: "PASTE", title: "x", planContextId: "missing", messages: [{ role: "unknown", text: "x", at: null }] }, actor)).rejects.toThrow(/no longer exists/);
  });

  it("delete purges the text but keeps the audit trail; idempotent", async () => {
    const tag = uniq();
    const saved = await savePlanContext(prisma, saveInput(planChat(tag)), actor);
    expect(await deletePlanContext(prisma, saved.planContextId, actor)).toEqual({ deleted: true });
    expect(await prisma.planContext.findUnique({ where: { id: saved.planContextId } })).toBeNull();
    expect(await prisma.planContextVersion.count({ where: { planContextId: saved.planContextId } })).toBe(0);
    const audit = await prisma.auditLog.findMany({ where: { entityId: saved.planContextId }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["PLAN_CONTEXT_IMPORTED", "PLAN_CONTEXT_DELETED"]);
    expect(JSON.stringify(audit)).not.toContain("Money Reset");
    expect(await deletePlanContext(prisma, saved.planContextId, actor)).toEqual({ deleted: false });
  });

  it("getActivePlanContext: only 'Use for AI' conversations, bounded, honest truncation flag", async () => {
    const tag = uniq();
    const saved = await savePlanContext(prisma, saveInput(planChat(tag)), actor);
    const big = await getActivePlanContext(prisma, { maxChars: 200_000 });
    expect(big.sources.some((s) => s.planContextId === saved.planContextId)).toBe(true);
    expect(big.text).toContain(`Plan chat ${tag}`);
    expect(big.text).toContain("Money Reset");

    const small = await getActivePlanContext(prisma, { maxChars: 2500 });
    expect(small.chars).toBeLessThanOrEqual(2500);
    expect(small.truncated).toBe(true);

    await setPlanContextUseForAi(prisma, saved.planContextId, false, actor);
    const off = await getActivePlanContext(prisma, { maxChars: 200_000 });
    expect(off.sources.some((s) => s.planContextId === saved.planContextId)).toBe(false);
    expect(await prisma.auditLog.count({ where: { entityId: saved.planContextId, action: "PLAN_CONTEXT_AI_USE_CHANGED" } })).toBe(1);
    await setPlanContextUseForAi(prisma, saved.planContextId, true, actor);
  });

  it("“Update my plan from this conversation”: found rows go through plan import (no duplicates)", async () => {
    const tag = uniq();
    const c = planChat(tag);
    const saved = await savePlanContext(prisma, saveInput(c), actor);
    const ctx = { today: "2026-10-17", enabledPlatforms: ["TIKTOK" as const] };
    const cands = findPlanCandidates(c.messages, ctx);
    const picked = await getPlanContextMessageTexts(prisma, saved.versionId, cands.map((x) => x.messageIndex));
    expect(picked!.texts).toHaveLength(2);
    const rows = parsePlanSegments(picked!.texts, ctx).rows.filter((r) => r.ymd);
    const commit = () =>
      commitPlanImport(
        prisma,
        {
          sourceKind: "TEXT",
          sourceRef: `ChatGPT conversation: ${picked!.title}`,
          rawInput: picked!.texts.join("\n\n"),
          rows: rows.map((r) => ({ title: `${r.title} ${tag}`, ymd: r.ymd!, time: r.time, platforms: r.platforms, hook: r.hook, notes: r.notes, format: r.format, pillar: r.pillar })),
        },
        actor,
        { tz: TZ, plan: null },
      );
    const first = await commit();
    expect(first.created).toBe(9);
    const second = await commit();
    expect(second).toMatchObject({ created: 0, alreadyImported: true });
    // Out-of-range / duplicate indices are ignored.
    expect((await getPlanContextMessageTexts(prisma, saved.versionId, [99, -1, 3, 3]))!.texts).toHaveLength(1);
  });
});
