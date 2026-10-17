"use client";

import { upload } from "@vercel/blob/client";
import { registerBlobUpload } from "../app/content/[id]/actions";

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
 * Uploads one raw take into a content item, by deployment storage mode: local disk via the
 * streaming route, or browser-direct to private Vercel Blob in production (Vercel functions
 * can't receive bodies over 4.5 MB) followed by registration. `onProgress(pct, phase)`.
 */
export async function uploadRawTake(
  contentItemId: string,
  file: File,
  mode: "blob" | "local",
  onProgress: (percent: number, phase: "uploading" | "processing") => void,
): Promise<void> {
  if (mode === "local") {
    await uploadLocal(contentItemId, file, (p) => onProgress(p, p >= 100 ? "processing" : "uploading"));
    return;
  }
  const storageKey = `raw/${contentItemId}/${Date.now()}-${safeName(file.name)}`;
  await upload(storageKey, file, {
    access: "private",
    handleUploadUrl: "/api/blob-upload",
    contentType: file.type || undefined,
    multipart: file.size > 50 * 1024 * 1024,
    onUploadProgress: ({ percentage }) => onProgress(Math.round(percentage), "uploading"),
  });
  onProgress(100, "processing");
  const result = await registerBlobUpload({
    contentItemId,
    storageKey,
    originalFilename: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  });
  if ("error" in result) throw new Error(result.error);
}
