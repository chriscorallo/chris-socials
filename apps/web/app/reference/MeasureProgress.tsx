"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useJobProgress } from "../../lib/use-job-progress";
import { measureReferenceVideos } from "./actions";

/** Live "Measuring video 3 of 12…" line for the reference-analysis job; refreshes the page when done. */
export function MeasureProgress({ jobRunId }: { jobRunId: string }) {
  const router = useRouter();
  const { view, error } = useJobProgress(jobRunId);
  const finished = view && view.status !== "RUNNING";
  useEffect(() => {
    if (finished) router.refresh();
  }, [finished, router]);
  if (error) return <p className="text-[13.5px] text-[var(--color-text-muted)]">Lost track of the measuring ({error}). It keeps going — pull to refresh in a minute.</p>;
  const pct = view?.pct ?? 0;
  return (
    <div className="flex flex-col gap-1.5" data-testid="measure-progress">
      <p className={`text-[14px] ${view?.status === "FAILED" ? "text-[var(--color-rose-400)]" : "text-[var(--color-text-muted)]"}`}>
        {!view ? "Starting to measure…" : view.status === "RUNNING" ? (view.queued ? "Waiting for a free cloud worker…" : (view.line ?? "Measuring…")) : view.status === "FAILED" ? (view.error ?? "Measuring failed.") : (view.message ?? "Done.")}
      </p>
      {view?.status === "RUNNING" && (
        <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-[var(--color-gold-400)] transition-[width]" style={{ width: `${Math.max(4, pct)}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * The measuring control on /reference and a creator page: follows a running job, or offers to
 * measure what's waiting / retry what failed. Renders nothing when there's nothing to do.
 */
export function MeasureControl({ activeJobRunId, pending, failed }: { activeJobRunId: string | null; pending: number; failed: number }) {
  const [jobRunId, setJobRunId] = useState<string | null>(activeJobRunId);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function start(retryFailed: boolean) {
    setBusy(true);
    setNote(null);
    const r = await measureReferenceVideos({ retryFailed });
    if ("error" in r) setNote(r.error);
    else if (r.jobRunId) setJobRunId(r.jobRunId);
    else setNote(r.message);
    setBusy(false);
  }
  if (jobRunId) {
    return (
      <section className="panel p-4">
        <MeasureProgress jobRunId={jobRunId} />
      </section>
    );
  }
  if (pending === 0 && failed === 0 && !note) return null;
  return (
    <section className="panel flex flex-col gap-2.5 p-4">
      {pending > 0 && <p className="text-[14.5px]">{pending} video{pending === 1 ? " is" : "s are"} waiting to be measured.</p>}
      {failed > 0 && <p className="text-[14px] text-[var(--color-text-muted)]">{failed} couldn&apos;t be measured.</p>}
      <div className="flex flex-wrap gap-2">
        {pending > 0 && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start(false)} data-testid="measure-start">
            {busy ? "Starting…" : "Measure now"}
          </button>
        )}
        {failed > 0 && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void start(true)}>
            Try again
          </button>
        )}
      </div>
      {note && <p className="text-[13.5px] text-[var(--color-text-muted)]">{note}</p>}
    </section>
  );
}
