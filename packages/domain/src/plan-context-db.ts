import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";
import { buildPlanContextText, type PlanContextText } from "./plan-context/context-text";
import { conversationStats, type PlanContextMessage } from "./plan-context/types";

/**
 * Plan context persistence — Chris's ChatGPT planning conversation(s). Private business data:
 * read only by signed-in pages and by model calls Chris triggers (`getActivePlanContext`).
 * Versioned (a re-import of the same chat adds a version, never overwrites; the latest is
 * active), idempotent (same content → no new version), deletable (text purged; the AuditLog
 * keeps who/when/hashes but never the text). See docs/decisions-pending/plan-context.md.
 */

export const PLAN_CONTEXT_SOURCES = ["EXPORT", "CHAT_HTML", "SHARE_LINK", "PASTE"] as const;
/** ~3M characters — far beyond any planning chat; protects the database from a wrong file. */
export const MAX_PLAN_CONTEXT_CHARS = 3_000_000;

const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "unknown"]),
  text: z.string().min(1).max(MAX_PLAN_CONTEXT_CHARS),
  at: z.string().datetime().nullable(),
});

export const SavePlanContextSchema = z.object({
  source: z.enum(PLAN_CONTEXT_SOURCES),
  sourceRef: z.string().max(2000).nullish(),
  conversationId: z.string().max(200).nullish(),
  title: z.string().trim().min(1).max(300),
  conversationCreatedAt: z.string().datetime().nullish(),
  conversationUpdatedAt: z.string().datetime().nullish(),
  messages: z.array(MessageSchema).min(1).max(50_000),
  /** Add as a new version of this saved conversation (paste "update"). */
  planContextId: z.string().nullish(),
});
export type SavePlanContextInput = z.input<typeof SavePlanContextSchema>;

export interface SavePlanContextResult {
  planContextId: string;
  versionId: string;
  version: number;
  status: "created" | "new-version" | "unchanged";
}

export class PlanContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanContextError";
  }
}

/** sha256 of the conversation's content (roles + text, whitespace-normalized). Timestamps
 * are left out so a re-export of an unchanged chat is recognized. */
