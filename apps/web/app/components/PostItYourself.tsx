"use client";

import { useState } from "react";

/**
 * "Post it yourself" — for when the apps aren't connected (or Chris wants to post by hand):
 * save the finished video to Photos in one tap (iPhone share sheet → Save Video; elsewhere a
 * plain download), then copy each app's exact text — the same caption / title / description
 * the app would have sent (hashtags included, each app's limits applied).
 */
export interface PostText {
  platform: "INSTAGRAM" | "TIKTOK" | "YOUTUBE";
  /** IG/TikTok: the caption field. YouTube: the description. */
  caption: string;
  /** YouTube only. */
  title: string | null;
}

const APP: Record<PostText["platform"], { label: string; open: string; captionLabel: string }> = {
  INSTAGRAM: { label: "Instagram Reels", open: "https://www.instagram.com/", captionLabel: "caption" },
  TIKTOK: { label: "TikTok", open: "https://www.tiktok.com/upload", captionLabel: "caption" },
  YOUTUBE: { label: "YouTube Shorts", open: "https://studio.youtube.com/", captionLabel: "description" },
};

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function PostItYourself({ videoUrl, fileName, texts }: { videoUrl: string; fileName: string; texts: PostText[] }) {
  const [saving, setSaving] = useState<null | number>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /** The video, fetched and ready: Safari only opens the share sheet straight from a tap, so
   * the first tap fetches and the second shares (no waiting inside the gesture). */
  const [ready, setReady] = useState<File | null>(null);

  async function saveVideo() {
    setNote(null);
    const downloadUrl = `${videoUrl}${videoUrl.includes("?") ? "&" : "?"}download=1`;
    // iPhone: the share sheet's "Save Video" puts it straight into Photos. Needs the file in hand.
    const canShareFiles = typeof navigator !== "undefined" && "canShare" in navigator && navigator.canShare?.({ files: [new File([new Blob()], "x.mp4", { type: "video/mp4" })] });
    if (!canShareFiles) {
      window.location.href = downloadUrl;
      return;
    }
    try {
      setSaving(0);
      const res = await fetch(videoUrl);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length")) || 0;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (total) setSaving(Math.round((got / total) * 100));
      }
      const file = new File(chunks as BlobPart[], fileName, { type: "video/mp4" });
      setSaving(null);
      setReady(file);
    } catch (err) {
      setSaving(null);
      if (err instanceof DOMException && err.name === "AbortError") return; // closed the share sheet
      setNote("Couldn't open the share sheet — downloading the file instead.");
      window.location.href = downloadUrl;
    }
  }

  async function shareReady() {
    if (!ready) return;
    try {
      await navigator.share({ files: [ready] });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setNote("Couldn't open the share sheet — downloading the file instead.");
      window.location.href = `${videoUrl}${videoUrl.includes("?") ? "&" : "?"}download=1`;
    }
  }

  async function copyText(key: string, text: string) {
    if (await copy(text)) {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
    }
  }

  return (
    <div data-testid="post-it-yourself">
      {ready ? (
        <button type="button" className="btn btn-primary w-full !min-h-[52px] !text-[16px]" onClick={() => void shareReady()} data-testid="share-video">
          Ready — tap to Save Video
        </button>
      ) : (
        <button type="button" className="btn btn-primary w-full !min-h-[52px] !text-[16px]" onClick={() => void saveVideo()} disabled={saving !== null} data-testid="save-video">
          {saving !== null ? `Getting the video… ${saving > 0 ? `${saving}%` : ""}` : "Save video to Photos"}
        </button>
      )}
      <p className="mt-2 text-[12.5px] leading-snug text-[var(--color-text-faint)]">
        On iPhone, tap <b>Save Video</b> in the share sheet. One file works for all three apps (1080×1920, each app&apos;s limits respected).
      </p>
      {note && <p className="mt-2 text-[12.5px] text-[var(--color-gold-400)]">{note}</p>}

      <div className="mt-4 flex flex-col gap-3">
        {(["INSTAGRAM", "TIKTOK", "YOUTUBE"] as const).map((p) => {
          const t = texts.find((x) => x.platform === p);
          const app = APP[p];
          return (
            <div key={p} className="rounded-2xl border border-[var(--color-border)] p-3" data-testid={`post-${p}`}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[14px] font-semibold">{app.label}</p>
                <a href={app.open} target="_blank" rel="noopener noreferrer" className="text-[12.5px] underline decoration-dotted underline-offset-2">
                  Open {p === "YOUTUBE" ? "YouTube" : app.label.split(" ")[0]} ↗
                </a>
              </div>
              {!t ? (
                <p className="mt-1 text-[12.5px] leading-snug text-[var(--color-text-muted)]">No text yet — tap Finish in the editor and the AI writes it (you can edit it after).</p>
              ) : (
                <div className="mt-2 flex flex-col gap-2">
                  {t.title && (
                    <button type="button" className="btn btn-ghost w-full !justify-start !text-left !min-h-[44px]" onClick={() => void copyText(`${p}-title`, t.title!)}>
                      <span className="min-w-0 flex-1 truncate text-[13px]">{copied === `${p}-title` ? "Copied ✓" : `Copy title — ${t.title}`}</span>
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost w-full !justify-start !text-left !min-h-[44px]" onClick={() => void copyText(`${p}-caption`, t.caption)} data-testid={`copy-${p}`}>
                    <span className="min-w-0 flex-1 truncate text-[13px]">{copied === `${p}-caption` ? "Copied ✓" : `Copy ${app.captionLabel} — ${t.caption.split("\n")[0]}`}</span>
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
