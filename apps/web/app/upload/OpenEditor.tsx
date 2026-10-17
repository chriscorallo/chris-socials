"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { captionStatus, startEditingNow } from "../content/[id]/flow-actions";

/** How long the upload screen waits for captions before opening the editor anyway. */
export const CAPTION_WAIT_MS = 90_000;

export type Finishing = { phase: "captions" | "opening"; ready: number; total: number; progress?: string | null };

/**
 * The single-upload ending, shared by the upload screen and the teleprompter: wait for the
 * captions (capped, skippable), make the no-AI starter edit (+ automatic style cut), then open
 * the EDITOR. See docs/decisions-pending/flow.md.
 */
export function useOpenEditor() {
  const router = useRouter();
  const [finishing, setFinishing] = useState<Finishing | null>(null);
  const skipRef = useRef(false);

  async function openEditor(id: string) {
    skipRef.current = false;
    const started = Date.now();
    setFinishing({ phase: "captions", ready: 0, total: 0 });
    while (!skipRef.current && Date.now() - started < CAPTION_WAIT_MS) {
      let st: Awaited<ReturnType<typeof captionStatus>>;
      try {
        st = await captionStatus(id);
      } catch {
        break;
      }
      setFinishing({ phase: "captions", ready: st.ready, total: st.total, progress: st.progress });
      if (!st.waiting) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    setFinishing((f) => ({ phase: "opening", ready: f?.ready ?? 0, total: f?.total ?? 0 }));
    const res = await startEditingNow(id);
    if ("error" in res) {
      router.push(`/content/${id}?pipelineError=${encodeURIComponent(res.error)}`);
      return;
    }
    router.push(`/content/${id}/edit`);
  }

  return { finishing, openEditor, skip: () => (skipRef.current = true) };
}

export function FinishingCard({ finishing, onSkip }: { finishing: Finishing; onSkip: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[var(--color-gold-500)]/40 bg-[var(--color-gold-500)]/[0.08] p-4" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-[var(--color-gold-400)] border-t-transparent" aria-hidden />
        <div className="min-w-0">
          <p className="text-[16px] font-semibold">{finishing.phase === "captions" ? "Getting your captions ready…" : "Opening the editor…"}</p>
          <p className="text-[13px] text-[var(--color-text-muted)]">
            {finishing.phase === "captions"
              ? (finishing.progress ?? "Listening to your video so captions are on when the editor opens. Usually under a minute.")
              : "Your video goes straight into the editor."}
          </p>
        </div>
      </div>
      {finishing.phase === "captions" && (
        <button type="button" onClick={onSkip} className="btn btn-ghost w-full">
          Open the editor now (captions appear later)
        </button>
      )}
    </div>
  );
}
