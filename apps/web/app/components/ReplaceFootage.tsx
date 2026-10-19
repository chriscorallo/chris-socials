"use client";

import { useEffect, useRef, useState } from "react";
import { uploadRawTake } from "../../lib/upload-client";
import { replaceFootageNow } from "../content/[id]/flow-actions";
import { useOpenEditor, FinishingCard } from "../upload/OpenEditor";

type Phase = { kind: "uploading"; name: string; percent: number; analyzing: boolean } | { kind: "replacing" } | { kind: "error"; message: string } | null;

/** The confirm text (shared with the tests' expectations — keep it plain). */
export function replaceFootageConfirmText(title: string, scheduledFor: string | null): string {
  return (
    `Replace the footage on “${title}”?\n\nYour old clip and its edit are removed; the video stays in your plan.` +
    (scheduledFor ? `\n\nIt stays on ${scheduledFor} in your calendar, but it has to be finished again before it posts.` : "")
  );
}

/**
 * "Replace footage" (docs/decisions-pending/replace-footage.md): pick a new clip → one confirm →
 * upload it into THIS video (same upload plumbing as any take) → the old clips and their edit
 * are removed (title, plan date, schedule slot, script stay) → the normal single-upload ending:
 * wait for captions, build the fresh edit (Full edit or Cuts only per "New uploads get"), open
 * the editor on it. The old footage is only removed once the new clip has landed, so a failed
 * upload never leaves the video with nothing.
 */
export function ReplaceFootage({
  contentItemId,
  title,
  mode,
  scheduledFor = null,
  variant = "page",
  go,
}: {
  contentItemId: string;
  title: string;
  mode: "blob" | "local";
  /** Human date when the video is on the calendar (the confirm says it must be re-finished). */
  scheduledFor?: string | null;
  variant?: "page" | "editor";
  /** Final navigation override (the editor does a full load so it remounts on the new edit). */
  go?: (url: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>(null);
  const { finishing, openEditor, skip } = useOpenEditor();
  const busy = finishing != null || phase?.kind === "uploading" || phase?.kind === "replacing";

  useEffect(() => {
    if (!busy) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [busy]);

  async function handle(files: FileList | null) {
    const file = files?.[0];
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;
    if (!window.confirm(replaceFootageConfirmText(title, scheduledFor))) return;
    setPhase({ kind: "uploading", name: file.name, percent: 0, analyzing: false });
    let id: string | null;
    try {
      id = await uploadRawTake(contentItemId, file, mode, (percent, p) => setPhase({ kind: "uploading", name: file.name, percent, analyzing: p === "processing" }));
    } catch (err) {
      setPhase({ kind: "error", message: `${err instanceof Error ? err.message : "Upload failed"} — your old footage is untouched.` });
      return;
    }
    if (!id) {
      setPhase({ kind: "error", message: "The new clip uploaded, but the app couldn't confirm it — reload the page and try again. Your old footage is untouched." });
      return;
    }
    setPhase({ kind: "replacing" });
    const r = await replaceFootageNow(contentItemId, id);
    if ("error" in r) {
      setPhase({ kind: "error", message: r.error });
      return;
    }
    setPhase(null);
    await openEditor(contentItemId, go);
  }

  const status =
    finishing != null ? (
      <FinishingCard finishing={finishing} onSkip={skip} />
    ) : phase?.kind === "uploading" || phase?.kind === "replacing" ? (
      <div className="flex flex-col gap-2 rounded-2xl border border-[var(--color-gold-500)]/40 bg-[var(--color-gold-500)]/[0.08] p-4" aria-live="polite">
        <p className="text-[15px] font-semibold">
          {phase.kind === "replacing" ? "Swapping in the new footage…" : phase.analyzing ? "Checking the new clip…" : `Uploading the new clip… ${phase.percent}%`}
        </p>
        <p className="text-[13px] text-[var(--color-text-muted)]">Keep this screen open until it finishes.</p>
        {phase.kind === "uploading" && (
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-[var(--color-gold-400)] transition-[width]" style={{ width: `${phase.percent}%` }} />
          </div>
        )}
      </div>
    ) : null;

  const picker = (
    <input ref={inputRef} type="file" accept="video/*" disabled={busy} onChange={(e) => void handle(e.target.files)} className="sr-only" data-testid="replace-footage-input" />
  );

  if (variant === "editor") {
    return (
      <>
        <label className={`ed-replace-footage ${busy ? "opacity-60" : ""}`} data-testid="replace-footage">
          {picker}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 4v6h6M20 20v-6h-6" />
            <path d="M5.5 15a7 7 0 0 0 12.2 2.5M18.5 9A7 7 0 0 0 6.3 6.5" />
          </svg>
          <span>Replace footage</span>
        </label>
        {(status || phase?.kind === "error") && (
          <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 p-4 pb-[max(16px,env(safe-area-inset-bottom))] sm:items-center">
            <div className="w-full max-w-md">
              {status}
              {phase?.kind === "error" && (
                <div className="rounded-2xl border border-[var(--color-rose-500)]/40 bg-[var(--color-surface,#111)] p-4">
                  <p className="text-[14px] text-[var(--color-rose-400)]">{phase.message}</p>
                  <button type="button" className="btn btn-ghost mt-3 w-full" onClick={() => setPhase(null)}>
                    OK
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {!status && (
        <label className={`btn btn-ghost w-full !min-h-[48px] cursor-pointer gap-2 !text-[15px] ${busy ? "opacity-60" : ""}`} data-testid="replace-footage">
          {picker}
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 4v6h6M20 20v-6h-6" />
            <path d="M5.5 15a7 7 0 0 0 12.2 2.5M18.5 9A7 7 0 0 0 6.3 6.5" />
          </svg>
          Replace footage
        </label>
      )}
      {status}
      {phase?.kind === "error" && <p className="text-[13.5px] text-[var(--color-rose-400)]">{phase.message}</p>}
    </div>
  );
}
