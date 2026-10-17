"use client";

import { useState } from "react";
import { useEditor } from "./context";
import { styleCutAction } from "./actions";
import { Icon } from "./icons";

/**
 * "Style cut": the no-AI edit paced like Chris's reference creators (pauses out, cuts on their
 * rhythm, punch-ins on his face). Shows what the current cut did and offers the two choices —
 * re-apply it, or go back to the plain full take. Each choice is saved as a new version, so
 * Undo brings the previous edit back. See docs/decisions-pending/style-cut.md.
 */
export function StyleCutPanel() {
  const { itemId, dirty, loadSavedVersion, toast, styleCut, setStyleCut, doc } = useEditor();
  const [busy, setBusy] = useState<null | "STYLE" | "PLAIN">(null);
  const [error, setError] = useState<string | null>(null);
  const hasCaptions = styleCut.hasWords;
  const hasExtras = doc.texts.length + doc.visuals.length + doc.zooms.length + doc.sfx.length > 0;

  const run = async (mode: "STYLE" | "PLAIN") => {
    if (busy) return;
    if ((dirty || hasExtras) && !window.confirm(
      `${dirty ? "Your unsaved changes will be replaced. " : ""}${hasExtras ? "Text and graphics are timed to the current cut, so they'll be removed. " : ""}You can undo this.`,
    )) return;
    setBusy(mode);
    setError(null);
    try {
      const res = await styleCutAction({ contentItemId: itemId, mode });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      loadSavedVersion(res.timeline, res.state);
      setStyleCut({ ...styleCut, active: mode === "STYLE", summary: res.summary ?? styleCut.summary, profileNote: res.profileNote ?? styleCut.profileNote });
      toast(mode === "STYLE" ? "Style cut applied — saved as a new version." : "Back to your full take — saved as a new version.");
    } catch {
      setError("Couldn't reach the server. Your edit is unchanged — try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ed-section">
      <div className="ed-ai-card">
        <div className="flex items-start gap-3">
          <span className="ed-ai-icon">
            <Icon name="sparkle" size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold leading-tight">Style cut</p>
            {!hasCaptions ? (
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                Style cut needs captions first — they appear once your words are transcribed. Reopen the editor in a minute.
              </p>
            ) : styleCut.active && styleCut.summary ? (
              <>
                <p className="mt-1 text-[13px] leading-relaxed">Edited to your references&apos; pace: {styleCut.summary.charAt(0).toLowerCase() + styleCut.summary.slice(1)}.</p>
                {styleCut.profileNote && <p className="mt-1 text-[12px] text-[var(--color-text-faint)]">{styleCut.profileNote}</p>}
              </>
            ) : (
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                Takes out your pauses and cuts on the rhythm of the creators you follow, with punch-ins on your face. No AI, free.
              </p>
            )}
          </div>
        </div>
        {hasCaptions && (
          <div className="mt-3 flex flex-col gap-2">
            <button type="button" className="btn btn-primary ed-ai-btn" onClick={() => void run("STYLE")} disabled={!!busy}>
              {busy === "STYLE" ? (
                <>
                  <span className="ed-spinner" aria-hidden /> Cutting…
                </>
              ) : (
                <>
                  <Icon name="sparkle" size={16} /> {styleCut.active ? "Redo the style cut" : "Apply style cut"}
                </>
              )}
            </button>
            {styleCut.active && (
              <button type="button" className="btn btn-ghost" onClick={() => void run("PLAIN")} disabled={!!busy}>
                {busy === "PLAIN" ? "Restoring…" : "Use my full take instead"}
              </button>
            )}
          </div>
        )}
        {error && <p className="mt-2 text-[12.5px] text-[var(--color-danger,#f87171)]">{error}</p>}
      </div>
    </div>
  );
}
