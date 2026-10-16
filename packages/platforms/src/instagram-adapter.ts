import { composeInstagramCaption } from "@chris/domain";
import {
  AmbiguousPublishError,
  PlatformHttpError,
  describePlatformError,
  type PlatformAdapter,
  type PublishRequest,
  type PublishResult,
  type VerifyResult,
  type CredentialCheckResult,
  type PlatformMetrics,
  type PlatformComment,
  type ExistingPostLookup,
  type ExistingPost,
} from "./adapter";
import { assertOk, defaultSleep, request, type FetchLike, type HttpResult } from "./http";

/**
 * Instagram API with Instagram Login (host `graph.instagram.com`) — Reels content publishing +
 * insights + comments. Verified against Meta's docs on 2026-10-16:
 * - developers.facebook.com/docs/instagram-platform/content-publishing (v25.0 in examples)
 * - .../instagram-graph-api/reference/ig-user/media (REELS params: `thumb_offset` in ms,
 *   `share_to_feed`, caption ≤2,200 chars / 30 hashtags / 20 mentions)
 * - .../reference/instagram-media/insights (Reels metrics: views, likes, comments, shares,
 *   saved, reach, ig_reels_avg_watch_time — `plays` is gone)
 *
 * Flow: 1) POST /{ig-user-id}/media (REELS container) 2) poll GET /{container}?fields=status_code
 * within a short, configurable budget — if still IN_PROGRESS, return FAILED + `resumeToken`
 * (container id) so a later retry/cron resumes instead of re-uploading (containers live 24h)
 * 3) POST /{ig-user-id}/media_publish 4) GET /{media-id}?fields=permalink for the real URL
 * (a numeric media id is NOT the /reel/{shortcode}/ path).
 *
 * `ig_reels_avg_watch_time` is reported in milliseconds (Meta's insights docs don't state the
 * unit on the reference page; the value is ms in practice and in Meta's Reels insights
 * guidance) — converted to seconds here.
 */
export const DEFAULT_INSTAGRAM_GRAPH_API_VERSION = "v25.0";

export interface InstagramCredentials {
  accessToken: string;
  igUserId: string;
}

export interface InstagramAdapterConfig {
  /** Fresh token + IG professional account id per call, or null when not connected. */
  getAuth: () => Promise<InstagramCredentials | null>;
  apiVersion?: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Container status polling budget — keep a publish request short (default 6 × 10s). */
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  /** Comment pagination cap (pages of up to 50). */
  maxCommentPages?: number;
}

interface InstagramResumeToken {
  containerId: string;
  createdAt: string;
}

function isResumeToken(value: unknown): value is InstagramResumeToken {
  return Boolean(value && typeof value === "object" && typeof (value as InstagramResumeToken).containerId === "string");
}

const EMPTY_METRICS: Omit<PlatformMetrics, "rawResponse"> = {
  viewCount: null,
  likeCount: null,
  commentCount: null,
  shareCount: null,
  saveCount: null,
  reach: null,
  avgWatchTimeSeconds: null,
};

export class InstagramGraphAdapter implements PlatformAdapter {
  readonly platform = "INSTAGRAM" as const;
  private readonly config: Required<Omit<InstagramAdapterConfig, "apiVersion">> & { apiVersion: string };

  /** Accepts the legacy static-credential shape (apps/web/lib/platform-adapters.ts) or the
   * refresh-aware config from createPlatformAdapters(). */
  constructor(credentials: InstagramCredentials | InstagramAdapterConfig | null) {
    const base: InstagramAdapterConfig =
      credentials === null
        ? { getAuth: async () => null }
        : "getAuth" in credentials
          ? credentials
          : { getAuth: async () => credentials };
    this.config = {
      getAuth: base.getAuth,
      apiVersion: base.apiVersion ?? process.env.INSTAGRAM_GRAPH_API_VERSION ?? DEFAULT_INSTAGRAM_GRAPH_API_VERSION,
      fetchImpl: base.fetchImpl ?? ((input, init) => fetch(input, init)),
      sleep: base.sleep ?? defaultSleep,
      pollIntervalMs: base.pollIntervalMs ?? 10_000,
      maxPollAttempts: base.maxPollAttempts ?? 6,
      maxCommentPages: base.maxCommentPages ?? 20,
    };
  }

  private url(path: string, accessToken: string): string {
    return `https://graph.instagram.com/${this.config.apiVersion}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(accessToken)}`;
  }

  private get(path: string, accessToken: string): Promise<HttpResult> {
    return request(this.config.fetchImpl, this.url(path, accessToken));
  }

