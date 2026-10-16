import { composeTikTokTitle } from "@chris/domain";
import {
  AmbiguousPublishError,
  PlatformHttpError,
  describePlatformError,
  type AccessTokenProvider,
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
import { defaultSleep, request, toBody, type FetchLike, type HttpResult } from "./http";

/**
 * TikTok Content Posting API. Verified against TikTok's docs on 2026-10-16:
 * - Direct Post (content-posting-api-reference-direct-post): POST /v2/post/publish/video/init/,
 *   scope video.publish, `privacy_level` must be one of creator_info's
 *   `privacy_level_options`; "All content posted by unaudited clients will be restricted to
 *   private viewing mode" and unaudited clients can only post to *private accounts*
 *   (403 unaudited_client_can_only_post_to_private_accounts).
 * - Upload to inbox (content-posting-api-reference-upload-video): POST
 *   /v2/post/publish/inbox/video/init/, scope video.upload; the creator gets an inbox
 *   notification and finishes posting in the TikTok app. ≤5 pending shares per 24h.
 * - creator_info (…-query-creator-info): POST /v2/post/publish/creator_info/query/.
 * - Status (…-get-video-status): POST /v2/post/publish/status/fetch/ ->
 *   PROCESSING_UPLOAD | PROCESSING_DOWNLOAD | SEND_TO_USER_INBOX | PUBLISH_COMPLETE | FAILED;
 *   `publicaly_available_post_id` (sic) is a list of int64, present only once a *public* post
 *   clears moderation (minutes–hours). Parsed from raw text: int64 ids exceed 2^53.
 * - Media transfer guide: chunks 5–64MB, final chunk may be up to 128MB, files <5MB single
 *   chunk, files >64MB must be chunked, 1–1000 chunks, `total_chunk_count = floor(size /
 *   chunk_size)`, sequential PUTs with Content-Range; 206 per accepted chunk, 201 when done.
 *
 * Post modes (TIKTOK_POST_MODE): INBOX (default unless TIKTOK_APP_AUDITED=true) — the honest
 * unaudited path: video lands in Chris's TikTok inbox as a draft (DRAFT outcome). DIRECT —
 * creator_info first, privacy chosen from the allowed options (public only when audited).
 */
const API_BASE = "https://open.tiktokapis.com/v2";
const MB = 1024 * 1024;
export const TIKTOK_MIN_CHUNK_BYTES = 5 * MB;
export const TIKTOK_MAX_CHUNK_BYTES = 64 * MB;
export const TIKTOK_MAX_FINAL_CHUNK_BYTES = 128 * MB;
export const TIKTOK_DEFAULT_CHUNK_BYTES = 10 * MB;

export type TikTokPostMode = "INBOX" | "DIRECT";

export interface TikTokCredentials {
  accessToken: string;
  /** Whether this app has passed TikTok's Content Posting API audit. Defaults to false. */
  appAudited: boolean;
}

export interface TikTokAdapterConfig {
  getAccessToken: AccessTokenProvider;
  appAudited: boolean;
  postMode?: TikTokPostMode;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  chunkSizeBytes?: number;
  /** Status polling right after upload (short — moderation can take hours; verify() and the
   * sweep resolve the final id later). */
  statusPollAttempts?: number;
  statusPollIntervalMs?: number;
}

export interface TikTokChunkPlan {
  chunkSize: number;
  totalChunkCount: number;
  /** [start, endInclusive] byte ranges, sequential. */
  ranges: [number, number][];
}

/** Pure chunk math per TikTok's media transfer guide. */
export function planTikTokChunks(videoSize: number, preferredChunkSize: number = TIKTOK_DEFAULT_CHUNK_BYTES): TikTokChunkPlan {
  if (videoSize <= 0) throw new Error("Video is empty.");
  if (videoSize <= TIKTOK_MAX_CHUNK_BYTES) {
    return { chunkSize: videoSize, totalChunkCount: 1, ranges: [[0, videoSize - 1]] };
  }
  let chunkSize = Math.min(Math.max(preferredChunkSize, TIKTOK_MIN_CHUNK_BYTES), TIKTOK_MAX_CHUNK_BYTES);
  // Respect the 1000-chunk ceiling for very large files.
  if (Math.floor(videoSize / chunkSize) > 1000) chunkSize = Math.min(Math.ceil(videoSize / 1000), TIKTOK_MAX_CHUNK_BYTES);
  const totalChunkCount = Math.floor(videoSize / chunkSize);
  const ranges: [number, number][] = [];
  for (let i = 0; i < totalChunkCount; i++) {
    const start = i * chunkSize;
    const end = i === totalChunkCount - 1 ? videoSize - 1 : start + chunkSize - 1;
    ranges.push([start, end]);
  }
  const last = ranges[ranges.length - 1]!;
  if (last[1] - last[0] + 1 > TIKTOK_MAX_FINAL_CHUNK_BYTES) throw new Error("Final TikTok chunk would exceed 128MB.");
  return { chunkSize, totalChunkCount, ranges };
}

/** Extracts `publicaly_available_post_id` as decimal strings from the raw JSON text (int64-safe). */
export function extractTikTokPostIds(rawText: string): string[] {
  const match = rawText.match(/"publicaly_available_post_id"\s*:\s*\[([^\]]*)\]/);
  if (!match) return [];
  return [...match[1]!.matchAll(/"?(\d+)"?/g)].map((m) => m[1]!);
}

