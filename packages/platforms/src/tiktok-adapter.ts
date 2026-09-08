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
 * TikTok Content Posting API — `FILE_UPLOAD` flow (single chunk; short-form clips are well
 * under TikTok's chunking thresholds so a single-chunk upload is the correct, not simplified,
 * implementation here). Endpoint and audit behavior verified against current TikTok docs on
 * 2026-09-07:
 *
 * 1. `POST /v2/post/publish/video/init/` with `source_info.source = "FILE_UPLOAD"`,
 *    `video_size`, `chunk_size` (= `video_size` for one chunk), `total_chunk_count = 1`, and
 *    `post_info` (title, privacy_level) -> `{ publish_id, upload_url }`
 * 2. `PUT <upload_url>` with the raw video bytes (`Content-Range: bytes 0-<size-1>/<size>`)
 * 3. `POST /v2/post/publish/status/fetch/` with `publish_id` to verify.
 *
 * **The audit gate this app is built around from day one** (see /docs/DECISIONS.md): "All
 * content posted by unaudited clients will be restricted to private viewing mode." Rather than
 * discover that as a surprise API rejection, this adapter is explicitly configured with
 * whether this app has passed TikTok's audit (`TIKTOK_APP_AUDITED`, default `false` — the safe
 * default). Unaudited: `privacy_level` is forced to `SELF_ONLY` and the result is reported as
 * `DRAFT`, not `SUCCESS` — a real, intentional outcome that still needs a human to finish
 * publishing from the TikTok app, not a failure to alert on.
 */
const API_BASE = "https://open.tiktokapis.com/v2";

export interface TikTokCredentials {
  accessToken: string;
  /** Whether this app has TikTok's Content Posting API audit approval — see the class comment.
   * Defaults to `false` (the safe assumption) wherever unset. */
  appAudited: boolean;
}

export class TikTokContentPostingAdapter implements PlatformAdapter {
  readonly platform = "TIKTOK" as const;

  constructor(private readonly credentials: TikTokCredentials | null) {}

