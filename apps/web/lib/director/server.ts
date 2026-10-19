import { createHash } from "node:crypto";
import { recheckAiCreditIfStale } from "../ai-credit-probe";
import {
  appendDirectorMessage,
  getDirectorAiAvailability,
  getLatestEditPlan,
  getLatestTakeUnderstandings,
  listDirectorMessages,
  parseSubjectTrackRecord,
  parseTranscriptWords,
  saveDirectorEdit,
  takesMissingUnderstanding,
  undoDirectorEdit,
  ANTHROPIC_CREDIT_ERROR_RE,
  type DirectorProvider,
  type PrismaClient,
  creativeBriefTextFor,
} from "@chris/domain";
import {
  applyDirectorAnswer,
  buildDirectorPack,
  contactSheetPlan,
  parseDirectorAnswer,
  parseTakeUnderstanding,
  readDirectorRecord,
  DirectorAnswerSchema,
  type ContactSheetPlan,
  type DirectorAnswer,
  type DirectorChange,
  type DirectorTurn,
  type TakeUnderstanding,
} from "@chris/media/director";
import { nodeMeasureText, timelineDuration, type EditTimeline, type PlacementOptions, type TranscriptWord } from "@chris/media";
import { estimateDirectorCostUsd, runDirectorAgent, type ModelProvider } from "@chris/agents";
import { resolveDailyCapUsd } from "../model-provider";
import { initialEditorDoc } from "../../app/content/[id]/edit/lib/initial-timeline";

/**
 * Director chat — server side (shared by the Server Actions and the /api/director/ask route;
 * tested directly). Everything here is deterministic except the optional paid call, which only
 * runs when Chris taps "Ask AI" with credit available. See docs/decisions-pending/director-chat.md.
 */

export const DIRECTOR_FREE: DirectorProvider = "FREE_CHATGPT";

export interface DirectorContext {
  itemId: string;
  title: string;
  state: string;
  planId: string;
  timeline: EditTimeline;
  understanding: Record<string, TakeUnderstanding | null>;
  wordsByAsset: Record<string, TranscriptWord[] | null>;
  placement: PlacementOptions;
  record: ReturnType<typeof readDirectorRecord>;
  /** The Creative Brief this video was made to (prompt text), when it has one. */
  brief: string | null;
}

export async function loadDirectorContext(prisma: PrismaClient, itemId: string): Promise<DirectorContext> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: itemId }, select: { id: true, title: true, currentState: true } });
  const plan = await getLatestEditPlan(prisma, itemId);
  if (!plan) throw new Error("This video has no edit yet.");
  const takes = await prisma.mediaAsset.findMany({ where: { contentItemId: itemId, kind: "RAW_TAKE", removedAt: null }, orderBy: { createdAt: "asc" } });
  const sel = await prisma.takeSelection.findUnique({ where: { id: plan.takeSelectionId }, select: { selectedMediaAssetId: true } });
  const selected = takes.find((t) => t.id === sel?.selectedMediaAssetId) ?? takes[0];
  const timeline = initialEditorDoc(plan.plan, {
    id: selected?.id ?? "",
    duration: selected?.durationSeconds ?? 0,
    hasWords: !!parseTranscriptWords(selected?.transcriptWords)?.length,
    width: selected?.width ?? null,
    height: selected?.height ?? null,
  });
  const ids = takes.map((t) => t.id);
  const rawU = await getLatestTakeUnderstandings(prisma, ids);
  const understanding = Object.fromEntries(ids.map((id) => [id, parseTakeUnderstanding(rawU[id])]));
  const subjectTracks: PlacementOptions["subjectTracks"] = {};
  const sourceDimensions: NonNullable<PlacementOptions["sourceDimensions"]> = {};
  const wordsByAsset: Record<string, TranscriptWord[] | null> = {};
  const mattes: Record<string, boolean> = {};
  for (const t of takes) {
    subjectTracks[t.id] = parseSubjectTrackRecord(t.subjectTrack);
    sourceDimensions[t.id] = t.width && t.height ? { width: t.width, height: t.height } : null;
    wordsByAsset[t.id] = parseTranscriptWords(t.transcriptWords);
    mattes[t.id] = !!t.matteStorageKey;
  }
  return {
    itemId,
    title: item.title,
    state: item.currentState,
    planId: plan.id,
    timeline,
    understanding,
    wordsByAsset,
    placement: { subjectTracks, sourceDimensions, wordsByAsset, mattes, measure: nodeMeasureText },
    record: readDirectorRecord(plan.plan),
    brief: await creativeBriefTextFor(prisma, itemId),
  };
}

