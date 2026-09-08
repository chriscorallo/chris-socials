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
 * Instagram Graph API — Content Publishing (Reels). Endpoints verified against current Meta
 * docs (developers.facebook.com/docs/instagram-platform/content-publishing) on 2026-09-07:
 *
 * 1. `POST /{ig-user-id}/media` with `media_type=REELS`, `video_url`, `caption` -> container id
 * 2. Poll `GET /{container-id}?fields=status_code` until `FINISHED` (per Meta's own guidance:
 *    once per minute for up to 5 minutes — containers expire after 24h if never published)
 * 3. `POST /{ig-user-id}/media_publish` with `creation_id=<container-id>` -> media id
 * 4. Verify: `GET /{media-id}?fields=id,media_type,permalink`
 *
 * `video_url` must be a real, publicly-fetchable URL — Instagram's servers pull the video
 * themselves, there is no direct binary-upload path in this API. See PublishRequest's
 * `publicVideoUrl` field and /docs/DECISIONS.md.
 */
const GRAPH_BASE = "https://graph.instagram.com/v25.0";
const POLL_INTERVAL_MS = 60_000;
const MAX_POLL_ATTEMPTS = 5;

export interface InstagramCredentials {
  accessToken: string;
  igUserId: string;
}

async function graphFetch(
  path: string,
  accessToken: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const url = `${GRAPH_BASE}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(accessToken)}`;
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class InstagramGraphAdapter implements PlatformAdapter {
  readonly platform = "INSTAGRAM" as const;

  constructor(private readonly credentials: InstagramCredentials | null) {}

  async checkCredentials(): Promise<CredentialCheckResult> {
    if (!this.credentials) {
      return { ok: false, reason: "No Instagram credentials configured (INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_IG_USER_ID)." };
    }
    const result = await graphFetch(`/${this.credentials.igUserId}?fields=id`, this.credentials.accessToken);
    if (!result.ok) {
      return { ok: false, reason: `Instagram credential check failed (HTTP ${result.status}).` };
    }
    return { ok: true };
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    if (!this.credentials) {
      return { status: "FAILED", platformPostId: null, url: null, rawResponse: null, errorMessage: "No Instagram credentials configured." };
    }
    if (!request.publicVideoUrl) {
      return {
        status: "FAILED",
        platformPostId: null,
        url: null,
        rawResponse: null,
        errorMessage: "Instagram publishing requires a real public video URL, and none was provided.",
      };
    }

    const { accessToken, igUserId } = this.credentials;

    const createResult = await graphFetch(`/${igUserId}/media`, accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        media_type: "REELS",
        video_url: request.publicVideoUrl,
        caption: request.caption,
      }),
    });
    if (!createResult.ok) {
      return {
        status: "FAILED",
        platformPostId: null,
        url: null,
        rawResponse: createResult.body,
        errorMessage: `Container creation failed (HTTP ${createResult.status}).`,
      };
    }
    const containerId = (createResult.body as { id?: string } | null)?.id;
    if (!containerId) {
      return { status: "FAILED", platformPostId: null, url: null, rawResponse: createResult.body, errorMessage: "No container id returned." };
    }

    let finished = false;
    let lastStatusBody: unknown = null;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const statusResult = await graphFetch(`/${containerId}?fields=status_code`, accessToken);
      lastStatusBody = statusResult.body;
      const statusCode = (statusResult.body as { status_code?: string } | null)?.status_code;
      if (statusCode === "FINISHED") {
        finished = true;
        break;
      }
      if (statusCode === "ERROR" || statusCode === "EXPIRED") {
        return {
          status: "FAILED",
          platformPostId: null,
          url: null,
          rawResponse: statusResult.body,
          errorMessage: `Container processing ${statusCode}.`,
        };
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (!finished) {
      return {
        status: "FAILED",
        platformPostId: null,
        url: null,
        rawResponse: lastStatusBody,
        errorMessage: "Container did not finish processing within the polling window.",
      };
    }

    const publishResult = await graphFetch(`/${igUserId}/media_publish`, accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: containerId }),
    });
    if (!publishResult.ok) {
      return {
        status: "FAILED",
        platformPostId: null,
        url: null,
        rawResponse: publishResult.body,
        errorMessage: `Publish failed (HTTP ${publishResult.status}).`,
      };
    }
    const mediaId = (publishResult.body as { id?: string } | null)?.id ?? null;

    return {
      status: "SUCCESS",
      platformPostId: mediaId,
      url: mediaId ? `https://www.instagram.com/reel/${mediaId}/` : null,
      rawResponse: publishResult.body,
    };
  }

  async verify(platformPostId: string): Promise<VerifyResult> {
    if (!this.credentials) return { verified: false, rawResponse: null };
    const result = await graphFetch(
      `/${platformPostId}?fields=id,media_type,permalink`,
      this.credentials.accessToken,
    );
    return { verified: result.ok && Boolean((result.body as { id?: string } | null)?.id), rawResponse: result.body };
  }

  /**
   * `/{media-id}/insights` — field names verified against current Meta docs on 2026-09-07:
   * `views`, `likes`, `comments`, `shares`, `saved`, `reach`, `ig_reels_avg_watch_time`. Every
   * one of these is a real, currently-documented Reels insights metric — none invented.
   */
  async getMetrics(platformPostId: string): Promise<PlatformMetrics> {
    if (!this.credentials) {
      return { viewCount: null, likeCount: null, commentCount: null, shareCount: null, saveCount: null, reach: null, avgWatchTimeSeconds: null, rawResponse: null };
    }
    const metricNames = ["views", "likes", "comments", "shares", "saved", "reach", "ig_reels_avg_watch_time"];
    const result = await graphFetch(
      `/${platformPostId}/insights?metric=${metricNames.join(",")}`,
      this.credentials.accessToken,
    );
    const data = (result.body as { data?: { name?: string; values?: { value?: number }[] }[] } | null)?.data ?? [];
    const valueFor = (name: string): number | null => {
      const entry = data.find((d) => d.name === name);
      const value = entry?.values?.[0]?.value;
      return typeof value === "number" ? value : null;
    };
    return {
      viewCount: valueFor("views"),
      likeCount: valueFor("likes"),
      commentCount: valueFor("comments"),
      shareCount: valueFor("shares"),
      saveCount: valueFor("saved"),
      reach: valueFor("reach"),
      avgWatchTimeSeconds: valueFor("ig_reels_avg_watch_time"),
      rawResponse: result.body,
    };
  }

  /** `/{media-id}/comments` — top-level fields per current Meta docs. */
  async listComments(platformPostId: string): Promise<PlatformComment[]> {
    if (!this.credentials) return [];
    const result = await graphFetch(
      `/${platformPostId}/comments?fields=id,username,text,timestamp`,
      this.credentials.accessToken,
    );
    const data =
      (result.body as { data?: { id?: string; username?: string; text?: string; timestamp?: string }[] } | null)
        ?.data ?? [];
    return data
      .filter((c): c is { id: string; username?: string; text: string; timestamp?: string } => Boolean(c.id && c.text))
      .map((c) => ({
        platformCommentId: c.id,
        authorHandle: c.username ?? null,
        text: c.text,
        postedAt: c.timestamp ? new Date(c.timestamp) : null,
      }));
  }
}