  async checkCredentials(): Promise<CredentialCheckResult> {
    if (!this.credentials) {
      return { ok: false, reason: "No TikTok credentials configured (TIKTOK_ACCESS_TOKEN)." };
    }
    const response = await fetch(`${API_BASE}/user/info/?fields=open_id`, {
      headers: { Authorization: `Bearer ${this.credentials.accessToken}` },
    });
    if (!response.ok) {
      return { ok: false, reason: `TikTok credential check failed (HTTP ${response.status}).` };
    }
    return { ok: true };
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    if (!this.credentials) {
      return { status: "FAILED", platformPostId: null, url: null, rawResponse: null, errorMessage: "No TikTok credentials configured." };
    }
    const { accessToken, appAudited } = this.credentials;
    const videoSize = request.videoBytes.byteLength;

    const initResponse = await fetch(`${API_BASE}/post/publish/video/init/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        post_info: {
          title: request.caption,
          privacy_level: appAudited ? "PUBLIC_TO_EVERYONE" : "SELF_ONLY",
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: videoSize,
          chunk_size: videoSize,
          total_chunk_count: 1,
        },
      }),
    });
    const initBody = await initResponse.json().catch(() => null);
    if (!initResponse.ok) {
      return {
        status: "FAILED",
        platformPostId: null,
        url: null,
        rawResponse: initBody,
        errorMessage: `TikTok publish init failed (HTTP ${initResponse.status}).`,
      };
    }

    const data = (initBody as { data?: { publish_id?: string; upload_url?: string } } | null)?.data;
    const publishId = data?.publish_id ?? null;
    const uploadUrl = data?.upload_url ?? null;
    if (!publishId || !uploadUrl) {
      return { status: "FAILED", platformPostId: null, url: null, rawResponse: initBody, errorMessage: "No publish_id/upload_url returned." };
    }

    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes 0-${videoSize - 1}/${videoSize}`,
      },
      // A Blob wrapping a *copied* Uint8Array<ArrayBuffer> is unambiguously valid BodyInit
      // under every fetch typing this monorepo's tsconfigs resolve to. `Buffer`'s backing type
      // is `ArrayBufferLike` (which admits `SharedArrayBuffer`), which current DOM-lib types
      // reject for `BlobPart`/`BodyInit` even though the real Buffer here is never actually
      // shared-memory-backed — `Uint8Array.from` produces a real plain-`ArrayBuffer`-backed
      // copy that satisfies the stricter type (only surfaces transitively from apps/web's
      // tsconfig, not from this package's own).
      body: new Blob([Uint8Array.from(request.videoBytes)]),
    });
    if (!uploadResponse.ok) {
      return {
        status: "FAILED",
        platformPostId: publishId,
        url: null,
        rawResponse: { initBody, uploadStatus: uploadResponse.status },
        errorMessage: `TikTok chunk upload failed (HTTP ${uploadResponse.status}).`,
      };
    }

    return {
      status: appAudited ? "SUCCESS" : "DRAFT",
      platformPostId: publishId,
      url: null, // TikTok doesn't return a public URL synchronously — resolved on verify()
      rawResponse: initBody,
      errorMessage: appAudited
        ? undefined
        : "App is not TikTok-audited — posted as private (SELF_ONLY). Finish publishing manually from the TikTok app.",
    };
  }

  async verify(platformPostId: string): Promise<VerifyResult> {
    if (!this.credentials) return { verified: false, rawResponse: null };
    const response = await fetch(`${API_BASE}/post/publish/status/fetch/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.credentials.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ publish_id: platformPostId }),
    });
    const body = await response.json().catch(() => null);
    const status = (body as { data?: { status?: string } } | null)?.data?.status;
    return { verified: response.ok && status !== undefined && status !== "FAILED", rawResponse: body };
  }

  /**
   * Display API's `/v2/video/query/` — `like_count`/`comment_count`/`share_count`/
   * `view_count` verified against current TikTok docs on 2026-09-07 as real, standard-access
   * fields (no watch-time or save metric exists in this API at all — genuinely absent, not
   * omitted here). Known simplification: this expects `platformPostId` to already be the
   * resolved TikTok `video_id`, not the transient `publish_id` `publish()`/`verify()` above
   * work with — TikTok's publish flow only resolves the real video id after the post finishes
   * processing (via a follow-up status-fetch read `verify()` doesn't currently surface). See
   * /docs/DECISIONS.md.
   */
  async getMetrics(platformPostId: string): Promise<PlatformMetrics> {
    if (!this.credentials) {
      return { viewCount: null, likeCount: null, commentCount: null, shareCount: null, saveCount: null, reach: null, avgWatchTimeSeconds: null, rawResponse: null };
    }
    const response = await fetch(`${API_BASE}/video/query/?fields=id,like_count,comment_count,share_count,view_count`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.credentials.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ filters: { video_ids: [platformPostId] } }),
    });
    const body = await response.json().catch(() => null);
    const video = (
      body as { data?: { videos?: { like_count?: number; comment_count?: number; share_count?: number; view_count?: number }[] } } | null
    )?.data?.videos?.[0];
    return {
      viewCount: video?.view_count ?? null,
      likeCount: video?.like_count ?? null,
      commentCount: video?.comment_count ?? null,
      shareCount: video?.share_count ?? null,
      saveCount: null,
      reach: null,
      avgWatchTimeSeconds: null,
      rawResponse: body,
    };
  }

  /**
   * TikTok has no comment-listing endpoint at this app's access tier. Comment data exists only
   * through TikTok's separate Research API (`/v2/research/video/comment/list/`), which
   * requires a distinct researcher-eligibility approval this consumer/creator-tier app does
   * not have and would not qualify for — confirmed via live search during Phase 6, not
   * assumed. Returning an empty list here (rather than calling an endpoint this app can't
   * actually reach) is the honest, graceful behavior — see /docs/DECISIONS.md. Audience
   * Intelligence for TikTok content is limited to whatever Instagram/YouTube comments exist
   * for the same content until/unless that changes.
   */
  async listComments(_platformPostId: string): Promise<PlatformComment[]> {
    return [];
  }
}