// ---------------------------------------------------------------------------------------
// The conversation as the panel shows it
// ---------------------------------------------------------------------------------------

export interface DirectorMessageView {
  id: string;
  role: "CHRIS" | "EDITOR" | "SYSTEM";
  kind: string;
  text: string;
  at: string;
  provider: string | null;
  reply?: string | null;
  changes?: DirectorChange[];
  notes?: string[];
  errors?: string[];
  repairMessage?: string | null;
  repaired?: string[];
  costUsd?: number | null;
  resultEditPlanId?: string | null;
  /** APPLIED and not undone yet. */
  undoable?: boolean;
}

export async function directorMessagesView(prisma: PrismaClient, itemId: string): Promise<DirectorMessageView[]> {
  const rows = await listDirectorMessages(prisma, itemId);
  const undone = new Set(rows.filter((r) => r.kind === "UNDONE").map((r) => r.replyToId));
  const answers = new Map(rows.filter((r) => r.kind === "ANSWER").map((r) => [r.id, r]));
  return rows
    .filter((r) => r.kind !== "ANSWER")
    .map((r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      const ans = r.kind === "APPLIED" && r.replyToId ? answers.get(r.replyToId) : null;
      const ansPayload = (ans?.payload ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        role: r.role as DirectorMessageView["role"],
        kind: r.kind,
        text: r.text,
        at: r.createdAt.toISOString(),
        provider: r.provider,
        reply: r.kind === "APPLIED" ? ((ansPayload.answer as DirectorAnswer | undefined)?.reply ?? null) : null,
        changes: Array.isArray(p.changes) ? (p.changes as DirectorChange[]) : undefined,
        notes: Array.isArray(p.notes) ? (p.notes as string[]) : undefined,
        errors: Array.isArray(p.errors) ? (p.errors as string[]) : undefined,
        repairMessage: typeof p.repairMessage === "string" ? p.repairMessage : null,
        repaired: Array.isArray(ansPayload.repaired) ? (ansPayload.repaired as string[]) : undefined,
        costUsd: ans?.costUsd ?? r.costUsd ?? null,
        resultEditPlanId: r.resultEditPlanId,
        undoable: r.kind === "APPLIED" && !undone.has(r.id) && !!r.baseEditPlanId,
      };
    });
}

export interface DirectorTakeView {
  id: string;
  sprite: { url: string; cols: number; rows: number; cellW: number; cellH: number; stepS: number; count: number } | null;
  understood: boolean;
}

export interface DirectorStateView {
  messages: DirectorMessageView[];
  takes: DirectorTakeView[];
  missing: string[];
  ai: { available: boolean; reason: string | null; estimateUsd: number; model: string };
  pendingMessage: { id: string; text: string } | null;
}

export function aiEnv() {
  let capUsd: number;
  try {
    capUsd = resolveDailyCapUsd();
  } catch {
    capUsd = 0;
  }
  return { apiKeySet: !!process.env.ANTHROPIC_API_KEY, capUsd, killSwitchOff: process.env.DIRECTOR_AI === "off" };
}

