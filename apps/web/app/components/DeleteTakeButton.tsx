"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteTakeNow } from "../content/[id]/flow-actions";

export type DeleteTakeResult = { outcome: "KEPT_EDIT" | "REBUILT" | "NEEDS_FOOTAGE"; state: string };

/** Plain confirm text for deleting one clip (never the video). */
export function deleteTakeConfirmText(name: string, opts: { inEdit: boolean; lastTake: boolean }): string {
  if (opts.lastTake) return `Delete the clip “${name}”?\n\nIt's your only clip, so the video goes back to needing footage — upload or film it again. The video stays in your plan.`;
  if (opts.inEdit) return `Delete the clip “${name}”?\n\nIt's in your edit, so the edit is rebuilt from your other footage. The video stays in your plan.`;
  return `Delete the clip “${name}”?\n\nThe file is deleted. Your edit isn't affected.`;
}

/**
 * "Delete this clip" — removes ONE take's footage (docs/decisions-pending/replace-footage.md),
 * never the video. On the video page it refreshes; the editor passes `onDone` to reload itself.
 */
export function DeleteTakeButton({
  contentItemId,
  mediaAssetId,
  name,
  inEdit,
  lastTake,
  inUnsavedEdit = false,
  variant = "page",
  onDone,
}: {
  contentItemId: string;
  mediaAssetId: string;
  name: string;
  inEdit: boolean;
  lastTake: boolean;
  inUnsavedEdit?: boolean;
  variant?: "page" | "editor";
  onDone?: (r: DeleteTakeResult) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!window.confirm(deleteTakeConfirmText(name, { inEdit: inEdit || inUnsavedEdit, lastTake }))) return;
    setBusy(true);
    setError(null);
    const r = await deleteTakeNow(contentItemId, mediaAssetId, inUnsavedEdit);
    if ("error" in r) {
      setError(r.error);
      setBusy(false);
      return;
    }
    if (onDone) onDone({ outcome: r.outcome, state: r.state });
    else {
      router.refresh();
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        aria-label={`Delete the clip ${name}`}
        data-testid="delete-take"
        className={
          variant === "editor"
            ? "ed-take-delete"
            : "inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl px-3 text-[13.5px] font-medium text-[var(--color-rose-400)] active:bg-white/10 disabled:opacity-60"
        }
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
        </svg>
        {busy ? "Deleting…" : variant === "editor" ? "Delete" : "Delete clip"}
      </button>
      {error && <span className="mt-1 max-w-[16rem] text-right text-[12px] text-[var(--color-rose-400)]">{error}</span>}
    </span>
  );
}