interface CreatorInfo {
  creator_username?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

function tiktokErrorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } } | null)?.error?.code;
}

function apiOk(result: HttpResult): boolean {
  const code = tiktokErrorCode(result.body);
  return result.ok && (code === undefined || code === "ok");
}

export class TikTokContentPostingAdapter implements PlatformAdapter {
  readonly platform = "TIKTOK" as const;
  private readonly config: Required<TikTokAdapterConfig>;
  private cachedUsername: string | null = null;

  constructor(credentials: TikTokCredentials | TikTokAdapterConfig | null) {
    const base: TikTokAdapterConfig =
      credentials === null
        ? { getAccessToken: async () => null, appAudited: false }
        : "getAccessToken" in credentials
          ? credentials
          : { getAccessToken: async () => credentials.accessToken, appAudited: credentials.appAudited };
    const envMode = process.env.TIKTOK_POST_MODE;
    this.config = {
      getAccessToken: base.getAccessToken,
      appAudited: base.appAudited,
      postMode: base.postMode ?? (envMode === "DIRECT" || envMode === "INBOX" ? envMode : base.appAudited ? "DIRECT" : "INBOX"),
      fetchImpl: base.fetchImpl ?? ((input, init) => fetch(input, init)),
      sleep: base.sleep ?? defaultSleep,
      chunkSizeBytes: base.chunkSizeBytes ?? TIKTOK_DEFAULT_CHUNK_BYTES,
      statusPollAttempts: base.statusPollAttempts ?? 3,
      statusPollIntervalMs: base.statusPollIntervalMs ?? 3000,
    };
  }

  get postMode(): TikTokPostMode {
    return this.config.postMode;
  }

  private async token(): Promise<string> {
    const token = await this.config.getAccessToken();
    if (!token) throw new Error("TikTok is not connected.");
    return token;
  }

  private postJson(path: string, token: string, body: unknown): Promise<HttpResult> {
    return request(this.config.fetchImpl, `${API_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
    });
  }

  async checkCredentials(): Promise<CredentialCheckResult> {
    let token: string | null;
    try {
      token = await this.config.getAccessToken();
    } catch (err) {
      return { ok: false, reason: `TikTok credentials unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!token) return { ok: false, reason: "TikTok is not connected (Settings → Connections, or TIKTOK_ACCESS_TOKEN)." };
    const result = await request(this.config.fetchImpl, `${API_BASE}/user/info/?fields=open_id,display_name`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!apiOk(result)) {
      return { ok: false, reason: `TikTok credential check failed (HTTP ${result.status})${describePlatformError(result.body)}.` };
    }
    return { ok: true };
  }

  private async queryCreatorInfo(token: string): Promise<CreatorInfo> {
    const result = await this.postJson("/post/publish/creator_info/query/", token, {});
    if (!apiOk(result)) throw new PlatformHttpError("TIKTOK", "creator_info/query", result.status, result.body);
    const data = (result.body as { data?: CreatorInfo } | null)?.data ?? {};
    if (data.creator_username) this.cachedUsername = data.creator_username;
    return data;
  }