export async function directorState(prisma: PrismaClient, itemId: string): Promise<DirectorStateView> {
  const ctx = await loadDirectorContext(prisma, itemId);
  const messages = await directorMessagesView(prisma, itemId);
  const takes: DirectorTakeView[] = Object.entries(ctx.understanding).map(([id, u]) => ({
    id,
    understood: !!u,
    sprite: u?.sprite?.key ? { url: `/api/director/sprite/${u.sprite.key}`, cols: u.sprite.cols, rows: u.sprite.rows, cellW: u.sprite.cellW, cellH: u.sprite.cellH, stepS: u.sprite.stepS, count: u.sprite.count } : null,
  }));
  await recheckAiCreditIfStale().catch(() => null);
  const ai = await getDirectorAiAvailability(prisma, aiEnv(), new Date(), ANTHROPIC_CREDIT_ERROR_RE);
  const pack = buildPackFor(ctx, "(your message)", messages);
  const est = estimateDirectorCostUsd(pack.chars, true);
  // The newest Chris message that hasn't been answered yet (paste box stays open for it).
  const rows = await listDirectorMessages(prisma, itemId);
  const answered = new Set(rows.filter((r) => r.kind === "APPLIED" || r.kind === "ANSWER").map((r) => r.replyToId));
  const lastChris = [...rows].reverse().find((r) => r.kind === "MESSAGE");
  return {
    messages,
    takes,
    missing: await takesMissingUnderstanding(prisma, itemId),
    ai: { available: ai.available, reason: ai.reason, estimateUsd: est.usd, model: est.model },
    pendingMessage: lastChris && !answered.has(lastChris.id) ? { id: lastChris.id, text: lastChris.text } : null,
  };
}

// ---------------------------------------------------------------------------------------
// Pack
// ---------------------------------------------------------------------------------------

function historyFrom(messages: DirectorMessageView[], excludeId?: string): DirectorTurn[] {
  const out: DirectorTurn[] = [];
  for (const m of messages) {
    if (m.id === excludeId) continue;
    if (m.kind === "MESSAGE") out.push({ role: "CHRIS", text: m.text });
    else if (m.kind === "APPLIED") out.push({ role: "EDITOR", text: `${m.reply ? `${m.reply} — ` : ""}${m.text}` });
    else if (m.kind === "UNDONE") out.push({ role: "EDITOR", text: m.text });
  }
  return out;
}

async function lastAppliedAnswer(prisma: PrismaClient, itemId: string): Promise<DirectorAnswer | null> {
  const rows = await listDirectorMessages(prisma, itemId);
  const undone = new Set(rows.filter((r) => r.kind === "UNDONE").map((r) => r.replyToId));
  const applied = [...rows].reverse().find((r) => r.kind === "APPLIED" && !undone.has(r.id));
  if (!applied?.replyToId) return null;
  const ans = rows.find((r) => r.id === applied.replyToId);
  const parsed = DirectorAnswerSchema.safeParse((ans?.payload as { answer?: unknown } | null)?.answer);
  return parsed.success ? parsed.data : null;
}

function buildPackFor(ctx: DirectorContext, message: string, messages: DirectorMessageView[], lastApplied: DirectorAnswer | null = null, excludeId?: string) {
  const sheet = sheetFor(ctx);
  return buildDirectorPack({
    chrisMessage: message,
    history: historyFrom(messages, excludeId),
    lastApplied,
    timeline: ctx.timeline,
    understanding: ctx.understanding,
    wordsByAsset: ctx.wordsByAsset,
    placement: ctx.placement,
    record: ctx.record,
    title: ctx.title,
    sheet,
    brief: ctx.brief,
  });
}

function sheetFor(ctx: DirectorContext): ContactSheetPlan | null {
  const plan = contactSheetPlan(ctx.timeline, ctx.understanding);
  return plan.cells.length ? plan : null;
}

export interface PreparedTurn {
  messageId: string;
  pack: string;
  chars: number;
  sheet: ContactSheetPlan | null;
  imageNote: string | null;
  estimateUsd: number;
}

/** Chris sends a message: it is stored (append-only) and the pack is built for it. */
export async function prepareDirectorTurn(
  prisma: PrismaClient,
  input: { itemId: string; message: string; clientKey: string; actorId: string },
): Promise<PreparedTurn> {
  const text = input.message.trim().slice(0, 4000);
  if (!text) throw new Error("Type what you want first.");
  const ctx = await loadDirectorContext(prisma, input.itemId);
  const msg = await appendDirectorMessage(prisma, {
    contentItemId: input.itemId,
    role: "CHRIS",
    kind: "MESSAGE",
    text,
    baseEditPlanId: ctx.planId,
    idempotencyKey: `director-msg:${input.itemId}:${input.clientKey}`.slice(0, 190),
    createdBy: input.actorId,
  });
  return packForMessage(prisma, ctx, msg.id, msg.text);
}

