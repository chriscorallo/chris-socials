"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadRawTake } from "../../lib/upload-client";
import { makeStarterEdit, preparePlannedUpload } from "./actions";

/**
 * "Upload footage" for one planned video, right from the plan board: pick takes → the video
 * is walked to FILMED (advancePlannedItemToFilmed) → takes upload with the shared uploader →
 * the no-AI starter edit is made → "Edit" opens the editor.
 */
export function PlanItemUpload({ contentItemId, mode, label = "Upload footage", compact = false, quiet = false }: { contentItemId: string; mode: "blob" | "local"; label?: string; compact?: boolean; quiet?: boolean }) {
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ phase: "idle" | "prep" | "up" | "done" | "error"; pct: number; i: number; n: number; msg?: string }>({ phase: "idle", pct: 0, i: 0, n: 0 });

  async function go(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files);
    setState({ phase: "prep", pct: 0, i: 0, n: list.length });
    const prep = await preparePlannedUpload(contentItemId);
    if ("error" in prep) return setState({ phase: "error", pct: 0, i: 0, n: list.length, msg: prep.error });
    let ok = 0;
    let lastError = "";
    for (const [i, f] of list.entries()) {
      try {
        setState({ phase: "up", pct: 0, i, n: list.length });
        await uploadRawTake(contentItemId, f, mode, (pct) => setState({ phase: "up", pct, i, n: list.length }));
        ok++;
      } catch (err) {
        lastError = err instanceof Error ? err.message : "Upload failed";
      }
    }
    if (ok === 0) return setState({ phase: "error", pct: 0, i: 0, n: list.length, msg: lastError || "Upload failed" });
    await makeStarterEdit(contentItemId); // best effort — "Edit" still works from the video page
    setState({ phase: "done", pct: 100, i: list.length, n: list.length, msg: ok < list.length ? `${list.length - ok} failed: ${lastError}` : undefined });
    if (ref.current) ref.current.value = "";
    router.refresh();
  }

  if (state.phase === "done") {
    return (
      <div className="flex flex-col items-end gap-1">
        <Link href={`/content/${contentItemId}/edit`} className={`btn btn-primary ${compact ? "!min-h-[38px] !px-3.5 !text-[13.5px]" : ""}`}>
          Edit
        </Link>
        {state.msg && <span className="text-[11.5px] text-[var(--color-rose-400)]">{state.msg}</span>}
      </div>
    );
  }
  const busy = state.phase === "prep" || state.phase === "up";
  return (
    <div className="flex flex-col items-end gap-1">
      <label className={`btn ${busy || quiet ? "btn-ghost" : "btn-primary"} cursor-pointer ${compact ? "!min-h-[38px] !px-3.5 !text-[13.5px]" : ""}`} aria-busy={busy}>
        <input ref={ref} type="file" accept="video/*" multiple className="sr-only" disabled={busy} onChange={(e) => void go(e.target.files)} data-testid={`upload-${contentItemId}`} />
        {state.phase === "prep" ? "Preparing…" : state.phase === "up" ? `${state.n > 1 ? `${state.i + 1}/${state.n} · ` : ""}${state.pct}%` : label}
      </label>
      {state.phase === "error" && <span className="max-w-[180px] text-right text-[11.5px] text-[var(--color-rose-400)]">{state.msg}</span>}
    </div>
  );
}
