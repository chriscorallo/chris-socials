"use client";

import { useEffect, useRef, useState } from "react";
import { uploadRawTake } from "../../../lib/upload-client";
import { deliverTakes, type HandoffProgress, type HandoffTarget } from "../../../lib/teleprompter/handoff";
import { preparePlannedUpload } from "../../plan/actions";
import { createFootageItem } from "../../upload/actions";
import { useOpenEditor, FinishingCard } from "../../upload/OpenEditor";

export type HandoffState =
  | { phase: "idle" }
  | { phase: "sending"; progress: HandoffProgress }
  | { phase: "failed"; error: string; contentItemId: string | null; failed: File[] }
  | { phase: "finishing" };

/**
 * Sends takes into the video with the existing plumbing (walk to FILMED / footage-first create
 * → uploadRawTake with retries), then the single-upload ending (captions → editor).
 */
export function useTakeHandoff(target: HandoffTarget, mode: "blob" | "local") {
  const [state, setState] = useState<HandoffState>({ phase: "idle" });
  const { finishing, openEditor, skip } = useOpenEditor();
  const busy = state.phase === "sending" || state.phase === "finishing";
  const idRef = useRef<string | null>(null);

  // Leaving mid-upload would kill the transfer — ask first.
  useEffect(() => {
    if (!busy) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [busy]);

  async function send(files: File[]): Promise<boolean> {
    const res = await deliverTakes(
      {
        prepareExisting: preparePlannedUpload,
        createNew: createFootageItem,
        upload: (id, file, onProgress) => uploadRawTake(id, file, mode, onProgress),
      },
      target,
      files,
      (progress) => setState({ phase: "sending", progress }),
      idRef.current,
    );
    if (res.contentItemId) idRef.current = res.contentItemId;
    if (!res.ok) {
      // Everything that DID land stays; only the failed takes are offered again.
      setState({ phase: "failed", error: res.error, contentItemId: res.contentItemId, failed: res.failedIndexes.map((i) => files[i]!) });
      return false;
    }
    setState({ phase: "finishing" });
    await openEditor(res.contentItemId);
    return true;
  }

  return { state, send, busy, finishing, skip };
}

export function HandoffStatus({ state, finishing, onSkip, onRetry, saveHref, saveName }: {
  state: HandoffState;
  finishing: ReturnType<typeof useOpenEditor>["finishing"];
  onSkip: () => void;
  onRetry: () => void;
  saveHref?: string | null;
  saveName?: string;
}) {
  if (state.phase === "sending") {
    const p = state.progress;
    const label =
      p.phase === "preparing" ? "Getting the video ready…" : p.phase === "processing" ? "Checking the video…" : p.phase === "retrying" ? `Connection dropped — trying again (${p.attempt}/3)…` : `Uploading${p.total > 1 ? ` take ${p.index + 1} of ${p.total}` : ""}… ${p.percent}%`;
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-black/60 p-4" aria-live="polite" data-testid="handoff-progress">
        <p className="text-[15px] font-semibold text-white">{label}</p>
        <div className="h-1.5 overflow-hidden rounded-full bg-white/15">
          <div className="h-full rounded-full bg-[var(--color-gold-400)] transition-[width]" style={{ width: `${p.phase === "preparing" ? 3 : p.percent}%` }} />
        </div>
        <p className="text-[12.5px] text-white/60">Keep this screen open until it finishes.</p>
      </div>
    );
  }
  if (state.phase === "failed") {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-[var(--color-rose-500)]/50 bg-black/70 p-4" aria-live="polite">
        <p className="text-[15px] font-semibold text-white">The upload didn&apos;t finish</p>
        <p className="text-[13px] text-white/70">{state.error}. Your take is still here — nothing is lost.</p>
        <button type="button" className="btn btn-primary w-full" onClick={onRetry}>
          Try again
        </button>
        {saveHref && (
          <a href={saveHref} download={saveName} className="btn btn-ghost w-full">
            Save a copy to this phone
          </a>
        )}
      </div>
    );
  }
  if (finishing) return <FinishingCard finishing={finishing} onSkip={onSkip} />;
  return null;
}
