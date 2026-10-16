"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { registerBlobUpload } from "./actions";

type UploadState = { name: string; percent: number; status: "uploading" | "processing" | "done" | "error"; error?: string };

function safeName(name: string): string {
  const base = name.replace(/^.*[\\/]/, "").replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
  return (base || "upload").slice(-120);
}

/** Local mode: stream the raw file body to PUT /api/upload (XHR for upload progress). */
function uploadLocal(contentItemId: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const params = new URLSearchParams({ contentItemId, filename: file.name });
    xhr.open("PUT", `/api/upload?${params}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `Upload failed (${xhr.status})`;
      try {
        message = JSON.parse(xhr.responseText).error ?? message;
      } catch {
        // non-JSON error body — keep the status-code message
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

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
        if (mode === "local") {
          await uploadLocal(contentItemId, file, (percent) =>
            patch(index, { percent, status: percent >= 100 ? "processing" : "uploading" }),
          );
        } else {
          const storageKey = `raw/${contentItemId}/${Date.now()}-${safeName(file.name)}`;
          await upload(storageKey, file, {
            access: "private",
            handleUploadUrl: "/api/blob-upload",
            contentType: file.type || undefined,
            multipart: file.size > 50 * 1024 * 1024,
            onUploadProgress: ({ percentage }) => patch(index, { percent: Math.round(percentage) }),
          });
          patch(index, { percent: 100, status: "processing" });
          const result = await registerBlobUpload({
            contentItemId,
            storageKey,
            originalFilename: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
          });
          if ("error" in result) throw new Error(result.error);
        }
        patch(index, { percent: 100, status: "done" });
      } catch (err) {
        patch(index, { status: "error", error: err instanceof Error ? err.message : "Upload failed" });
      }
    }
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept="video/*,audio/*"
          multiple
          disabled={busy}
          onChange={(e) => void handleFiles(e.target.files)}
          className="text-[13px] text-[var(--color-text-muted)] file:mr-3 file:rounded-full file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-[13px] file:text-[var(--color-text)]"
        />
        <span className="text-[12px] text-[var(--color-text-faint)]">Raw takes — any size, several at once.</span>
      </label>
      {uploads.length > 0 && (
        <ul className="flex flex-col gap-2 text-[13px]">
          {uploads.map((u, i) => (
            <li key={`${u.name}-${i}`} className="flex flex-col gap-1">
              <div className="flex justify-between gap-3">
                <span className="truncate">{u.name}</span>
                <span className={u.status === "error" ? "text-[var(--color-rose-400)]" : "text-[var(--color-text-faint)]"}>
                  {u.status === "uploading" && `${u.percent}%`}
                  {u.status === "processing" && "Analyzing…"}
                  {u.status === "done" && "Done"}
                  {u.status === "error" && (u.error ?? "Failed")}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-[var(--color-gold-400)] transition-[width]"
                  style={{ width: `${u.status === "error" ? 100 : u.percent}%`, opacity: u.status === "error" ? 0.3 : 1 }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
