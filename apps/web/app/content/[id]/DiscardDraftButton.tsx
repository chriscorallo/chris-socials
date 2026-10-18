"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { discardRecordingDraft } from "../../film/teleprompter/actions";

/** "Discard draft" for an unfinished teleprompter recording — asks first; the parts' media is
 * deleted, the history stays (docs/decisions-pending/segmented-recording-drafts.md). */
export function DiscardDraftButton({ contentItemId, recordingSessionId, parts }: { contentItemId: string; recordingSessionId: string; parts: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function onClick() {
    if (!window.confirm(`Discard this draft? ${parts === 1 ? "The part you filmed" : `All ${parts} parts you filmed`} will be deleted.`)) return;
    setBusy(true);
    setError(null);
    const r = await discardRecordingDraft(contentItemId, recordingSessionId);
    setBusy(false);
    if ("error" in r) setError(r.error);
    else router.refresh();
  }
  return (
    <div className="flex flex-1 flex-col gap-1">
      <button type="button" onClick={() => void onClick()} disabled={busy} className="btn btn-ghost w-full !min-h-[46px]" data-testid="discard-draft">
        {busy ? "Discarding…" : "Discard draft"}
      </button>
      {error && <p className="text-[12.5px] text-[var(--color-rose-400)]">{error}</p>}
    </div>
  );
}