export function planContextHash(messages: PlanContextMessage[]): string {
  const canon = messages.map((m) => [m.role, m.text.replace(/\s+/g, " ").trim()]);
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

export async function savePlanContext(prisma: PrismaClient, raw: SavePlanContextInput, actor: { actorId: string }): Promise<SavePlanContextResult> {
  const input = SavePlanContextSchema.parse(raw);
  const messages: PlanContextMessage[] = input.messages.map((m) => ({ role: m.role, text: m.text, at: m.at }));
  const stats = conversationStats(messages);
  if (stats.charCount > MAX_PLAN_CONTEXT_CHARS) throw new PlanContextError("That conversation is too long to save (over 3 million characters).");
  const contentHash = planContextHash(messages);

  // Which saved conversation is this? Explicit target → same ChatGPT conversation id → same
  // share link → new.
  let existing = input.planContextId ? await prisma.planContext.findUnique({ where: { id: input.planContextId } }) : null;
  if (input.planContextId && !existing) throw new PlanContextError("That saved conversation no longer exists.");
  if (!existing && input.conversationId) existing = await prisma.planContext.findFirst({ where: { conversationId: input.conversationId }, orderBy: { createdAt: "asc" } });
  if (!existing && input.source === "SHARE_LINK" && input.sourceRef) {
    const v = await prisma.planContextVersion.findFirst({ where: { sourceRef: input.sourceRef }, orderBy: { createdAt: "asc" } });
    if (v) existing = await prisma.planContext.findUnique({ where: { id: v.planContextId } });
  }

  if (existing) {
    const latest = await prisma.planContextVersion.findFirst({ where: { planContextId: existing.id }, orderBy: { version: "desc" } });
    if (latest && latest.contentHash === contentHash) {
      return { planContextId: existing.id, versionId: latest.id, version: latest.version, status: "unchanged" };
    }
  }

  return prisma.$transaction(async (tx) => {
    const ctx =
      existing ??
      (await tx.planContext.create({
        data: { title: input.title, source: input.source, conversationId: input.conversationId ?? null, createdBy: actor.actorId },
      }));
    const last = await tx.planContextVersion.findFirst({ where: { planContextId: ctx.id }, orderBy: { version: "desc" } });
    const version = (last?.version ?? 0) + 1;
    const v = await tx.planContextVersion.create({
      data: {
        planContextId: ctx.id,
        version,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        conversationId: input.conversationId ?? null,
        conversationTitle: input.title,
        conversationCreatedAt: input.conversationCreatedAt ? new Date(input.conversationCreatedAt) : null,
        conversationUpdatedAt: input.conversationUpdatedAt ? new Date(input.conversationUpdatedAt) : null,
        messages: messages as unknown as object,
        messageCount: stats.messageCount,
        charCount: stats.charCount,
        wordCount: stats.wordCount,
        contentHash,
        createdBy: actor.actorId,
      },
    });
    // Touch updatedAt (and keep ChatGPT's id once we learn it).
    await tx.planContext.update({
      where: { id: ctx.id },
      data: { conversationId: ctx.conversationId ?? input.conversationId ?? null, title: existing ? existing.title : input.title },
    });
    await recordAudit(tx, {
      actor: actor.actorId,
      actorType: "HUMAN",
      action: "PLAN_CONTEXT_IMPORTED",
      entityType: "PlanContext",
      entityId: ctx.id,
      // Private: counts and a hash only — never the conversation text.
      metadata: {
        version,
        source: input.source,
        sourceRef: input.source === "PASTE" ? null : (input.sourceRef ?? null),
        conversationId: input.conversationId ?? null,
        messageCount: stats.messageCount,
        charCount: stats.charCount,
        contentHash,
      },
    });
    return { planContextId: ctx.id, versionId: v.id, version, status: existing ? "new-version" : "created" } as SavePlanContextResult;
  });
}

export interface PlanContextListItem {
  id: string;
  title: string;
  source: string;
  useForAi: boolean;
  updatedAt: Date;
  versionCount: number;
  latest: { id: string; version: number; messageCount: number; wordCount: number; createdAt: Date; conversationUpdatedAt: Date | null } | null;
}

export async function listPlanContexts(prisma: PrismaClient): Promise<PlanContextListItem[]> {
  const rows = await prisma.planContext.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      versions: {
        orderBy: { version: "desc" },
        select: { id: true, version: true, messageCount: true, wordCount: true, createdAt: true, conversationUpdatedAt: true },
      },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    source: r.source,
    useForAi: r.useForAi,
    updatedAt: r.updatedAt,
    versionCount: r.versions.length,
    latest: r.versions[0] ?? null,
  }));
}

function readMessages(json: unknown): PlanContextMessage[] {
  return Array.isArray(json) ? (json as PlanContextMessage[]).filter((m) => m && typeof m.text === "string") : [];
}

/** One saved conversation with a version's messages (latest by default) and its version list. */
export async function getPlanContext(prisma: PrismaClient, id: string, versionId?: string | null) {
  const ctx = await prisma.planContext.findUnique({ where: { id } });
  if (!ctx) return null;
  const versions = await prisma.planContextVersion.findMany({
    where: { planContextId: id },
    orderBy: { version: "desc" },
    select: { id: true, version: true, source: true, sourceRef: true, messageCount: true, wordCount: true, charCount: true, createdAt: true, conversationUpdatedAt: true },
  });
  const chosenId = versionId && versions.some((v) => v.id === versionId) ? versionId : versions[0]?.id;
  const v = chosenId ? await prisma.planContextVersion.findUnique({ where: { id: chosenId } }) : null;
  return {
    context: ctx,
    versions,
    version: v ? { ...v, messages: readMessages(v.messages) } : null,
    isLatest: !!v && v.id === versions[0]?.id,
  };
}

/** Text of chosen messages of one version (for "Update my plan from this conversation"). */
export async function getPlanContextMessageTexts(prisma: PrismaClient, versionId: string, messageIndices: number[]): Promise<{ title: string; texts: string[] } | null> {
  const v = await prisma.planContextVersion.findUnique({ where: { id: versionId } });
  if (!v) return null;
  const msgs = readMessages(v.messages);
  const texts = [...new Set(messageIndices)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < msgs.length)
    .sort((a, b) => a - b)
    .map((i) => msgs[i]!.text);
  return { title: v.conversationTitle ?? "ChatGPT conversation", texts };
}