/** The pack for an existing Chris message (re-copy / re-share). */
export async function packForMessage(prisma: PrismaClient, ctx: DirectorContext, messageId: string, text: string): Promise<PreparedTurn> {
  const messages = await directorMessagesView(prisma, ctx.itemId);
  const pack = buildPackFor(ctx, text, messages, await lastAppliedAnswer(prisma, ctx.itemId), messageId);
  return {
    messageId,
    pack: pack.prompt,
    chars: pack.chars,
    sheet: sheetFor(ctx),
    imageNote: pack.imageNote,
    estimateUsd: estimateDirectorCostUsd(pack.chars, true).usd,
  };
}

// ---------------------------------------------------------------------------------------
// Answer → apply → new version
// ---------------------------------------------------------------------------------------

export type DirectorApplyOutcome =
  | {
      ok: true;
      timeline: EditTimeline;
      state: string;
      reply: string;
      changes: DirectorChange[];
      notes: string[];
      repaired: string[];
      appliedMessageId: string;
      editPlanId: string | null;
      alreadyApplied: boolean;
      noop: boolean;
    }
  | { ok: false; errors: string[]; repairMessage: string };

/**
 * A pasted (or AI-returned) answer for Chris's message `replyToId`: parse → validate → apply to
 * the latest saved edit → save as a new version. Anything that doesn't fit changes nothing and
 * returns the errors + the fix-up message (both logged as a REJECTED turn).
 */
export async function submitDirectorAnswer(
  prisma: PrismaClient,
  input: { itemId: string; replyToId: string; text: string; provider: DirectorProvider; actorId: string; costUsd?: number | null },
): Promise<DirectorApplyOutcome> {
  const chris = await prisma.directorMessage.findUnique({ where: { id: input.replyToId } });
  if (!chris || chris.contentItemId !== input.itemId || chris.kind !== "MESSAGE") return { ok: false, errors: ["Send your message first."], repairMessage: "" };
  const sha = createHash("sha256").update(input.text.trim()).digest("hex").slice(0, 32);
  const parsed = parseDirectorAnswer(input.text);
  if (!parsed.ok) {
    await appendDirectorMessage(prisma, {
      contentItemId: input.itemId,
      role: "SYSTEM",
      kind: "REJECTED",
      provider: input.provider,
      text: "The answer didn't fit — nothing was changed.",
      payload: { errors: parsed.errors, repairMessage: parsed.repairMessage, excerpt: input.text.slice(0, 2000) },
      replyToId: chris.id,
      costUsd: input.costUsd ?? null,
      createdBy: input.actorId,
    });
    return parsed;
  }
  // The same answer pasted twice (double tap, retry) is applied once: return what it made.
  const prior = await prisma.directorMessage.findUnique({ where: { idempotencyKey: `director-answer:${chris.id}:${sha}` } });
  if (prior) {
    const done = await prisma.directorMessage.findFirst({ where: { kind: "APPLIED", replyToId: prior.id } });
    if (done?.resultEditPlanId) {
      const plan = await prisma.editPlan.findUniqueOrThrow({ where: { id: done.resultEditPlanId } });
      const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: input.itemId }, select: { currentState: true } });
      const p = (done.payload ?? {}) as { changes?: DirectorChange[]; notes?: string[] };
      return { ok: true, timeline: (plan.plan as { timeline: EditTimeline }).timeline, state: item.currentState, reply: parsed.answer.reply, changes: p.changes ?? [], notes: p.notes ?? [], repaired: parsed.repaired, appliedMessageId: done.id, editPlanId: done.resultEditPlanId, alreadyApplied: true, noop: false };
    }
  }
  const ctx = await loadDirectorContext(prisma, input.itemId);
  const answerMsg = await appendDirectorMessage(prisma, {
    contentItemId: input.itemId,
    role: "EDITOR",
    kind: "ANSWER",
    provider: input.provider,
    text: parsed.answer.reply,
    payload: { answer: parsed.answer, repaired: parsed.repaired, sha256: sha, raw: input.text.slice(0, 20_000) },
    baseEditPlanId: ctx.planId,
    replyToId: chris.id,
    costUsd: input.costUsd ?? null,
    idempotencyKey: `director-answer:${chris.id}:${sha}`,
    createdBy: input.actorId,
  });
  const res = applyDirectorAnswer(ctx.timeline, parsed.answer, {
    placement: ctx.placement,
    measure: nodeMeasureText,
    understanding: ctx.understanding,
    record: ctx.record,
    messageId: answerMsg.id,
    chrisText: chris.text,
  });
  if (!res.ok) {
    await appendDirectorMessage(prisma, {
      contentItemId: input.itemId,
      role: "SYSTEM",
      kind: "REJECTED",
      provider: input.provider,
      text: "The instructions point at something that isn't in this video — nothing was changed.",
      payload: { errors: res.errors, repairMessage: res.repairMessage },
      replyToId: chris.id,
      createdBy: input.actorId,
    });
    return res;
  }
  const saved = await saveDirectorEdit(prisma, {
    contentItemId: input.itemId,
    timeline: res.timeline,
    durationSeconds: timelineDuration(res.timeline),
    actorId: input.actorId,
    record: res.record,
    baseTimeline: ctx.timeline,
    changes: res.changes,
    notes: res.notes,
    answerMessageId: answerMsg.id,
    provider: input.provider,
    idempotencyKey: `director-apply:${answerMsg.id}`,
  });
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: input.itemId }, select: { currentState: true } });
  return {
    ok: true,
    timeline: res.timeline,
    state: item.currentState,
    reply: parsed.answer.reply,
    changes: res.changes,
    notes: res.notes,
    repaired: parsed.repaired,
    appliedMessageId: saved.message.id,
    editPlanId: saved.editPlanId,
    alreadyApplied: saved.alreadyApplied,
    noop: res.noop,
  };
}

