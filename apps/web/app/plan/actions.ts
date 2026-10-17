"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  prisma,
  commitPlanImport,
  undoPlanImport,
  advancePlannedItemToFilmed,
  createContentItemFromFootage,
  createStarterEdit,
  getActivePostingPlan,
  ymdInTz,
  type CommitPlanImportInput,
  type CommitPlanImportResult,
} from "@chris/domain";
import { googleSheetCsvUrl, googleSheetFetchError, enabledPlatformsOf } from "@chris/domain/plan-import";
import { runPlanImporterAgent, type PlanImporterResult } from "@chris/agents";
import { requireSession } from "../../lib/session";
import { getModelProvider } from "../../lib/model-provider";
import { APP_TZ } from "../../lib/calendar-data";

/**
 * Plan import + plan board server actions. Parsing itself runs in the browser (pure
 * @chris/domain/plan-import); the server only fetches Google Sheets (CORS), runs the optional
 * AI cleanup, and persists. See docs/decisions-pending/plan-import.md.
 */

const SHEET_MAX_BYTES = 2 * 1024 * 1024;

/** Google Sheets link → CSV text (server-side: the browser can't fetch it cross-origin). */
export async function fetchGoogleSheet(link: string): Promise<{ csv: string } | { error: string }> {
  await requireSession();
  const url = googleSheetCsvUrl(link);
  if (!url) return { error: "That doesn't look like a Google Sheets link. It should start with https://docs.google.com/spreadsheets/" };
  try {
    // Only ever docs.google.com (validated above) — no arbitrary-URL fetches.
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000), cache: "no-store" });
    const finalHost = new URL(res.url || url).hostname;
    const problem = googleSheetFetchError(res.status, res.headers.get("content-type")) ?? (finalHost.endsWith("google.com") ? null : googleSheetFetchError(403, "text/html"));
    if (problem) return { error: problem };
    const text = await res.text();
    if (text.length > SHEET_MAX_BYTES) return { error: "That sheet is too big to import (over 2 MB). Import one tab or a smaller range." };
    return { csv: text };
  } catch {
    return { error: "Couldn't reach Google Sheets just now. Try again, or download the sheet as CSV/Excel and upload the file." };
  }
}

/** Optional "Clean up with AI" — never required; any failure returns a friendly message. */
export async function cleanUpPlanWithAi(text: string, startDate: string): Promise<{ result: PlanImporterResult } | { error: string }> {
  await requireSession();
  if (!text.trim()) return { error: "Paste your plan first." };
  try {
    const plan = await getActivePostingPlan(prisma);
    const today = ymdInTz(new Date(), APP_TZ);
    const result = await runPlanImporterAgent(getModelProvider(), {
      text,
      today,
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : today,
      enabledPlatforms: enabledPlatformsOf(plan),
    });
    return { result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/api key|ANTHROPIC|credit|spend|cap|401|402|429/i.test(msg)) {
      return { error: "AI cleanup isn't available right now (no AI credit). The regular import above still works — fix any rows by hand." };
    }
    return { error: "AI cleanup didn't work this time. The regular import above still works — fix any rows by hand." };
  }
}

export async function createPlanFromImport(input: CommitPlanImportInput): Promise<CommitPlanImportResult | { error: string }> {
  const session = await requireSession();
  try {
    const plan = await getActivePostingPlan(prisma);
    const res = await commitPlanImport(prisma, input, { actorId: session.user!.id! }, { tz: APP_TZ, plan });
    revalidatePath("/plan");
    revalidatePath("/calendar");
    return res;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't create the plan" };
  }
}

export async function undoImportAction(formData: FormData) {
  const session = await requireSession();
  const importId = String(formData.get("importId") ?? "");
  let message: string;
  try {
    const r = await undoPlanImport(prisma, importId, { actorId: session.user!.id! });
    message = r.alreadyUndone
      ? "That import was already undone."
      : `Removed ${r.cancelled} planned video${r.cancelled === 1 ? "" : "s"}${r.kept ? ` · kept ${r.kept} you already started` : ""}.`;
  } catch (err) {
    message = err instanceof Error ? err.message : "Couldn't undo that import";
  }
  revalidatePath("/calendar");
  redirect(`/plan?notice=${encodeURIComponent(message)}`);
}

/** Before uploading footage into a planned video: walk it to FILMED (honest SYSTEM steps). */
export async function preparePlannedUpload(contentItemId: string): Promise<{ ok: true } | { error: string }> {
  const session = await requireSession();
  try {
    await advancePlannedItemToFilmed(prisma, contentItemId, { actorId: session.user!.id! });
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't prepare the upload" };
  }
}

/** A clip that isn't in the plan: a new footage-first video, titled from the file name. */
export async function createVideoForClip(title: string): Promise<{ id: string } | { error: string }> {
  const session = await requireSession();
  try {
    const item = await createContentItemFromFootage(prisma, { title }, { actorId: session.user!.id! });
    return { id: item.id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't create the video" };
  }
}

/** After footage lands: make the no-AI starter edit so "Edit" opens the editor directly. */
export async function makeStarterEdit(contentItemId: string): Promise<{ ok: true } | { error: string }> {
  const session = await requireSession();
  try {
    await createStarterEdit(prisma, contentItemId, { actorId: session.user!.id! });
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't open the editor" };
  }
}

/** Plan board "Edit video": starter edit if needed, then straight into the editor. */
export async function editPlannedVideo(formData: FormData) {
  const session = await requireSession();
  const id = String(formData.get("contentItemId") ?? "");
  let error: string | null = null;
  try {
    await createStarterEdit(prisma, id, { actorId: session.user!.id! });
  } catch (err) {
    error = err instanceof Error ? err.message : "Couldn't open the editor";
  }
  if (error) redirect(`/content/${id}?pipelineError=${encodeURIComponent(error)}`);
  redirect(`/content/${id}/edit`);
}
