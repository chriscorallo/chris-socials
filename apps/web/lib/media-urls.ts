// Plain URL builders (no server imports) — safe in client components.

/** Authenticated full-media URL (video bytes; 302 to a presigned Blob URL in production). */
export function mediaUrlFor(storageKey: string): string {
  return `/api/media/${storageKey}`;
}

/** Small JPEG poster frame for the same key (see lib/poster.ts and /api/thumb). */
export function thumbUrlFor(storageKey: string): string {
  return `/api/thumb/${storageKey}`;
}

/** Poster URL for an /api/media URL (players that only receive the media URL). */
export function thumbUrlForMediaUrl(mediaUrl: string): string | undefined {
  return mediaUrl.startsWith("/api/media/") ? `/api/thumb/${mediaUrl.slice("/api/media/".length).split("#")[0]}` : undefined;
}
