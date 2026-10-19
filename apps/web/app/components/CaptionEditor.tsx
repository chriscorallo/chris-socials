"use client";

import { useState } from "react";
import { saveCaptionAction, type CaptionPlatform, type CaptionView } from "../content/[id]/caption-actions";

const LABEL: Record<CaptionPlatform, string> = { INSTAGRAM: "Instagram", TIKTOK: "TikTok", YOUTUBE: "YouTube Shorts" };
const ORDER: CaptionPlatform[] = ["INSTAGRAM", "TIKTOK", "YOUTUBE"];

/**
 * The text each app gets when the video posts — Instagram caption, TikTok caption, YouTube
 * title + description — one card per app, editable in place. An app with no text yet (the AI
 * couldn't write it) shows empty fields to type into.
 */
export function CaptionEditor({
  contentItemId,
  platforms,
  initial,
  missing = [],
}: {
  contentItemId: string;
  platforms: CaptionPlatform[];
  initial: CaptionView[];
  missing?: { platform: CaptionPlatform; reason: string }[];
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="caption-editor">
      {ORDER.filter((p) => platforms.includes(p)).map((p) => (
        <CaptionCard
          key={p}
          contentItemId={contentItemId}
          platform={p}
          initial={initial.find((c) => c.platform === p) ?? null}
          missingReason={missing.find((m) => m.platform === p)?.reason ?? null}
        />
      ))}
    </div>
  );
}

function CaptionCard({
  contentItemId,
  platform,
  initial,
  missingReason,
}: {
  contentItemId: string;
  platform: CaptionPlatform;
  initial: CaptionView | null;
  missingReason: string | null;
}) {
  const [saved, setSaved] = useState<CaptionView | null>(initial);
  const [caption, setCaption] = useState(initial?.caption ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [tags, setTags] = useState((initial?.hashtags ?? []).map((h) => `#${h}`).join(" "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const savedTags = (saved?.hashtags ?? []).map((h) => `#${h}`).join(" ");
  const dirty = caption !== (saved?.caption ?? "") || (platform === "YOUTUBE" && title !== (saved?.title ?? "")) || tags !== savedTags;
  const yt = platform === "YOUTUBE";

  async function save() {
    setBusy(true);
    setError(null);
    const res = await saveCaptionAction({ contentItemId, platform, caption, title: yt ? title : null, hashtags: tags }).catch(() => null);
    setBusy(false);
    if (!res) return setError("Couldn't reach the server. Try again.");
    if (!res.ok) return setError(res.error);
    setSaved(res.caption);
    setCaption(res.caption.caption);
    setTitle(res.caption.title ?? "");
    setTags(res.caption.hashtags.map((h) => `#${h}`).join(" "));
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2000);
  }

  const field = "w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-[15px] leading-snug outline-none focus:border-[var(--color-gold-400)]";

  return (
    <div className="rounded-2xl border border-[var(--color-border)] p-3" data-testid={`caption-${platform}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[14px] font-semibold">{LABEL[platform]}</p>
        <span className="text-[11.5px] text-[var(--color-text-faint)]">
          {justSaved ? "Saved" : saved ? (saved.source === "OWNER_EDIT" ? "Your text" : "Written by AI · tap to edit") : "Not written yet"}
        </span>
      </div>
      {!saved && missingReason && (
        <p className="mb-2 text-[12.5px] leading-snug text-[var(--color-gold-400)]">
          The AI couldn&apos;t write this ({missingReason}). Type it here — it won&apos;t post without it.
        </p>
      )}
      {yt && (
        <label className="mb-2 block">
          <span className="mb-1 block text-[12px] text-[var(--color-text-muted)]">Title</span>
          <input className={field} value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} placeholder="Title people will search for" />
        </label>
      )}
      <label className="block">
        <span className="mb-1 block text-[12px] text-[var(--color-text-muted)]">{yt ? "Description" : "Caption"}</span>
        <textarea className={`${field} min-h-[96px] resize-y`} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={yt ? "Description" : "Caption"} />
      </label>
      <label className="mt-2 block">
        <span className="mb-1 block text-[12px] text-[var(--color-text-muted)]">Hashtags</span>
        <input className={field} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#money #budgeting" autoCapitalize="none" autoCorrect="off" />
      </label>
      {error && <p className="mt-2 text-[12.5px] leading-snug text-[var(--color-rose-400)]">{error}</p>}
      {dirty && (
        <button type="button" className="btn btn-primary mt-3 w-full !min-h-[44px] !text-[14px]" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : `Save ${LABEL[platform]} text`}
        </button>
      )}
    </div>
  );
}
