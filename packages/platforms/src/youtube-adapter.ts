import type {
  PlatformAdapter,
  PublishRequest,
  PublishResult,
  VerifyResult,
  CredentialCheckResult,
  PlatformMetrics,
  PlatformComment,
} from "./adapter";

/**
 * YouTube Data API v3 — `videos.insert` (multipart upload: JSON metadata + video bytes in one
 * request, appropriate for short-form clips well under the API's size thresholds where a full
 * resumable session isn't needed). Endpoint and quota model verified against current Google
 * docs on 2026-09-07 — see /docs/DECISIONS.md's correction entry for the quota numbers, and
 * packages/platforms/src/youtube-quota.ts for the actual tracking (this adapter doesn't check
 * quota itself — packages/domain's publish job checks `getYouTubeQuotaState` before ever
 * calling this adapter, so a call arriving here is already known to be within budget).
 */
const UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status";
const VIDEOS_LIST_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";
const MULTIPART_BOUNDARY = "chris_content_intelligence_boundary";

export interface YouTubeCredentials {
  accessToken: string;
}

export class YouTubeDataApiAdapter implements PlatformAdapter {
  readonly platform = "YOUTUBE" as const;

  constructor(private readonly credentials: YouTubeCredentials | null) {}

  async checkCredentials(): Promise<CredentialCheckResult> {
    if (!this.credentials) {
      return { ok: false, reason: "No YouTube credentials configured (YOUTUBE_ACCESS_TOKEN)." };
    }
    const response = await fetch(`${VIDEOS_LIST_ENDPOINT}?part=id&mine=true&maxResults=1`, {
      headers: { Authorization: `Bearer ${this.credentials.accessToken}` },
    });
    if (!response.ok) {
      return { ok: false, reason: `YouTube credential check failed (HTTP ${response.status}).` };
    }
    return { ok: true };
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    if (!this.credentials) {
      return { status: "FAILED", platformPostId: null, url: null, rawResponse: null, errorMessage: "No YouTube credentials configured." };
    }

    const metadata = {
      snippet: {
        title: request.title ?? request.caption.slice(0, 100),
        description: request.caption,
        tags: request.hashtags.map((tag) => tag.replace(/^#/, "")),
      },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    };

    // Multipart/related body: JSON metadata part, then the raw video bytes part.
    const body = Buffer.concat([
      Buffer.from(
        `--${MULTIPART_BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${JSON.stringify(metadata)}\r\n--${MULTIPART_BOUNDARY}\r\nContent-Type: video/mp4\r\n\r\n`,
      ),
      request.videoBytes,
      Buffer.from(`\r\n--${MULTIPART_BOUNDARY}--`),
    ]);

    const response = await fetch(UPLOAD_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.credentials.accessToken}`,
        "Content-Type": `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
      },
      // See tiktok-adapter.ts's comment on the same pattern.
      body: new Blob([Uint8Array.from(body)]),
    });
    const responseBody = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        status: "FAILED",
        platformPostId: null,
        url: null,
        rawResponse: responseBody,
        errorMessage: `YouTube upload failed (HTTP ${response.status}).`,
      };
    }

    const videoId = (responseBody as { id?: string } | null)?.id ?? null;
    return {
      status: "SUCCESS",
      platformPostId: videoId,
      url: videoId ? `https://www.youtube.com/shorts/${videoId}` : null,
      rawResponse: responseBody,
    };
  }

  async verify(platformPostId: string): Promise<VerifyResult> {
    if (!this.credentials) return { verified: false, rawResponse: null };
    const response = await fetch(`${VIDEOS_LIST_ENDPOINT}?part=status&id=${encodeURIComponent(platformPostId)}`, {
      headers: { Authorization: `Bearer ${this.credentials.accessToken}` },
    });
    const body = await response.json().catch(() => null);
    const items = (body as { items?: unknown[] } | null)?.items;
    return { verified: response.ok && Array.isArray(items) && items.length > 0, rawResponse: body };
  }

  /**
   * `videos.list?part=statistics` — verified against current Google docs on 2026-09-07:
   * `viewCount`, `likeCount`, `commentCount` are real fields. There is deliberately no
   * shareCount/saveCount/avgWatchTimeSeconds mapping here — the Data API v3 does not return
   * share counts, saves, or any watch-time/duration-watched metric at all (that requires the
   * separate, more heavily-scoped YouTube Analytics API, not integrated in this phase) — those
   * fields stay genuinely `null`, not a placeholder.
   */
  async getMetrics(platformPostId: string): Promise<PlatformMetrics> {
    if (!this.credentials) {
      return { viewCount: null, likeCount: null, commentCount: null, shareCount: null, saveCount: null, reach: null, avgWatchTimeSeconds: null, rawResponse: null };
    }
    const response = await fetch(
      `${VIDEOS_LIST_ENDPOINT}?part=statistics&id=${encodeURIComponent(platformPostId)}`,
      { headers: { Authorization: `Bearer ${this.credentials.accessToken}` } },
    );
    const body = await response.json().catch(() => null);
    const stats = (
      body as { items?: { statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }[] } | null
    )?.items?.[0]?.statistics;
    const toInt = (v: string | undefined): number | null => (v !== undefined ? parseInt(v, 10) : null);
    return {
      viewCount: toInt(stats?.viewCount),
      likeCount: toInt(stats?.likeCount),
      commentCount: toInt(stats?.commentCount),
      shareCount: null,
      saveCount: null,
      reach: null,
      avgWatchTimeSeconds: null,
      rawResponse: body,
    };
  }

  /** `commentThreads.list?part=snippet` — top-level comment fields verified against current
   * Google docs (`snippet.topLevelComment.{id,snippet.textDisplay,snippet.authorDisplayName,
   * snippet.publishedAt}`) on 2026-09-07. */
  async listComments(platformPostId: string): Promise<PlatformComment[]> {
    if (!this.credentials) return [];
    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(platformPostId)}`,
      { headers: { Authorization: `Bearer ${this.credentials.accessToken}` } },
    );
    const body = await response.json().catch(() => null);
    const items =
      (
        body as {
          items?: {
            snippet?: {
              topLevelComment?: { id?: string; snippet?: { textDisplay?: string; authorDisplayName?: string; publishedAt?: string } };
            };
          }[];
        } | null
      )?.items ?? [];
    return items
      .map((item) => item.snippet?.topLevelComment)
      .filter((c): c is NonNullable<typeof c> => Boolean(c?.id && c.snippet?.textDisplay))
      .map((c) => ({
        platformCommentId: c.id!,
        authorHandle: c.snippet?.authorDisplayName ?? null,
        text: c.snippet!.textDisplay!,
        postedAt: c.snippet?.publishedAt ? new Date(c.snippet.publishedAt) : null,
      }));
  }
}