  async getPublishConstraints(): Promise<{ maxDurationSeconds?: number }> {
    if (this.config.postMode !== "DIRECT") return {};
    const info = await this.queryCreatorInfo(await this.token());
    return typeof info.max_video_post_duration_sec === "number" ? { maxDurationSeconds: info.max_video_post_duration_sec } : {};
  }

  /** Public only when audited and allowed; otherwise SELF_ONLY (the only level an unaudited
   * client may use); otherwise the first option TikTok offers. */
  choosePrivacyLevel(options: string[]): string | null {
    if (options.length === 0) return null;
    if (this.config.appAudited && options.includes("PUBLIC_TO_EVERYONE")) return "PUBLIC_TO_EVERYONE";
    if (options.includes("SELF_ONLY")) return "SELF_ONLY";
    return this.config.appAudited ? options[0]! : null;
  }

  private postUrl(videoId: string): string | null {
    return this.cachedUsername ? `https://www.tiktok.com/@${this.cachedUsername}/video/${videoId}` : null;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const fail = (errorMessage: string, rawResponse: unknown = null, platformPostId: string | null = null): PublishResult => ({
      status: "FAILED",
      platformPostId,
      url: null,
      rawResponse,
      errorMessage,
    });
    const token = await this.config.getAccessToken();
    if (!token) return fail("TikTok is not connected.");

    const videoSize = req.videoBytes.byteLength;
    let plan: TikTokChunkPlan;
    try {
      plan = planTikTokChunks(videoSize, this.config.chunkSizeBytes);
    } catch (err) {
      return fail(`TikTok upload plan invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
    const sourceInfo = {
      source: "FILE_UPLOAD",
      video_size: videoSize,
      chunk_size: plan.chunkSize,
      total_chunk_count: plan.totalChunkCount,
    };

    let initBody: Record<string, unknown>;
    let privacyLevel: string | null = null;
    if (this.config.postMode === "INBOX") {
      initBody = { source_info: sourceInfo };
    } else {
      const creator = await this.queryCreatorInfo(token);
      privacyLevel = this.choosePrivacyLevel(creator.privacy_level_options ?? []);
      if (!privacyLevel) {
        return fail(
          `TikTok offered no privacy level this ${this.config.appAudited ? "" : "unaudited "}app can use (options: ${(creator.privacy_level_options ?? []).join(", ") || "none"}). Unaudited apps can only direct-post to private accounts — use TIKTOK_POST_MODE=INBOX.`,
          creator,
        );
      }
      if (
        typeof creator.max_video_post_duration_sec === "number" &&
        typeof req.durationSeconds === "number" &&
        req.durationSeconds > creator.max_video_post_duration_sec
      ) {
        return fail(`This TikTok account can post at most ${creator.max_video_post_duration_sec}s; the render is ${req.durationSeconds.toFixed(1)}s.`, creator);
      }
      initBody = {
        post_info: {
          title: composeTikTokTitle(req.caption, req.hashtags).text,
          privacy_level: privacyLevel,
          disable_comment: creator.comment_disabled ?? false,
          disable_duet: creator.duet_disabled ?? false,
          disable_stitch: creator.stitch_disabled ?? false,
          ...(req.coverFrameSeconds !== null && req.coverFrameSeconds >= 0
            ? { video_cover_timestamp_ms: Math.round(req.coverFrameSeconds * 1000) }
            : {}),
        },
        source_info: sourceInfo,
      };
    }

    const initPath = this.config.postMode === "INBOX" ? "/post/publish/inbox/video/init/" : "/post/publish/video/init/";
    const init = await this.postJson(initPath, token, initBody);
    if (!apiOk(init)) {
      const code = tiktokErrorCode(init.body);
      const hint =
        code === "unaudited_client_can_only_post_to_private_accounts"
          ? " Unaudited TikTok apps can only direct-post to private accounts — switch to TIKTOK_POST_MODE=INBOX or complete TikTok's audit."
          : code === "spam_risk_too_many_pending_share"
            ? " TikTok allows at most 5 pending inbox uploads per 24h — finish or discard drafts in the TikTok app."
            : "";
      return fail(`TikTok publish init failed (HTTP ${init.status})${describePlatformError(init.body)}.${hint}`, init.body);
    }
    const data = (init.body as { data?: { publish_id?: string; upload_url?: string } } | null)?.data;
    const publishId = data?.publish_id ?? null;
    const uploadUrl = data?.upload_url ?? null;
    if (!publishId || !uploadUrl) return fail("TikTok returned no publish_id/upload_url.", init.body);

    for (let i = 0; i < plan.ranges.length; i++) {
      const [start, end] = plan.ranges[i]!;
      const isLast = i === plan.ranges.length - 1;
      let put: HttpResult;
      try {
        put = await request(this.config.fetchImpl, uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${videoSize}` },
          body: toBody(req.videoBytes.subarray(start, end + 1)),
        });
      } catch (err) {
        if (isLast) {
          throw new AmbiguousPublishError(
            "TIKTOK",
            `TikTok final chunk upload got no response (${err instanceof Error ? err.message : String(err)}) — publish ${publishId} may proceed.`,
            { publishId },
          );
        }
        return fail(`TikTok chunk ${i + 1}/${plan.ranges.length} upload failed: ${err instanceof Error ? err.message : String(err)}`, init.body, publishId);
      }
      if (!put.ok) {
        return fail(`TikTok chunk ${i + 1}/${plan.ranges.length} upload failed (HTTP ${put.status}).`, { init: init.body, upload: put.body }, publishId);
      }
    }

    // Short status poll: catches immediate FAILED (format/duration checks) and inbox delivery.
    let status: { status?: string; fail_reason?: string } | undefined;
    let statusRaw: unknown = null;
    let postIds: string[] = [];
    for (let attempt = 0; attempt < this.config.statusPollAttempts; attempt++) {
      if (attempt > 0) await this.config.sleep(this.config.statusPollIntervalMs);
      try {
        const result = await this.postJson("/post/publish/status/fetch/", token, { publish_id: publishId });
        statusRaw = result.body;
        if (!apiOk(result)) continue;
        status = (result.body as { data?: { status?: string; fail_reason?: string } } | null)?.data;
        postIds = extractTikTokPostIds(result.text);
        if (status?.status === "FAILED" || status?.status === "SEND_TO_USER_INBOX" || status?.status === "PUBLISH_COMPLETE") break;
      } catch {
        // Status reads are best-effort here; verify() repeats them.
      }
    }

    const raw = { init: init.body, status: statusRaw, postMode: this.config.postMode, privacyLevel, publishId };
    if (status?.status === "FAILED") {
      return fail(`TikTok processing failed (${status.fail_reason ?? "unknown reason"}).`, raw, publishId);
    }

    if (this.config.postMode === "INBOX") {
      return {
        status: "DRAFT",
        platformPostId: publishId,
        url: null,
        rawResponse: raw,
        errorMessage: "Sent to your TikTok inbox — open the TikTok app to finish posting (this app isn't TikTok-audited for direct posting).",
      };
    }

    const resolvedId = postIds[0] ?? null;
    const isPublic = privacyLevel === "PUBLIC_TO_EVERYONE";
    return {
      status: isPublic ? "SUCCESS" : "DRAFT",
      platformPostId: resolvedId ?? publishId,
      url: resolvedId ? this.postUrl(resolvedId) : null,
      rawResponse: raw,
      errorMessage: isPublic
        ? undefined
        : `Posted to TikTok as ${privacyLevel} (unaudited apps are restricted to private viewing) — change visibility in the TikTok app.`,
    };
  }

  /** Accepts a publish_id (status fetch; resolves the real video id when TikTok exposes it) or a
   * numeric video id (video/query). */
  async verify(platformPostId: string): Promise<VerifyResult> {
    const token = await this.config.getAccessToken();
    if (!token) return { verified: false, rawResponse: null, note: "TikTok is not connected." };

    if (/^\d+$/.test(platformPostId)) {
      const result = await this.postJson("/video/query/?fields=id,share_url", token, { filters: { video_ids: [platformPostId] } });
      const video = (result.body as { data?: { videos?: { id?: string; share_url?: string }[] } } | null)?.data?.videos?.[0];
      return { verified: apiOk(result) && Boolean(video), rawResponse: result.body, url: video?.share_url ?? null };
    }

    const result = await this.postJson("/post/publish/status/fetch/", token, { publish_id: platformPostId });
    if (!apiOk(result)) return { verified: false, rawResponse: result.body };
    const data = (result.body as { data?: { status?: string; fail_reason?: string } } | null)?.data;
    const ids = extractTikTokPostIds(result.text);
    switch (data?.status) {
      case "PUBLISH_COMPLETE":
        return {
          verified: true,
          rawResponse: result.body,
          resolvedPostId: ids[0] ?? null,
          url: ids[0] ? this.postUrl(ids[0]) : null,
          note: ids[0] ? null : "TikTok post complete; public video id not exposed yet (private post, or moderation pending).",
        };
      case "SEND_TO_USER_INBOX":
        return { verified: true, rawResponse: result.body, note: "Waiting in your TikTok inbox — finish posting in the app." };
      case "FAILED":
        return { verified: false, rawResponse: result.body, note: `TikTok processing failed (${data.fail_reason ?? "unknown"}).` };
      default:
        return { verified: false, pending: true, rawResponse: result.body };
    }
  }

  /** Display API `/v2/video/query/` — requires the real numeric video id (not a publish_id).
   * Throws on an unresolved id / HTTP error / missing video so nothing fake is recorded. */
  async getMetrics(platformPostId: string): Promise<PlatformMetrics> {
    if (!/^\d+$/.test(platformPostId)) {
      throw new Error("TikTok post id not resolved yet (still a publish_id) — metrics unavailable until TikTok exposes the public video id.");
    }
    const token = await this.token();
    const result = await this.postJson("/video/query/?fields=id,like_count,comment_count,share_count,view_count", token, {
      filters: { video_ids: [platformPostId] },
    });
    if (!apiOk(result)) throw new PlatformHttpError("TIKTOK", "video/query", result.status, result.body);
    const video = (
      result.body as { data?: { videos?: { like_count?: number; comment_count?: number; share_count?: number; view_count?: number }[] } } | null
    )?.data?.videos?.[0];
    if (!video) throw new PlatformHttpError("TIKTOK", "video/query (video not found)", result.status, result.body);
    return {
      viewCount: video.view_count ?? null,
      likeCount: video.like_count ?? null,
      commentCount: video.comment_count ?? null,
      shareCount: video.share_count ?? null,
      saveCount: null,
      reach: null,
      avgWatchTimeSeconds: null,
      rawResponse: result.body,
    };
  }

  /** No comment-listing endpoint at this app's access tier (Research API only) — see
   * /docs/DECISIONS.md. Honest empty list. */
  async listComments(_platformPostId: string): Promise<PlatformComment[]> {
    return [];
  }

  /** DIRECT mode only: `/v2/video/list/` (scope video.list) for a recent video whose title
   * equals the composed caption. Inbox drafts can't be looked up — throws so the caller
   * surfaces "check manually". */
  async findExistingPost(lookup: ExistingPostLookup): Promise<ExistingPost | null> {
    if (this.config.postMode === "INBOX") {
      throw new Error("TikTok inbox drafts can't be looked up via the API — check your TikTok inbox.");
    }
    const token = await this.token();
    const result = await this.postJson("/video/list/?fields=id,title,create_time,share_url", token, { max_count: 20 });
    if (!apiOk(result)) throw new PlatformHttpError("TIKTOK", "video/list", result.status, result.body);
    const expected = composeTikTokTitle(lookup.caption, lookup.hashtags).text.trim();
    const sinceSec = Math.floor(lookup.since.getTime() / 1000);
    // Ids parsed from raw text (int64-safe), aligned with the parsed list order.
    const ids = [...result.text.matchAll(/"id"\s*:\s*"?(\d+)"?/g)].map((m) => m[1]!);
    const videos = (result.body as { data?: { videos?: { title?: string; create_time?: number; share_url?: string }[] } } | null)?.data?.videos ?? [];
    const index = videos.findIndex((v) => (v.title ?? "").trim() === expected && (v.create_time ?? 0) >= sinceSec);
    if (index < 0 || !ids[index]) return null;
    return { platformPostId: ids[index]!, url: videos[index]!.share_url ?? null, rawResponse: videos[index] };
  }
}
