/**
 * Prompter take → video handoff (pure orchestration; the real server actions and uploader are
 * injected so this is unit-testable). Same plumbing as the existing uploads:
 *   - an existing video is walked to FILMED first (preparePlannedUpload →
 *     advancePlannedItemToFilmed: honest SYSTEM steps; a no-op if already filmed),
 *   - a brand-new video is created footage-first (createContentItemFromFootage),
 * then every take goes through uploadRawTake (Blob in production, local disk in dev), each
 * retried a few times — a phone on cellular drops connections, and a 300 MB take is too
 * valuable to lose to one blip. Preparation is idempotent, so a full retry is always safe.
 */

export type HandoffTarget = { kind: "existing"; contentItemId: string } | { kind: "new"; title: string };

export interface HandoffDeps {
  prepareExisting: (contentItemId: string) => Promise<{ ok: true } | { error: string }>;
  createNew: (title: string) => Promise<{ id: string } | { error: string }>;
  upload: (contentItemId: string, file: File, onProgress: (pct: number, phase: "uploading" | "processing") => void) => Promise<void>;
  /** Waits between retries (injected so tests don't sleep). */
  wait?: (ms: number) => Promise<void>;
}

export type HandoffProgress = { index: number; total: number; percent: number; phase: "preparing" | "uploading" | "processing" | "retrying"; attempt: number };

export type HandoffResult =
  | { ok: true; contentItemId: string; uploaded: number }
  | { ok: false; contentItemId: string | null; uploaded: number; error: string; failedIndexes: number[] };

export const UPLOAD_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = [2_000, 6_000];

/** Messages that won't fix themselves by retrying (bad file, refused state, too big). */
export function isPermanentUploadError(message: string): boolean {
  return /not allowed|too large|unsupported|refused|can't take footage|cannot take footage|forbidden|unauthori[sz]ed|\b(400|401|403|404|413|415)\b/i.test(message);
}

export async function deliverTakes(
  deps: HandoffDeps,
  target: HandoffTarget,
  files: File[],
  onProgress: (p: HandoffProgress) => void,
  /** Already-resolved video id (a retry after a partial failure skips re-creating it). */
  knownContentItemId?: string | null,
): Promise<HandoffResult> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const total = files.length;
  onProgress({ index: 0, total, percent: 0, phase: "preparing", attempt: 1 });

  let id = knownContentItemId ?? null;
  try {
    if (!id) {
      if (target.kind === "existing") {
        const prep = await deps.prepareExisting(target.contentItemId);
        if ("error" in prep) return { ok: false, contentItemId: null, uploaded: 0, error: prep.error, failedIndexes: files.map((_, i) => i) };
        id = target.contentItemId;
      } else {
        const created = await deps.createNew(target.title);
        if ("error" in created) return { ok: false, contentItemId: null, uploaded: 0, error: created.error, failedIndexes: files.map((_, i) => i) };
        id = created.id;
      }
    }
  } catch (err) {
    return { ok: false, contentItemId: null, uploaded: 0, error: messageOf(err, "Couldn't get the video ready"), failedIndexes: files.map((_, i) => i) };
  }

  let uploaded = 0;
  const failed: number[] = [];
  let lastError = "";
  for (const [index, file] of files.entries()) {
    let done = false;
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS && !done; attempt++) {
      try {
        onProgress({ index, total, percent: 0, phase: attempt > 1 ? "retrying" : "uploading", attempt });
        await deps.upload(id, file, (percent, phase) => onProgress({ index, total, percent, phase, attempt }));
        done = true;
      } catch (err) {
        lastError = messageOf(err, "Upload failed");
        if (isPermanentUploadError(lastError) || attempt === UPLOAD_ATTEMPTS) break;
        await wait(RETRY_DELAYS_MS[attempt - 1] ?? 6_000);
      }
    }
    if (done) uploaded++;
    else failed.push(index);
  }
  if (failed.length) return { ok: false, contentItemId: id, uploaded, error: lastError, failedIndexes: failed };
  return { ok: true, contentItemId: id, uploaded };
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