  private post(path: string, accessToken: string, params: Record<string, string>): Promise<HttpResult> {
    return request(this.config.fetchImpl, this.url(path, accessToken), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
  }

  async checkCredentials(): Promise<CredentialCheckResult> {
    let auth: InstagramCredentials | null;
    try {
      auth = await this.config.getAuth();
    } catch (err) {
      return { ok: false, reason: `Instagram credentials unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!auth) {
      return { ok: false, reason: "Instagram is not connected (Settings → Connections, or INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_IG_USER_ID)." };
    }
    const result = await this.get(`/me?fields=user_id,username`, auth.accessToken);
    if (!result.ok) {
      return { ok: false, reason: `Instagram credential check failed (HTTP ${result.status})${describePlatformError(result.body)}.` };
    }
    return { ok: true };
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const fail = (errorMessage: string, rawResponse: unknown = null, resumeToken?: unknown): PublishResult => ({
      status: "FAILED",
      platformPostId: null,
      url: null,
      rawResponse,
      errorMessage,
      ...(resumeToken ? { resumeToken } : {}),
    });

    const auth = await this.config.getAuth();
    if (!auth) return fail("Instagram is not connected.");
    const { accessToken, igUserId } = auth;
    const caption = composeInstagramCaption(req.caption, req.hashtags).text;

    let resume: InstagramResumeToken;
    if (isResumeToken(req.resumeToken)) {
      resume = req.resumeToken;
    } else {
      if (!req.publicVideoUrl) {
        return fail(
          "Instagram publishing requires a public video URL (Instagram's servers fetch the file), and none was available — configure the public media URL provider (Vercel Blob).",
        );
      }
      const params: Record<string, string> = {
        media_type: "REELS",
        video_url: req.publicVideoUrl,
        caption,
        share_to_feed: "true",
      };
      if (req.coverFrameSeconds !== null && req.coverFrameSeconds >= 0) {
        params.thumb_offset = String(Math.round(req.coverFrameSeconds * 1000));
      }
      const created = await this.post(`/${igUserId}/media`, accessToken, params);
      if (!created.ok) {
        return fail(`Instagram container creation failed (HTTP ${created.status})${describePlatformError(created.body)}.`, created.body);
      }
      const containerId = (created.body as { id?: string } | null)?.id;
      if (!containerId) return fail("Instagram returned no container id.", created.body);
      resume = { containerId, createdAt: new Date().toISOString() };
    }

    let statusCode: string | undefined;
    let lastStatusBody: unknown = null;
    for (let attempt = 0; attempt < this.config.maxPollAttempts; attempt++) {
      const status = await this.get(`/${resume.containerId}?fields=status_code,status`, accessToken);
      lastStatusBody = status.body;
      statusCode = (status.body as { status_code?: string } | null)?.status_code;
      if (statusCode === "FINISHED" || statusCode === "PUBLISHED") break;
      if (statusCode === "ERROR" || statusCode === "EXPIRED") {
        return fail(`Instagram container processing ${statusCode}${describePlatformError(status.body)}.`, status.body);
      }
      if (attempt < this.config.maxPollAttempts - 1) await this.config.sleep(this.config.pollIntervalMs);
    }

    if (statusCode === "PUBLISHED") {
      // A previous resume already published this container (e.g. response lost) — find it.
      const existing = await this.findExistingPost({
        caption: req.caption,
        title: req.title,
        hashtags: req.hashtags,
        since: new Date(new Date(resume.createdAt).getTime() - 5 * 60 * 1000),
      }).catch(() => null);
      if (existing) {
        return { status: "SUCCESS", platformPostId: existing.platformPostId, url: existing.url, rawResponse: { recovered: true, container: lastStatusBody, media: existing.rawResponse } };
      }
      return fail(
        `Instagram container ${resume.containerId} reports PUBLISHED but the post could not be located — check the account before retrying.`,
        lastStatusBody,
      );
    }

    if (statusCode !== "FINISHED") {
      return fail(
        `PENDING_PROCESSING: Instagram is still processing container ${resume.containerId}; a retry (or the scheduled sweep) resumes it without re-uploading. Containers expire 24h after creation.`,
        { container: lastStatusBody, resumeToken: resume },
        resume,
      );
    }

    let published: HttpResult;
    try {
      published = await this.post(`/${igUserId}/media_publish`, accessToken, { creation_id: resume.containerId });
    } catch (err) {
      throw new AmbiguousPublishError(
        "INSTAGRAM",
        `Instagram media_publish request for container ${resume.containerId} got no response (${err instanceof Error ? err.message : String(err)}) — it may have been published.`,
        { containerId: resume.containerId },
      );
    }
    if (!published.ok) {
      return fail(`Instagram publish failed (HTTP ${published.status})${describePlatformError(published.body)}.`, published.body);
    }
    const mediaId = (published.body as { id?: string } | null)?.id ?? null;
    if (!mediaId) return fail("Instagram media_publish returned no media id.", published.body);

    let permalink: string | null = null;
    let mediaBody: unknown = null;
    try {
      const media = await this.get(`/${mediaId}?fields=id,permalink,media_product_type`, accessToken);
      mediaBody = media.body;
      permalink = media.ok ? ((media.body as { permalink?: string } | null)?.permalink ?? null) : null;
    } catch {
      // Permalink is resolved again by verify(); a failed lookup here never fails a real post.
    }

    return {
      status: "SUCCESS",
      platformPostId: mediaId,
      url: permalink,
      rawResponse: { containerId: resume.containerId, publish: published.body, media: mediaBody },
    };
  }

  async verify(platformPostId: string): Promise<VerifyResult> {
    const auth = await this.config.getAuth();
    if (!auth) return { verified: false, rawResponse: null, note: "Instagram is not connected." };
    const result = await this.get(`/${platformPostId}?fields=id,permalink,media_type,media_product_type`, auth.accessToken);
    const body = result.body as { id?: string; permalink?: string } | null;
    return {
      verified: result.ok && Boolean(body?.id),
      rawResponse: result.body,
      url: body?.permalink ?? null,
    };
  }

  async getMetrics(platformPostId: string): Promise<PlatformMetrics> {
    const auth = await this.config.getAuth();
    if (!auth) throw new Error("Instagram is not connected — metrics unavailable.");
    const metricNames = ["views", "likes", "comments", "shares", "saved", "reach", "ig_reels_avg_watch_time"];
    const result = await this.get(`/${platformPostId}/insights?metric=${metricNames.join(",")}`, auth.accessToken);
    assertOk("INSTAGRAM", "insights", result);
    const data = (result.body as { data?: { name?: string; values?: { value?: number }[]; total_value?: { value?: number } }[] } | null)?.data;
    if (!Array.isArray(data)) {
      throw new PlatformHttpError("INSTAGRAM", "insights (unexpected response shape)", result.status, result.body);
    }
    const valueFor = (name: string): number | null => {
      const entry = data.find((d) => d.name === name);
      const value = entry?.values?.[0]?.value ?? entry?.total_value?.value;
      return typeof value === "number" ? value : null;
    };
    const avgWatchMs = valueFor("ig_reels_avg_watch_time");
    return {
      ...EMPTY_METRICS,
      viewCount: valueFor("views"),
      likeCount: valueFor("likes"),
      commentCount: valueFor("comments"),
      shareCount: valueFor("shares"),
      saveCount: valueFor("saved"),
      reach: valueFor("reach"),
      avgWatchTimeSeconds: avgWatchMs === null ? null : avgWatchMs / 1000,
      rawResponse: result.body,
    };
  }

  /** `/{media-id}/comments`, following `paging.next` up to maxCommentPages. */
  async listComments(platformPostId: string): Promise<PlatformComment[]> {
    const auth = await this.config.getAuth();
    if (!auth) throw new Error("Instagram is not connected — comments unavailable.");
    const out: PlatformComment[] = [];
    let nextUrl: string | null = this.url(`/${platformPostId}/comments?fields=id,username,text,timestamp&limit=50`, auth.accessToken);
    for (let page = 0; nextUrl && page < this.config.maxCommentPages; page++) {
      const result: HttpResult = await request(this.config.fetchImpl, nextUrl);
      assertOk("INSTAGRAM", "comments", result);
      const body = result.body as {
        data?: { id?: string; username?: string; text?: string; timestamp?: string }[];
        paging?: { next?: string };
      } | null;
      for (const c of body?.data ?? []) {
        if (!c.id || !c.text) continue;
        out.push({
          platformCommentId: c.id,
          authorHandle: c.username ?? null,
          text: c.text,
          postedAt: c.timestamp ? new Date(c.timestamp) : null,
        });
      }
      nextUrl = body?.paging?.next ?? null;
    }
    return out;
  }

  /** Recent media on the account whose caption equals the caption this system would have sent,
   * posted at/after `since`. */
  async findExistingPost(lookup: ExistingPostLookup): Promise<ExistingPost | null> {
    const auth = await this.config.getAuth();
    if (!auth) throw new Error("Instagram is not connected.");
    const expected = composeInstagramCaption(lookup.caption, lookup.hashtags).text.trim();
    const result = await this.get(`/${auth.igUserId}/media?fields=id,caption,timestamp,permalink&limit=25`, auth.accessToken);
    assertOk("INSTAGRAM", "media list", result);
    const media = (result.body as { data?: { id?: string; caption?: string; timestamp?: string; permalink?: string }[] } | null)?.data ?? [];
    const match = media.find(
      (m) => m.id && (m.caption ?? "").trim() === expected && m.timestamp && new Date(m.timestamp) >= lookup.since,
    );
    return match?.id ? { platformPostId: match.id, url: match.permalink ?? null, rawResponse: match } : null;
  }
}
