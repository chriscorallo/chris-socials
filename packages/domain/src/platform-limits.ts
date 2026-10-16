import type { ContentPlatform } from "@prisma/client";

/**
 * Per-platform media + text limits, and the deterministic caption/title composition every
 * adapter uses — one source of truth, so preflight (packages/domain) checks exactly the text
 * the adapter (packages/platforms) will send. Pure functions, no I/O.
 *
 * Limits verified against official docs on 2026-10-16 (see
 * docs/decisions-pending/platforms.md for the URLs):
 * - Instagram Reels (IG User Media reference): 3s–15min, ≤300MB, caption ≤2,200 chars,
 *   ≤30 hashtags, ≤20 @-mentions, MP4/MOV, max width 1920.
 * - YouTube (videos resource): title ≤100 chars and no `<`/`>`; description ≤5,000 bytes and
 *   no `<`/`>`; tags ≤500 chars total. Shorts: ≤3 minutes, square or vertical (YouTube's
 *   2024-10-15 change).
 * - TikTok (Content Posting API media transfer guide + Direct Post reference): ≤4GB, title
 *   (caption) ≤2,200 UTF-16 units, 360–4096px per dimension, API-postable duration ≤10min
 *   (the creator's real cap comes from creator_info `max_video_post_duration_sec`).
 */

export interface PlatformMediaLimits {
  minDurationSeconds: number;
  maxDurationSeconds: number;
  maxFileSizeBytes: number;
  minDimensionPx?: number;
  maxDimensionPx?: number;
  maxWidthPx?: number;
}

const MB = 1024 * 1024;

export const PLATFORM_MEDIA_LIMITS: Record<ContentPlatform, PlatformMediaLimits> = {
  INSTAGRAM: { minDurationSeconds: 3, maxDurationSeconds: 15 * 60, maxFileSizeBytes: 300 * MB, maxWidthPx: 1920 },
  YOUTUBE: { minDurationSeconds: 1, maxDurationSeconds: 180, maxFileSizeBytes: 256 * 1024 * MB },
  TIKTOK: {
    minDurationSeconds: 3,
    maxDurationSeconds: 10 * 60,
    maxFileSizeBytes: 4 * 1024 * MB,
    minDimensionPx: 360,
    maxDimensionPx: 4096,
  },
};

/** This system renders vertical 9:16 short-form video by design; anything else reaching
 * publish is a render defect, not a creative choice. ±3% tolerance absorbs even-pixel
 * rounding (e.g. 1080x1918). */
export const VERTICAL_ASPECT = 9 / 16;
export const ASPECT_TOLERANCE = 0.03;

export const INSTAGRAM_CAPTION_MAX_CHARS = 2200;
export const INSTAGRAM_MAX_HASHTAGS = 30;
export const INSTAGRAM_MAX_MENTIONS = 20;
export const TIKTOK_TITLE_MAX_UTF16 = 2200;
export const YOUTUBE_TITLE_MAX_CHARS = 100;
export const YOUTUBE_DESCRIPTION_MAX_BYTES = 5000;
export const YOUTUBE_TAGS_MAX_CHARS = 500;

const HASHTAG_IN_TEXT = /(^|\s)#([\p{L}\p{N}_]+)/gu;
const MENTION_IN_TEXT = /(^|\s)@([\w.]+)/gu;

/** `"  #Foo Bar "` -> `"FooBar"`; returns null for something that can't be a hashtag. */
export function normalizeHashtag(raw: string): string | null {
  const cleaned = raw.trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
  return cleaned.length > 0 ? cleaned : null;
}

export function extractHashtags(text: string): string[] {
  return [...text.matchAll(HASHTAG_IN_TEXT)].map((m) => m[2]!);
}

export function countMentions(text: string): number {
  return [...text.matchAll(MENTION_IN_TEXT)].length;
}

