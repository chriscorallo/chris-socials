"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadRawTake } from "../../../lib/upload-client";

type UploadState = { name: string; percent: number; status: "uploading" | "processing" | "done" | "error"; error?: string };

/**
 * Raw-take uploader. Picks the transport by deployment storage mode: local disk via a
 * streaming route, or browser-direct to private Vercel Blob in production (Vercel functions
 * can't receive request bodies over 4.5 MB). Multiple takes at once; each one is analyzed
 * (ffprobe) on arrival.
 */
export function RawTakeUploader({ contentItemId, mode }: { contentItemId: string; mode: "blob" | "local" }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const busy = uploads.some((u) => u.status === "uploading" || u.status === "processing");

  function patch(index: number, next: Partial<UploadState>) {
    setUploads((prev) => prev.map((u, i) => (i === index ? { ...u, ...next } : u)));
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    const offset = uploads.length;
    setUploads((prev) => [...prev, ...list.map((f) => ({ name: f.name, percent: 0, status: "uploading" as const }))]);

    for (const [i, file] of list.entries()) {
      const index = offset + i;
      try {
        await uploadRawTake(contentItemId, file, mode, (percent, phase) => patch(index, { percent, status: phase }));
        patch(index, { percent: 100, status: "done" });
      } catch (err) {
        patch(index, { status: "error", error: err instanceof Error ? err.message : "Upload failed" });
      }
    }
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  // While anything is still uploading, leaving the page would kill the transfer — ask first.
  useEffect(() => {
    if (!busy) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [busy]);

  // iOS only offers the Photos library in the picker when every accepted type is image/video,
  // so phones get "video/*" (Photos + camera + Files). Desktop (fine pointer) additionally
  // accepts audio-only takes.
  const [accept, setAccept] = useState("video/*");
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) setAccept("video/*,audio/*");
  }, []);

  const doneCount = uploads.filter((u) => u.status === "done").length;

  return (
    <div className="flex flex-col gap-3">
      <label
        className={`flex min-h-[64px] cursor-pointer items-center justify-center gap-3 rounded-2xl border border-dashed px-4 py-3 text-center transition-colors ${
          busy
            ? "cursor-not-allowed border-[var(--color-border)] opacity-60"
            : "border-[var(--color-gold-500)]/50 bg-[var(--color-gold-500)]/[0.07] active:bg-[var(--color-gold-500)]/15 hover:bg-[var(--color-gold-500)]/10"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple
          disabled={busy}
          onChange={(e) => void handleFiles(e.target.files)}
          className="sr-only"
        />
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--color-gold-400)]" aria-hidden>
          <path d="M12 16V4M7 9l5-5 5 5" />
          <path d="M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15" />
        </svg>
        <span className="min-w-0 text-left">
          <span className="block text-[15px] font-semibold text-[var(--color-text)]">
            {busy ? "Uploading…" : uploads.length > 0 ? "Add more takes" : "Add raw takes"}
          </span>
          <span className="block text-[12.5px] text-[var(--color-text-faint)]">
            {busy ? "Keep this screen open until it finishes." : "From Photos, Files or the camera — any size, several at once."}
          </span>
        </span>
      </label>
      {uploads.length > 0 && (
        <ul className="flex flex-col gap-2.5 text-[13px]" aria-live="polite">
          {uploads.map((u, i) => (
            <li key={`${u.name}-${i}`} className="flex flex-col gap-1.5">
              <div className="flex min-w-0 justify-between gap-3">
                <span className="min-w-0 truncate">{u.name}</span>
                <span className={`shrink-0 tabular-nums ${u.status === "error" ? "text-[var(--color-rose-400)]" : u.status === "done" ? "text-[var(--color-emerald-400)]" : "text-[var(--color-text-faint)]"}`}>
                  {u.status === "uploading" && `${u.percent}%`}
                  {u.status === "processing" && "Analyzing…"}
                  {u.status === "done" && "Done"}
                  {u.status === "error" && (u.error ?? "Failed")}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                  className={`h-full rounded-full transition-[width] ${u.status === "done" ? "bg-[var(--color-emerald-400)]" : "bg-[var(--color-gold-400)]"}`}
                  style={{ width: `${u.status === "error" ? 100 : u.percent}%`, opacity: u.status === "error" ? 0.3 : 1 }}
                />
              </div>
            </li>
          ))}
          {!busy && doneCount > 0 && (
            <li className="text-[var(--color-text-muted)]">
              {doneCount} take{doneCount === 1 ? "" : "s"} uploaded.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
