import {
  prisma,
  findOrCreateReferenceCreator,
  registerReferenceVideo,
  referenceVideoKeyPrefix,
  requeueReferenceVideos,
  countPendingReferenceVideos,
  getActiveHeavyJob,
} from "@chris/domain";
import { REFERENCE_LIBRARY_SUBJECT } from "@chris/worker/heavy-job-kinds";
import { runHeavyJob } from "./heavy-jobs";
import { safeFilename } from "./storage";

/**
 * SERVER-ONLY. Reference-video uploads reuse the take-upload plumbing (local streaming route /
 * browser-direct private Blob) under their own key prefix `reference/<creatorId>/…`, so they can
 * never be mistaken for a take or picked up by the render path. See
 * docs/decisions-pending/reference-videos.md.
 */

export function referenceStorageKey(referenceCreatorId: string, filename: string, now = Date.now()): string {
  return `${referenceVideoKeyPrefix(referenceCreatorId)}${now}-${safeFilename(filename)}`;
}


export async function prepareReferenceCreator(input: { referenceCreatorId?: string | null; name?: string | null }, actorId: string) {
  return findOrCreateReferenceCreator(prisma, input, { actorId });
}

export async function registerReferenceUpload(input: {
  referenceCreatorId: string;
  storageKey: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  sourceUrl?: string | null;
  actorId: string;
}) {
  const { actorId, ...rest } = input;
  return registerReferenceVideo(prisma, rest, { actorId });
}

/**
 * Starts (or follows) the measuring job for every video waiting. Locally it runs in this
 * process in the background; on Vercel in the cloud worker. Returns the JobRun to poll, or
 * null when nothing is waiting.
 */
export async function startReferenceMeasuring(
  actorId: string,
  options: { retryFailed?: boolean; ids?: string[]; updateOutdated?: boolean } = {},
): Promise<{ jobRunId: string | null; message: string }> {
  if (options.retryFailed || options.ids) await requeueReferenceVideos(prisma, { ids: options.ids }, { actorId });
  // Re-measure videos measured with an older (less accurate) version; old numbers stay until replaced.
  if (options.updateOutdated) await requeueReferenceVideos(prisma, { outdated: true }, { actorId });
  const active = await getActiveHeavyJob(prisma, REFERENCE_LIBRARY_SUBJECT);
  if (active) return { jobRunId: active.id, message: "Already measuring — following along." };
  const waiting = await countPendingReferenceVideos(prisma);
  if (waiting === 0) return { jobRunId: null, message: "Nothing waiting to be measured." };
  const r = await runHeavyJob("reference-analyze", {}, { actorId, background: true });
  if (r.status === "refused") return { jobRunId: null, message: r.message };
  return { jobRunId: r.jobRunId, message: `Measuring ${waiting} video${waiting === 1 ? "" : "s"}…` };
}