/** Paid path: same pack + image straight to Claude (only when AI credit is available). */
export async function askDirectorAi(
  prisma: PrismaClient,
  provider: ModelProvider,
  input: { itemId: string; messageId: string; imageBase64: string | null; actorId: string },
): Promise<DirectorApplyOutcome & { costUsd?: number | null }> {
  await recheckAiCreditIfStale().catch(() => null);
  const avail = await getDirectorAiAvailability(prisma, aiEnv(), new Date(), ANTHROPIC_CREDIT_ERROR_RE);
  if (!avail.available) return { ok: false, errors: [avail.reason ?? "Needs AI credit."], repairMessage: "" };
  const chris = await prisma.directorMessage.findUnique({ where: { id: input.messageId } });
  if (!chris || chris.contentItemId !== input.itemId || chris.kind !== "MESSAGE") return { ok: false, errors: ["Send your message first."], repairMessage: "" };
  const ctx = await loadDirectorContext(prisma, input.itemId);
  const prepared = await packForMessage(prisma, ctx, chris.id, chris.text);
  const since = new Date();
  let r;
  try {
    r = await runDirectorAgent(provider, { pack: prepared.pack, image: input.imageBase64 ? { base64: input.imageBase64, mediaType: "image/jpeg" } : null, contentItemId: input.itemId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const plain = /credit|billing|quota/i.test(msg)
      ? "The AI account is out of credit — nothing was changed. Use the free ChatGPT way, or add credit (More → AI credit)."
      : /spend|cap/i.test(msg)
        ? "Today's AI spending limit is reached — nothing was changed. Use the free ChatGPT way."
        : `The AI couldn't answer (${msg.slice(0, 160)}) — nothing was changed. Try again or use the free ChatGPT way.`;
    return { ok: false, errors: [plain], repairMessage: "" };
  }
  const log = await prisma.modelCallLog.findFirst({ where: { contentItemId: input.itemId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, select: { costUsd: true } });
  const out = await submitDirectorAnswer(prisma, { itemId: input.itemId, replyToId: chris.id, text: r.raw, provider: "AI", actorId: input.actorId, costUsd: log?.costUsd ?? null });
  return { ...out, costUsd: log?.costUsd ?? null };
}

export async function undoDirectorChange(prisma: PrismaClient, input: { itemId: string; appliedMessageId: string; actorId: string; force?: boolean }) {
  const r = await undoDirectorEdit(prisma, { contentItemId: input.itemId, appliedMessageId: input.appliedMessageId, actorId: input.actorId, force: input.force });
  if (!r.ok) return r;
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: input.itemId }, select: { currentState: true } });
  return { ok: true as const, timeline: r.timeline as EditTimeline, state: item.currentState, editPlanId: r.editPlanId };
}