/** Package hashtags not already present in the caption (case-insensitive), deduped, in order. */
export function hashtagsToAppend(caption: string, hashtags: string[]): string[] {
  const seen = new Set(extractHashtags(caption).map((h) => h.toLowerCase()));
  const out: string[] = [];
  for (const raw of hashtags) {
    const tag = normalizeHashtag(raw);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export interface ComposedCaption {
  text: string;
  hashtagCount: number;
  mentionCount: number;
  /** Package hashtags that could not be appended without breaking a hard limit. Preflight
   * blocks on a non-empty list so nothing is ever dropped silently in a real publish. */
  droppedHashtags: string[];
}

function composeCaptionWithHashtags(
  caption: string,
  hashtags: string[],
  maxLength: number,
  maxHashtags: number,
): ComposedCaption {
  const base = caption.trim();
  const toAppend = hashtagsToAppend(base, hashtags);
  const existingCount = extractHashtags(base).length;
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const tag of toAppend) {
    const candidate = [...kept, tag];
    const text = `${base}\n\n${candidate.map((t) => `#${t}`).join(" ")}`;
    if (existingCount + candidate.length > maxHashtags || text.length > maxLength) {
      dropped.push(tag);
      continue;
    }
    kept.push(tag);
  }
  const text = kept.length > 0 ? `${base}\n\n${kept.map((t) => `#${t}`).join(" ")}` : base;
  return {
    text,
    hashtagCount: existingCount + kept.length,
    mentionCount: countMentions(text),
    droppedHashtags: dropped,
  };
}

export function composeInstagramCaption(caption: string, hashtags: string[]): ComposedCaption {
  return composeCaptionWithHashtags(caption, hashtags, INSTAGRAM_CAPTION_MAX_CHARS, INSTAGRAM_MAX_HASHTAGS);
}

/** TikTok's `post_info.title` is the caption; its limit is in UTF-16 units, which is exactly
 * JavaScript's `.length`. */
export function composeTikTokTitle(caption: string, hashtags: string[]): ComposedCaption {
  return composeCaptionWithHashtags(caption, hashtags, TIKTOK_TITLE_MAX_UTF16, Number.POSITIVE_INFINITY);
}

/** Truncates by code point (never splits a surrogate pair / emoji half). */
export function truncateCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  for (const point of Array.from(text)) {
    const b = Buffer.byteLength(point, "utf8");
    if (bytes + b > maxBytes) break;
    out += point;
    bytes += b;
  }
  return out;
}

export function stripAngleBrackets(text: string): string {
  return text.replace(/[<>]/g, "");
}

export interface ComposedYouTubeMetadata {
  title: string;
  description: string;
  tags: string[];
  /** True when the title was derived from the caption and had to be shortened. */
  titleTruncated: boolean;
  descriptionTruncated: boolean;
}

/** YouTube counts a tag containing a space as if quoted, plus a comma between tags. */
function youtubeTagsLength(tags: string[]): number {
  return tags.reduce((sum, t, i) => sum + t.length + (t.includes(" ") ? 2 : 0) + (i > 0 ? 1 : 0), 0);
}

