"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useJobProgress } from "../../../lib/use-job-progress";
import { HEAVY_JOB_TITLE } from "../../../lib/heavy-job-text";

/**
 * Live progress of the heavy job running for this video (render, transcription, …) — a small
 * floating card, so it never changes the page's layout. Follows `?job=<id>` (set by the action
 * that started it) or, without one, the job the server found running for this item. When the
 * job finishes the page refreshes itself; the card says how it went for a few seconds.
 * Hidden inside the editor (the Finish modal shows its own steps).
 */
export function HeavyJobBanner({ activeJobRunId }: { activeJobRunId: string | null }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const jobRunId = params.get("job") || activeJobRunId;
  const { view, error } = useJobProgress(jobRunId);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const refreshed = useRef<string | null>(null);

  useEffect(() => {
    if (view && view.status !== "RUNNING" && refreshed.current !== view.id) {
      refreshed.current = view.id;
      router.refresh();
      if (view.status === "SUCCEEDED") {
        const t = setTimeout(() => setDismissed(view.id), 6_000);
        return () => clearTimeout(t);
      }
    }
  }, [view, router]);

  // The viewer check shows its own progress inside its card.
  if (!jobRunId || pathname?.endsWith("/edit") || dismissed === jobRunId || view?.kind === "viewer-review") return null;
  if (!view && !error) return null;

  const title = HEAVY_JOB_TITLE[view?.kind ?? ""] ?? "Working on your video";
  const running = view?.status === "RUNNING";
  const failed = view?.status === "FAILED";
  const pct = Math.max(2, Math.min(100, Math.round(view?.pct ?? 0)));

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-3"
      style={{ top: "calc(env(safe-area-inset-top, 0px) + 64px)" }}
      role="status"
      aria-live="polite"
    >
      <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-ink)_92%,transparent)] px-4 py-3 shadow-xl backdrop-blur-xl">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium leading-snug">
              {error ? "Couldn't check progress" : running ? (view?.line ?? `${title}…`) : failed ? `${title} — didn't finish` : `${title} — done`}
            </p>
            {(failed || error) && <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-rose-400)]">{view?.error ?? error}</p>}
            {running && (
              <p className="mt-0.5 text-[11.5px] text-[var(--color-text-faint)]">Running in the cloud — you can leave this page; it keeps going.</p>
            )}
          </div>
          {!running && (
            <button type="button" className="text-[12px] text-[var(--color-text-muted)] underline" onClick={() => setDismissed(jobRunId)}>
              Close
            </button>
          )}
        </div>
        {running && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-border)]" aria-hidden>
            <div className="h-full rounded-full bg-[var(--color-gold-500)] transition-[width] duration-700" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}
