"use client";

import { useState } from "react";

/** The whole-video confirm — worded so it can't be mistaken for deleting just the footage
 * ("Replace footage" / "Delete clip" do that; docs/decisions-pending/replace-footage.md). */
export function deleteVideoConfirmText(title: string): string {
  return `Delete this video from your plan?\n\n“${title}” disappears from your videos, plan and calendar, along with its footage and renders. This can't be undone.\n\n(Only want new footage? Cancel, and use “Replace footage” on the video instead.)`;
}

/**
 * "Delete this video idea" with a plain confirm. Removes the video from Videos/Home/Plan/Calendar and
 * deletes its footage and renders (history is kept). Works for planned, imported and filmed videos.
 */
export function DeleteVideoButton({
  contentItemId,
  title,
  action,
  back = "/content",
  compact = false,
}: {
  contentItemId: string;
  title: string;
  action: (formData: FormData) => Promise<void>;
  back?: string;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(deleteVideoConfirmText(title))) {
          e.preventDefault();
          return;
        }
        setBusy(true);
      }}
    >
      <input type="hidden" name="contentItemId" value={contentItemId} />
      <input type="hidden" name="back" value={back} />
      {compact ? (
        <button type="submit" disabled={busy} aria-label={`Delete “${title}” from your plan`} title="Delete this video from your plan" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--color-rose-400)] active:bg-white/10" data-testid="delete-video">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
          </svg>
        </button>
      ) : (
        <button type="submit" disabled={busy} className="btn btn-ghost w-full !min-h-[48px] !text-[15px] text-[var(--color-rose-400)]" data-testid="delete-video">
          {busy ? "Deleting…" : "Delete this video idea"}
        </button>
      )}
    </form>
  );
}
