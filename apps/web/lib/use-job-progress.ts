"use client";

import { useEffect, useState } from "react";

/** What GET /api/jobs/[id] returns. */
export interface JobProgressView {
  id: string;
  kind: string | null;
  contentItemId: string | null;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  /** Waiting for a free cloud worker (status reads RUNNING). */
  queued?: boolean;
  pct: number;
  stage: string | null;
  message: string | null;
  /** "Rendering your video… 40%" */
  line: string | null;
  result: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export async function fetchJob(jobRunId: string, signal?: AbortSignal): Promise<JobProgressView> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobRunId)}`, { cache: "no-store", signal });
  if (!res.ok) throw new Error(res.status === 404 ? "That job doesn't exist any more." : `Couldn't check progress (HTTP ${res.status}).`);
  return (await res.json()) as JobProgressView;
}

/**
 * Polls a heavy job until it finishes; `onUpdate` sees every poll. Rides out flaky mobile
 * connections (only gives up after ~2 minutes of consecutive failures — the job keeps running
 * in the cloud regardless).
 */
export async function waitForJob(
  jobRunId: string,
  onUpdate: (v: JobProgressView) => void = () => undefined,
  options: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<JobProgressView> {
  const interval = options.intervalMs ?? 2_000;
  let failures = 0;
  for (;;) {
    if (options.signal?.aborted) throw new Error("aborted");
    try {
      const v = await fetchJob(jobRunId, options.signal);
      failures = 0;
      onUpdate(v);
      if (v.status !== "RUNNING") return v;
    } catch (err) {
      if (options.signal?.aborted) throw err;
      if (++failures > Math.ceil(120_000 / interval)) throw err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** React hook: live progress of one job (null id = nothing to follow). */
export function useJobProgress(jobRunId: string | null): { view: JobProgressView | null; error: string | null } {
  const [view, setView] = useState<JobProgressView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!jobRunId) return;
    const ctrl = new AbortController();
    setView(null);
    setError(null);
    waitForJob(jobRunId, (v) => setView(v), { signal: ctrl.signal }).catch((err) => {
      if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    });
    return () => ctrl.abort();
  }, [jobRunId]);
  return { view, error };
}