export async function setPlanContextUseForAi(prisma: PrismaClient, id: string, useForAi: boolean, actor: { actorId: string }) {
  const before = await prisma.planContext.findUnique({ where: { id } });
  if (!before) throw new PlanContextError("That saved conversation no longer exists.");
  if (before.useForAi === useForAi) return before;
  const after = await prisma.planContext.update({ where: { id }, data: { useForAi } });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "PLAN_CONTEXT_AI_USE_CHANGED",
    entityType: "PlanContext",
    entityId: id,
    before: { useForAi: before.useForAi },
    after: { useForAi },
  });
  return after;
}

/** Purges the conversation text (all versions). The audit trail stays — titles, counts and
 * hashes only, per docs/SECURITY.md. Idempotent: deleting twice is a no-op. */
export async function deletePlanContext(prisma: PrismaClient, id: string, actor: { actorId: string }): Promise<{ deleted: boolean }> {
  const ctx = await prisma.planContext.findUnique({ where: { id }, include: { versions: { select: { version: true, contentHash: true, messageCount: true } } } });
  if (!ctx) return { deleted: false };
  await prisma.$transaction(async (tx) => {
    await recordAudit(tx, {
      actor: actor.actorId,
      actorType: "HUMAN",
      action: "PLAN_CONTEXT_DELETED",
      entityType: "PlanContext",
      entityId: id,
      before: { title: ctx.title, source: ctx.source, conversationId: ctx.conversationId, versions: ctx.versions },
      metadata: { reason: "Deleted by Chris — conversation text purged; history kept." },
    });
    await tx.planContext.delete({ where: { id } });
  });
  return { deleted: true };
}

export interface ActivePlanContext extends PlanContextText {
  sources: { planContextId: string; title: string; versionId: string; version: number }[];
}

/**
 * The domain API other features call (the in-app Script agent and Weekly Strategist, the
 * ChatGPT connector): every saved conversation Chris left "Use for AI" on, latest version,
 * newest first, as one bounded text block — Highlights + the most recent messages first when
 * it has to cut, with an honest `truncated` flag. Empty text when nothing is saved.
 */
export async function getActivePlanContext(prisma: PrismaClient, opts: { maxChars: number }): Promise<ActivePlanContext> {
  const contexts = await prisma.planContext.findMany({ where: { useForAi: true }, orderBy: { updatedAt: "desc" } });
  const inputs: { title: string; importedAt: string | null; messages: PlanContextMessage[] }[] = [];
  const sources: ActivePlanContext["sources"] = [];
  for (const c of contexts) {
    const v = await prisma.planContextVersion.findFirst({ where: { planContextId: c.id }, orderBy: { version: "desc" } });
    if (!v) continue;
    inputs.push({ title: c.title, importedAt: v.createdAt.toISOString(), messages: readMessages(v.messages) });
    sources.push({ planContextId: c.id, title: c.title, versionId: v.id, version: v.version });
  }
  return { ...buildPlanContextText(inputs, { maxChars: opts.maxChars }), sources };
}

/** Token budgets (≈4 chars/token) for the agents that read the plan context. */
export const PLAN_CONTEXT_BUDGET_CHARS = {
  SCRIPT: 6_000,
  WEEKLY_STRATEGIST: 12_000,
} as const;

/** The plan-context text for one agent, within its budget — undefined when nothing is saved
 * or the read fails (fail safe: an agent run never breaks because of optional context). */
export async function getPlanContextForAgent(prisma: PrismaClient, agent: keyof typeof PLAN_CONTEXT_BUDGET_CHARS): Promise<string | undefined> {
  try {
    const ctx = await getActivePlanContext(prisma, { maxChars: PLAN_CONTEXT_BUDGET_CHARS[agent] });
    return ctx.text || undefined;
  } catch {
    return undefined;
  }
}
