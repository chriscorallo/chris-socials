/**
 * Segmented recording (TikTok-style record → pause → record) — pure helpers for the prompter's
 * "Record here" (docs/decisions-pending/segmented-recording-drafts.md). Each segment is its own
 * MediaRecorder file, uploaded in the background as soon as it's recorded (retries below), and
 * registered on the server as a part of the video's recording draft.
 */
import { isPermanentUploadError, RETRY_DELAYS_MS, UPLOAD_ATTEMPTS } from "./handoff";
import type { PrompterDraft } from "./data";

export type SegmentStatus = "queued" | "uploading" | "uploaded" | "failed";

export interface LocalSegment {
  /** Client key (idempotent registration on the server). */
  key: string;
  /** Order in the recording (continues after the draft's existing parts). */
  index: number;
  seconds: number;
  /** Teleprompter progress (0..1) when this part started / stopped. */
  scriptStart: number;
  scriptEnd: number;
  /** The recorded file — kept only until it's uploaded (then dropped to free memory). */
  file: File | null;
  /** Object URL of `file` (revoked when the file is dropped). */
  localUrl: string | null;
  /** Server URL once uploaded (or for parts recorded in an earlier visit). */
  remoteUrl: string | null;
  status: SegmentStatus;
  percent: number;
  attempt: number;
  error: string | null;
}

export function newSegmentKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `seg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Parts already saved on the server (a resumed draft), as local segments. */
export function segmentsFromDraft(draft: Pick<PrompterDraft, "segments"> | null | undefined): LocalSegment[] {
  return (draft?.segments ?? []).map((s) => ({
    key: s.key,
    index: s.index,
    seconds: s.seconds,
    scriptStart: s.scriptStart ?? 0,
    scriptEnd: s.scriptEnd ?? 0,
    file: null,
    localUrl: null,
    remoteUrl: s.url,
    status: "uploaded",
    percent: 100,
    attempt: 0,
    error: null,
  }));
}

export function nextSegmentIndex(segs: Pick<LocalSegment, "index">[]): number {
  return segs.reduce((m, s) => Math.max(m, s.index + 1), 0);
}

export function totalSeconds(segs: Pick<LocalSegment, "seconds">[]): number {
  return segs.reduce((a, s) => a + Math.max(0, s.seconds), 0);
}

/**
 * The TikTok-style progress bar: each part's width as a fraction of the bar, plus the part
 * being recorded right now. The bar's scale is at least `minScaleS` (so the first seconds don't
 * fill it) and grows with the recording.
 */
export function segmentBar(
  segs: Pick<LocalSegment, "key" | "seconds" | "status">[],
  recordingS: number | null,
  minScaleS = 60,
): { parts: Array<{ key: string; frac: number; status: SegmentStatus }>; currentFrac: number; scaleS: number } {
  const total = totalSeconds(segs) + Math.max(0, recordingS ?? 0);
  const scaleS = Math.max(minScaleS, total * 1.15);
  return {
    parts: segs.map((s) => ({ key: s.key, frac: Math.max(0, s.seconds) / scaleS, status: s.status })),
    currentFrac: Math.max(0, recordingS ?? 0) / scaleS,
    scaleS,
  };
}

/** Upload status line for the record screen ("Saving part 3 · 45%", "All 3 parts saved"). */
export function uploadSummary(segs: Pick<LocalSegment, "index" | "status" | "percent">[]): { pending: number; failed: number; label: string | null; tone: "ok" | "busy" | "bad" } {
  const ordinal = new Map([...segs].sort((a, b) => a.index - b.index).map((s, i) => [s.index, i + 1]));
  const failed = segs.filter((s) => s.status === "failed");
  const busy = segs.filter((s) => s.status === "uploading" || s.status === "queued");
  if (failed.length) return { pending: busy.length, failed: failed.length, label: `Part ${ordinal.get(failed[0]!.index)} didn't save — tap to retry`, tone: "bad" };
  const up = segs.find((s) => s.status === "uploading");
  if (up) return { pending: busy.length, failed: 0, label: `Saving part ${ordinal.get(up.index)} · ${Math.min(99, up.percent)}%`, tone: "busy" };
  if (busy.length) return { pending: busy.length, failed: 0, label: "Saving…", tone: "busy" };
  if (segs.length === 0) return { pending: 0, failed: 0, label: null, tone: "ok" };
  return { pending: 0, failed: 0, label: segs.length === 1 ? "Part 1 saved" : `All ${segs.length} parts saved`, tone: "ok" };
}

/** Teleprompter: move back `lines` lines from `progress` (1 line = fontPx × 1.3). */
export function rewindProgress(progress: number, lines: number, linePx: number, contentHeight: number): number {
  if (contentHeight <= 0) return Math.max(0, progress);
  return Math.min(1, Math.max(0, progress - (lines * linePx) / contentHeight));
}

/** Where the script resumes for a saved draft: its saved position — unless the script text
 * changed since (then from the top; the old position would point at different words). */
export function resumeProgress(
  draft: Pick<PrompterDraft, "scriptPosition" | "scriptFingerprint"> | null | undefined,
  fingerprint: string,
): number {
  if (!draft) return 0;
  if (draft.scriptFingerprint && draft.scriptFingerprint !== fingerprint) return 0;
  return Math.min(1, Math.max(0, draft.scriptPosition || 0));
}

/** Whether the countdown runs before a part: only before the first part of this visit. */
export function wantsCountdown(countdownSetting: boolean, partsThisVisit: number): boolean {
  return countdownSetting && partsThisVisit === 0;
}

export interface SegmentUploadDeps {
  upload: (seg: LocalSegment, onProgress: (pct: number) => void) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
}

/**
 * Uploads one segment with the take uploader's retry policy (3 attempts, 2 s / 6 s back-off,
 * permanent errors not retried). Registration is idempotent by the segment key, so retrying
 * after a lost response never creates a second take. `onUpdate` gets each state change.
 */
export async function uploadSegmentWithRetry(
  deps: SegmentUploadDeps,
  seg: LocalSegment,
  onUpdate: (patch: Partial<LocalSegment>) => void,
): Promise<"uploaded" | "failed"> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError = "Upload failed";
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    onUpdate({ status: "uploading", attempt, percent: 0, error: null });
    try {
      await deps.upload(seg, (pct) => onUpdate({ percent: pct }));
      onUpdate({ status: "uploaded", percent: 100, error: null });
      return "uploaded";
    } catch (err) {
      lastError = err instanceof Error && err.message ? err.message : "Upload failed";
      if (isPermanentUploadError(lastError) || attempt === UPLOAD_ATTEMPTS) break;
      await wait(RETRY_DELAYS_MS[attempt - 1] ?? 6_000);
    }
  }
  onUpdate({ status: "failed", error: lastError });
  return "failed";
}

/** File name for a part: "part-03-2026-10-17-1432.mp4". */
export function segmentFileName(index: number, mime: string, at: Date): string {
  const ext = /mp4/.test(mime) ? "mp4" : /webm/.test(mime) ? "webm" : /quicktime|mov/.test(mime) ? "mov" : "mp4";
  const p = (n: number) => String(n).padStart(2, "0");
  return `part-${p(index + 1)}-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.${ext}`;
}