export function composeYouTubeMetadata(input: {
  title: string | null;
  caption: string;
  hashtags: string[];
}): ComposedYouTubeMetadata {
  const rawTitle = (input.title && input.title.trim()) || input.caption.split("\n")[0]!.trim() || input.caption.trim();
  const cleanTitle = stripAngleBrackets(rawTitle).replace(/\s+/g, " ").trim();
  const title = truncateCodePoints(cleanTitle, YOUTUBE_TITLE_MAX_CHARS).trim();

  const append = hashtagsToAppend(input.caption, input.hashtags);
  const fullDescription = stripAngleBrackets(
    append.length > 0 ? `${input.caption.trim()}\n\n${append.map((t) => `#${t}`).join(" ")}` : input.caption.trim(),
  );
  const description = truncateUtf8Bytes(fullDescription, YOUTUBE_DESCRIPTION_MAX_BYTES);

  const tags: string[] = [];
  for (const raw of input.hashtags) {
    const tag = normalizeHashtag(raw);
    if (!tag || tags.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
    if (youtubeTagsLength([...tags, tag]) > YOUTUBE_TAGS_MAX_CHARS) break;
    tags.push(tag);
  }

  return {
    title,
    description,
    tags,
    titleTruncated: title !== cleanTitle,
    descriptionTruncated: description !== fullDescription,
  };
}

export interface PackageTextInput {
  caption: string;
  title: string | null;
  hashtags: string[];
}

/** Every reason this package's text would violate the target platform's hard limits. Used by
 * preflight; each reason is specific so Chris knows exactly what to edit. */
export function validatePackageText(platform: ContentPlatform, pkg: PackageTextInput): string[] {
  const reasons: string[] = [];
  if (platform === "INSTAGRAM") {
    if (pkg.caption.length > INSTAGRAM_CAPTION_MAX_CHARS) {
      reasons.push(`Instagram caption is ${pkg.caption.length} chars (max ${INSTAGRAM_CAPTION_MAX_CHARS}).`);
    }
    const composed = composeInstagramCaption(pkg.caption, pkg.hashtags);
    if (composed.hashtagCount > INSTAGRAM_MAX_HASHTAGS || extractHashtags(pkg.caption).length > INSTAGRAM_MAX_HASHTAGS) {
      reasons.push(`Instagram allows at most ${INSTAGRAM_MAX_HASHTAGS} hashtags.`);
    }
    if (composed.droppedHashtags.length > 0) {
      reasons.push(
        `Instagram caption + hashtags exceed limits (${INSTAGRAM_CAPTION_MAX_CHARS} chars / ${INSTAGRAM_MAX_HASHTAGS} hashtags) — would drop: ${composed.droppedHashtags.map((t) => `#${t}`).join(" ")}.`,
      );
    }
    if (composed.mentionCount > INSTAGRAM_MAX_MENTIONS) {
      reasons.push(`Instagram allows at most ${INSTAGRAM_MAX_MENTIONS} @-mentions (found ${composed.mentionCount}).`);
    }
  } else if (platform === "TIKTOK") {
    if (pkg.caption.length > TIKTOK_TITLE_MAX_UTF16) {
      reasons.push(`TikTok caption is ${pkg.caption.length} UTF-16 units (max ${TIKTOK_TITLE_MAX_UTF16}).`);
    }
    const composed = composeTikTokTitle(pkg.caption, pkg.hashtags);
    if (composed.droppedHashtags.length > 0) {
      reasons.push(
        `TikTok caption + hashtags exceed ${TIKTOK_TITLE_MAX_UTF16} UTF-16 units — would drop: ${composed.droppedHashtags.map((t) => `#${t}`).join(" ")}.`,
      );
    }
  } else {
    if (pkg.title !== null && pkg.title.trim().length > 0) {
      const len = Array.from(pkg.title.trim()).length;
      if (len > YOUTUBE_TITLE_MAX_CHARS) {
        reasons.push(`YouTube title is ${len} chars (max ${YOUTUBE_TITLE_MAX_CHARS}).`);
      }
      if (/[<>]/.test(pkg.title)) {
        reasons.push("YouTube title may not contain '<' or '>'.");
      }
    }
    const composed = composeYouTubeMetadata(pkg);
    if (composed.title.length === 0) {
      reasons.push("YouTube title is empty after removing disallowed characters.");
    }
    if (composed.descriptionTruncated) {
      reasons.push(`YouTube description (caption + hashtags) exceeds ${YOUTUBE_DESCRIPTION_MAX_BYTES} bytes.`);
    }
  }
  return reasons;
}

export interface RenderMediaFacts {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  fileSizeBytes: number | null;
}

/** Specific, per-platform media-spec failures for a render. Missing facts fail closed — a
 * render this system produced always records them (apps/worker render-job.ts). */
export function validateMediaSpec(
  platform: ContentPlatform,
  media: RenderMediaFacts,
  overrides: { maxDurationSeconds?: number } = {},
): string[] {
  const reasons: string[] = [];
  const limits = PLATFORM_MEDIA_LIMITS[platform];
  const maxDuration = Math.min(limits.maxDurationSeconds, overrides.maxDurationSeconds ?? Number.POSITIVE_INFINITY);

  if (media.width === null || media.height === null || media.durationSeconds === null || media.fileSizeBytes === null) {
    reasons.push("Render is missing duration/dimensions/file size — media spec can't be verified (media spec check).");
    return reasons;
  }
  const aspect = media.width / media.height;
  if (Math.abs(aspect - VERTICAL_ASPECT) / VERTICAL_ASPECT > ASPECT_TOLERANCE) {
    reasons.push(`Render is ${media.width}x${media.height}, not vertical 9:16 (media spec check).`);
  }
  if (media.durationSeconds < limits.minDurationSeconds) {
    reasons.push(`${platform} requires at least ${limits.minDurationSeconds}s; render is ${media.durationSeconds.toFixed(1)}s.`);
  }
  if (media.durationSeconds > maxDuration) {
    reasons.push(`${platform} allows at most ${maxDuration}s; render is ${media.durationSeconds.toFixed(1)}s.`);
  }
  if (media.fileSizeBytes > limits.maxFileSizeBytes) {
    reasons.push(
      `${platform} allows files up to ${Math.round(limits.maxFileSizeBytes / MB)}MB; render is ${(media.fileSizeBytes / MB).toFixed(1)}MB.`,
    );
  }
  if (limits.maxWidthPx !== undefined && media.width > limits.maxWidthPx) {
    reasons.push(`${platform} allows a maximum width of ${limits.maxWidthPx}px; render is ${media.width}px.`);
  }
  if (limits.minDimensionPx !== undefined && Math.min(media.width, media.height) < limits.minDimensionPx) {
    reasons.push(`${platform} requires at least ${limits.minDimensionPx}px per side.`);
  }
  if (limits.maxDimensionPx !== undefined && Math.max(media.width, media.height) > limits.maxDimensionPx) {
    reasons.push(`${platform} allows at most ${limits.maxDimensionPx}px per side.`);
  }
  return reasons;
}
