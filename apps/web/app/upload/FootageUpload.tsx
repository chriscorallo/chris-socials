"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadRawTake } from "../../lib/upload-client";
import { createFootageItem } from "./actions";

type Row = { name: string; percent: number; status: "waiting" | "uploading" | "processing" | "done" | "error"; error?: string };

/**
 * The one obvious place to upload: pick videos from Photos/Files, the app creates the video
 * entry (footage-first) and uploads every take into it, then opens it. Optional title; a
 * filename-based one is used otherwise.
 */
export function FootageUpload({ mode }: { mode: "blob" | "local" }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const busy = rows.some((r) => r.status === "uploading" || r.status === "processing" || r.status === "waiting");

  async function handle(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    const list = Array.from(files);
    setRows(list.map((f) => ({ name: f.name, percent: 0, status: "waiting" })));
    const fallback = list[0]!.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
    const created = await createFootageItem(title.trim() || fallback || "New video");
    if ("error" in created) {
      setError(created.error);
      setRows([]);
      return;
    }
    let ok = 0;
    for (const [i, file] of list.entries()) {
      const patch = (next: Partial<Row>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...next } : r)));
      try {
        patch({ status: "uploading" });
        await uploadRawTake(created.id, file, mode, (percent, phase) => patch({ percent, status: phase }));
        patch({ percent: 100, status: "done" });
        ok++;
      } catch (err) {
        patch({ status: "error", error: err instanceof Error ? err.message : "Upload failed" });
      }
    }
    if (ok > 0) router.push(`/content/${created.id}`);
    else router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="block">
        <span className="field-label">What's this video about? (optional)</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
          placeholder="e.g. Why your 401(k) match is free money"
          className="field-input"
        />
      </label>
      <label
        className={`flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed px-4 py-6 text-center ${
          busy ? "cursor-not-allowed border-[var(--color-border)] opacity-60" : "border-[var(--color-gold-500)]/60 bg-[var(--color-gold-500)]/[0.08] active:bg-[var(--color-gold-500)]/15"
        }`}
      >
        <input ref={inputRef} type="file" accept="video/*" multiple disabled={busy} onChange={(e) => void handle(e.target.files)} className="sr-only" />
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--color-gold-400)]" aria-hidden>
          <path d="M12 16V4M7 9l5-5 5 5" />
          <path d="M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15" />
        </svg>
        <span className="text-[17px] font-semibold">{busy ? "Uploading…" : "Choose videos"}</span>
        <span className="text-[13px] text-[var(--color-text-faint)]">
          {busy ? "Keep this screen open until it finishes." : "From Photos, Files or the camera. Several takes of the same video at once is fine."}
        </span>
      </label>
      {error && <p className="text-sm text-[var(--color-rose-400)]">{error}</p>}
      {rows.length > 0 && (
        <ul className="flex flex-col gap-2.5 text-[13px]" aria-live="polite">
          {rows.map((r, i) => (
            <li key={`${r.name}-${i}`} className="flex flex-col gap-1.5">
              <div className="flex min-w-0 justify-between gap-3">
                <span className="min-w-0 truncate">{r.name}</span>
                <span className="shrink-0 tabular-nums text-[var(--color-text-faint)]">
                  {r.status === "waiting" && "Waiting…"}
                  {r.status === "uploading" && `${r.percent}%`}
                  {r.status === "processing" && "Analyzing…"}
                  {r.status === "done" && "Done"}
                  {r.status === "error" && <span className="text-[var(--color-rose-400)]">{r.error ?? "Failed"}</span>}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-[var(--color-gold-400)] transition-[width]" style={{ width: `${r.status === "error" ? 100 : r.percent}%`, opacity: r.status === "error" ? 0.3 : 1 }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
