"use server";

import { prisma, saveFinishingEdit, scheduleContentItemForPublishing, type ContentState } from "@chris/domain";
import { EditTimelineSchema } from "@chris/media/timeline";
import { renderContentItem } from "@chris/worker";
import { runQualityGateForContentItem } from "@chris/worker/quality-gate-job";
import { requireSession } from "../../../../lib/session";
import { storage } from "../../../../lib/storage";
import { getModelProvider } from "../../../../lib/model-provider";
import { getRenderFontPath } from "../../../../lib/render-config";

/**
 * Server Actions for the finishing editor. "Finish & schedule" is deliberately FOUR actions
 * the client calls in sequence (save → render → quality check → schedule) rather than one:
 * each is its own request, so the modal shows real progress per step, and a failure at any
 * step leaves everything before it done (the edit stays saved; a failed gate never schedules).
 * Every action returns a plain result instead of throwing, worded for Chris.
 */

export type StepResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; state?: ContentState };

async function stateOf(contentItemId: string): Promise<ContentState> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId }, select: { currentState: true } });
  return item.currentState;
}

/** Turns internal/agent errors into a sentence a non-technical owner can act on. */
function plainError(err: unknown, step: string): string {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "SpendCapExceededError") {
    return "Today's AI spending limit has been reached, so the AI quality check couldn't run. Your edit is saved — try again tomorrow, or raise MODEL_SPEND_DAILY_CAP_USD.";
  }
  if (/api[_ ]?key|authentication|x-api-key|ANTHROPIC/i.test(msg)) {
    return "The quality check needs the AI service, which isn't set up (no Anthropic API key). Your edit is saved and rendered — add the key in Settings/env and press Finish again.";
  }
  if (/credit balance|billing|insufficient/i.test(msg)) {
    return "The AI account is out of credit, so the quality check couldn't run. Your edit is saved — add credit in the Anthropic console and press Finish again.";
  }
  return `${step} failed: ${msg}`;
}

export async function saveFinishingEditAction(input: {
  contentItemId: string;
  timeline: unknown;
  note?: string;
}): Promise<StepResult<{ editPlanId: string; state: ContentState; savedAt: string }>> {
  const session = await requireSession();
  const parsed = EditTimelineSchema.safeParse(input.timeline);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `The edit couldn't be saved — ${first ? `${first.path.join(".")}: ${first.message}` : "invalid timeline"}.` };
  }
  const duration = parsed.data.clips.reduce((s, c) => s + Math.max(0, c.sourceEnd - c.sourceStart), 0);
  const cover = parsed.data.coverFrameSeconds;
  const timeline = { ...parsed.data, coverFrameSeconds: cover == null ? null : Math.min(Math.max(0, cover), duration) };
  try {
    const plan = await saveFinishingEdit(prisma, {
      contentItemId: input.contentItemId,
      timeline,
      durationSeconds: duration,
      actorId: session.user!.id!,
      note: input.note,
    });
    return { ok: true, editPlanId: plan.id, state: await stateOf(input.contentItemId), savedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: plainError(err, "Saving"), state: await stateOf(input.contentItemId).catch(() => undefined) };
  }
}

export async function renderStepAction(contentItemId: string): Promise<StepResult<{ state: ContentState; renderKey: string | null }>> {
  const session = await requireSession();
  try {
    const result = await renderContentItem(prisma, storage, contentItemId, { fontPath: getRenderFontPath() }, { actorId: session.user!.id! });
    const state = await stateOf(contentItemId);
    if (result.status !== "SUCCESS") {
      return { ok: false, error: `The render didn't pass its technical check: ${(result.errorMessage ?? "see the item page for details").replace(/\.+$/, "")}. Your edit is saved.`, state };
    }
    return { ok: true, state, renderKey: result.outputStorageKey ?? null };
  } catch (err) {
    return { ok: false, error: plainError(err, "Rendering"), state: await stateOf(contentItemId).catch(() => undefined) };
  }
}

export async function qualityGateStepAction(
  contentItemId: string,
): Promise<StepResult<{ state: ContentState; passed: boolean; reasons: string[] }>> {
  const session = await requireSession();
  try {
    const result = await runQualityGateForContentItem(prisma, storage, getModelProvider(), contentItemId, { actorId: session.user!.id! });
    const state = await stateOf(contentItemId);
    return { ok: true, state, passed: state === "READY" || result.overallStatus === "PASS", reasons: result.reasons };
  } catch (err) {
    return { ok: false, error: plainError(err, "The quality check"), state: await stateOf(contentItemId).catch(() => undefined) };
  }
}

const PLATFORMS = new Set(["INSTAGRAM", "TIKTOK", "YOUTUBE"]);

export async function scheduleStepAction(input: {
  contentItemId: string;
  /** `datetime-local` value; interpreted in the server's (= app's) time zone. */
  scheduledDate: string;
  platforms: string[];
}): Promise<StepResult<{ state: ContentState; scheduledFor: string }>> {
  const session = await requireSession();
  const platforms = input.platforms.filter((p) => PLATFORMS.has(p)) as Array<"INSTAGRAM" | "TIKTOK" | "YOUTUBE">;
  if (platforms.length === 0) return { ok: false, error: "Pick at least one platform." };
  const when = new Date(input.scheduledDate);
  if (Number.isNaN(when.getTime())) return { ok: false, error: "Pick a date and time." };
  try {
    await scheduleContentItemForPublishing(
      prisma,
      { contentItemId: input.contentItemId, scheduledDate: when, targetPlatforms: platforms },
      { actorId: session.user!.id! },
    );
    return {
      ok: true,
      state: await stateOf(input.contentItemId),
      scheduledFor: when.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    };
  } catch (err) {
    return { ok: false, error: plainError(err, "Scheduling"), state: await stateOf(input.contentItemId).catch(() => undefined) };
  }
}
