"use server";

import { after } from "next/server";
import {
  prisma,
  Prisma,
  createContentItemFromFootage,
  deleteRecordingSegment,
  discardRecordingSession,
  finishRecordingSession,
  openRecordingSession,
  saveRecordingDraftPosition,
} from "@chris/domain";
import { requireSession } from "../../../lib/session";
import { storage } from "../../../lib/storage";
import { heavyJobMode, isAutoPersonMatteEnabled, isAutoSubjectTrackingEnabled, isAutoTranscriptionEnabled } from "../../../lib/render-config";
import { runHeavyJob } from "../../../lib/heavy-jobs";
import { loadPrompterDraft, type PrompterDraft } from "../../../lib/teleprompter/data";
import type { HandoffTarget } from "../../../lib/teleprompter/handoff";

/**
 * Recording drafts for the teleprompter's segmented "Record here"
 * (docs/decisions-pending/segmented-recording-drafts.md). The segments themselves are uploaded
 * with the normal take uploader (uploadRawTake + segment fields); these actions open, save,
 * finish and discard the draft. Every write is idempotent and audited in packages/domain.
 */

type Fail = { error: string };
const fail = (err: unknown, fallback: string): Fail => ({ error: err instanceof Error && err.message ? err.message : fallback });

/** Opens (or resumes) the video's draft when the first part is recorded. A brand-new video is
 * created footage-first; a planned one is walked to FILMED (honest SYSTEM steps). */
export async function startRecordingDraft(
  target: HandoffTarget,
  scriptFingerprint: string | null,
): Promise<{ contentItemId: string; recordingSessionId: string; resumed: boolean } | Fail> {
  const session = await requireSession();
  const actor = { actorId: session.user!.id! };
  try {
    const contentItemId =
      target.kind === "existing" ? target.contentItemId : (await createContentItemFromFootage(prisma, { title: target.title }, actor)).id;
    const r = await openRecordingSession(prisma, { contentItemId, scriptFingerprint }, actor);
    return { contentItemId, recordingSessionId: r.session.id, resumed: !r.created };
  } catch (err) {
    return fail(err, "Couldn't start the recording");
  }
}

export async function getRecordingDraft(contentItemId: string): Promise<PrompterDraft | null> {
  await requireSession();
  return loadPrompterDraft(prisma, contentItemId);
}

/** "Save as draft" (also called after every part): where the script is. */
export async function saveRecordingDraft(
  contentItemId: string,
  recordingSessionId: string,
  scriptPosition: number,
  scriptFingerprint: string | null,
): Promise<{ ok: true } | Fail> {
  await requireSession();
  try {
    await saveRecordingDraftPosition(prisma, { contentItemId, recordingSessionId, scriptPosition, scriptFingerprint });
    return { ok: true };
  } catch (err) {
    return fail(err, "Couldn't save the draft");
  }
}

async function deleteMedia(keys: string[]) {
  for (const key of keys) await storage.delete(key).catch((err) => console.warn("[recording] media delete failed", key, err instanceof Error ? err.message : err));
}

/** "Delete last part": removes that part (and its uploaded file). */
export async function deleteDraftSegment(contentItemId: string, recordingSessionId: string, segmentKey: string): Promise<{ ok: true; deleted: boolean } | Fail> {
  const session = await requireSession();
  try {
    const r = await deleteRecordingSegment(prisma, { contentItemId, recordingSessionId, clientKey: segmentKey }, { actorId: session.user!.id! });
    await deleteMedia(r.storageKeys);
    return { ok: true, deleted: r.deleted };
  } catch (err) {
    return fail(err, "Couldn't delete that part");
  }
}

/** "Finish": the parts become the video; the caller then opens the editor (captions → starter
 * edit of all parts in order → style cut). */
export async function finishRecordingDraft(contentItemId: string, recordingSessionId: string, scriptPosition: number | null): Promise<{ ok: true } | Fail> {
  const session = await requireSession();
  try {
    await finishRecordingSession(prisma, { contentItemId, recordingSessionId, scriptPosition }, { actorId: session.user!.id! });
    // Live site: parts are transcribed by the cloud worker's upload job. If a part's job was
    // refused (one job per video at a time), make sure one runs now for whatever is missing.
    if (heavyJobMode() === "sandbox" && isAutoTranscriptionEnabled()) {
      const missing = await prisma.mediaAsset.count({ where: { contentItemId, kind: "RAW_TAKE", transcriptWords: { equals: Prisma.DbNull }, hasAudio: { not: false } } });
      if (missing > 0) {
        after(async () => {
          await runHeavyJob(
            "ingest",
            { contentItemId, transcribe: true, track: isAutoSubjectTrackingEnabled(), matte: isAutoPersonMatteEnabled() },
            { actorId: session.user!.id! },
          ).catch((err) => console.warn("[recording] ingest job not started:", err instanceof Error ? err.message : err));
        });
      }
    }
    return { ok: true };
  } catch (err) {
    return fail(err, "Couldn't finish the recording");
  }
}

/** "Discard draft": every part is removed; the history stays. */
export async function discardRecordingDraft(contentItemId: string, recordingSessionId: string): Promise<{ ok: true } | Fail> {
  const session = await requireSession();
  try {
    const r = await discardRecordingSession(prisma, { contentItemId, recordingSessionId }, { actorId: session.user!.id! });
    await deleteMedia(r.storageKeys);
    return { ok: true };
  } catch (err) {
    return fail(err, "Couldn't discard the draft");
  }
}
