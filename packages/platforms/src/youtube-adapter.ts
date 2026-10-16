import { composeYouTubeMetadata } from "@chris/domain";
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
import { assertOk, request, toBody, type FetchLike, type HttpResult } from "./http";

/**
 * YouTube Data API v3. Verified against Google's docs on 2026-10-16:
 * - videos.insert (developers.google.com/youtube/v3/docs/videos/insert): resumable upload
 *   protocol, 1 unit in the dedicated "Video Uploads" bucket (100/day — see youtube-quota.ts).
 * - videos resource: title ≤100 chars, no `<`/`>`; description ≤5,000 bytes; tags ≤500 chars;
 *   `status.uploadStatus` ∈ {uploaded, processed, failed, rejected, deleted}.
 * - Resumable upload guide (developers.google.com/youtube/v3/guides/using_resumable_upload_protocol):
 *   POST metadata -> `Location` session URI; PUT bytes; on an interrupted PUT, query with
 *   `Content-Range: bytes * /SIZE` -> 308 + `Range` (resume) or 200/201 (already complete).
 *
 * Tokens come from an AccessTokenProvider per call (credential-store.ts refreshes the ~1h
 * Google access token via the stored refresh_token) — never a static string.
 */
const UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const API_BASE = "https://www.googleapis.com/youtube/v3";

export type YouTubePrivacyStatus = "public" | "unlisted" | "private";

export interface YouTubeCredentials {
  accessToken: string;
}

export interface YouTubeAdapterConfig {
  getAccessToken: AccessTokenProvider;
  /** Requested privacy; env YOUTUBE_PRIVACY_STATUS, default "public". */
  privacyStatus?: YouTubePrivacyStatus;
  fetchImpl?: FetchLike;
  /** Max resume attempts after an interrupted upload PUT. */
  maxUploadResumes?: number;
  maxCommentPages?: number;
}

function parsePrivacy(value: string | undefined): YouTubePrivacyStatus {
  return value === "unlisted" || value === "private" ? value : "public";
}

export class YouTubeDataApiAdapter implements PlatformAdapter {
  readonly platform = "YOUTUBE" as const;
  private readonly config: Required<YouTubeAdapterConfig>;

  constructor(credentials: YouTubeCredentials | YouTubeAdapterConfig | null) {
    const base: YouTubeAdapterConfig =
      credentials === null
        ? { getAccessToken: async () => null }
        : "getAccessToken" in credentials
          ? credentials
          : { getAccessToken: async () => credentials.accessToken };
    this.config = {
      getAccessToken: base.getAccessToken,
      privacyStatus: base.privacyStatus ?? parsePrivacy(process.env.YOUTUBE_PRIVACY_STATUS),
      fetchImpl: base.fetchImpl ?? ((input, init) => fetch(input, init)),
      maxUploadResumes: base.maxUploadResumes ?? 3,
      maxCommentPages: base.maxCommentPages ?? 10,
    };
  }

  private async token(): Promise<string> {
    const token = await this.config.getAccessToken();
    if (!token) throw new Error("YouTube is not connected.");
    return token;
  }

  private get(url: string, token: string): Promise<HttpResult> {
    return request(this.config.fetchImpl, url, { headers: { Authorization: `Bearer ${token}` } });
  }

  async checkCredentials(): Promise<CredentialCheckResult> {
    let token: string | null;
    try {
      token = await this.config.getAccessToken();
    } catch (err) {
      return { ok: false, reason: `YouTube credentials unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!token) return { ok: false, reason: "YouTube is not connected (Settings → Connections, or YOUTUBE_ACCESS_TOKEN)." };
    const result = await this.get(`${API_BASE}/channels?part=id&mine=true`, token);
    if (!result.ok) {
      return { ok: false, reason: `YouTube credential check failed (HTTP ${result.status})${describePlatformError(result.body)}.` };
    }
    return { ok: true };
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const fail = (errorMessage: string, rawResponse: unknown = null): PublishResult => ({
      status: "FAILED",
      platformPostId: null,
      url: null,
      rawResponse,
      errorMessage,
    });
    const token = await this.config.getAccessToken();
    if (!token) return fail("YouTube is not connected.");

    const composed = composeYouTubeMetadata({ title: req.title, caption: req.caption, hashtags: req.hashtags });
    const metadata = {
      snippet: {
        title: composed.title,
        description: composed.description,
        ...(composed.tags.length > 0 ? { tags: composed.tags } : {}),
      },
      status: { privacyStatus: this.config.privacyStatus, selfDeclaredMadeForKids: false },
    };
    const size = req.videoBytes.byteLength;

    // 1. Open the resumable session.
    const session = await request(this.config.fetchImpl, UPLOAD_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(size),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify(metadata),
    });
    if (!session.ok) {
      return fail(`YouTube upload session failed (HTTP ${session.status})${describePlatformError(session.body)}.`, session.body);
    }
    const sessionUri = session.headers.get("location");
    if (!sessionUri) return fail("YouTube did not return a resumable upload session URI.", session.body);

    // 2. Upload, resuming from the server-acknowledged offset after an interruption.
    let offset = 0;
    let lastError: string = "unknown error";
    for (let attempt = 0; attempt <= this.config.maxUploadResumes; attempt++) {
      let put: HttpResult;
      try {
        put = await request(this.config.fetchImpl, sessionUri, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "video/mp4",
            ...(offset > 0 ? { "Content-Range": `bytes ${offset}-${size - 1}/${size}` } : {}),
          },
          body: toBody(offset === 0 ? req.videoBytes : req.videoBytes.subarray(offset)),
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        put = { ok: false, status: 0, body: null, text: "", headers: new Headers() };
      }
      if (put.status === 200 || put.status === 201) return this.uploadSucceeded(put.body);
      if (put.status === 308) {
        offset = nextOffsetFromRange(put.headers.get("range"));
        continue;
      }
      if (put.status !== 0 && put.status < 500) {
        return fail(`YouTube upload failed (HTTP ${put.status})${describePlatformError(put.body)}.`, put.body);
      }
      if (put.status >= 500) lastError = `HTTP ${put.status}`;
      // Connection dropped or 5xx mid-upload: ask the session how far it got.
      let state: UploadSessionState;
      try {
        state = await this.queryUploadSession(sessionUri, token, size);
      } catch (statusErr) {
        throw new AmbiguousPublishError(
          "YOUTUBE",
          `YouTube upload interrupted (${lastError}) and the session status could not be read (${statusErr instanceof Error ? statusErr.message : String(statusErr)}) — the video may exist.`,
        );
      }
      if (state.complete) return this.uploadSucceeded(state.body);
      offset = state.offset;
    }
    throw new AmbiguousPublishError(
      "YOUTUBE",
      `YouTube upload did not complete after ${this.config.maxUploadResumes} resumes (${lastError}) — the video may exist.`,
    );
  }

  private async queryUploadSession(sessionUri: string, token: string, size: number): Promise<UploadSessionState> {
    const status = await request(this.config.fetchImpl, sessionUri, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Range": `bytes */${size}` },
    });
    if (status.status === 200 || status.status === 201) return { complete: true, body: status.body };
    if (status.status === 308) return { complete: false, offset: nextOffsetFromRange(status.headers.get("range")) };
    throw new PlatformHttpError("YOUTUBE", "upload status query", status.status, status.body);
  }

  private uploadSucceeded(body: unknown): PublishResult {
    const videoId = (body as { id?: string } | null)?.id ?? null;
    if (!videoId) {
      return { status: "FAILED", platformPostId: null, url: null, rawResponse: body, errorMessage: "YouTube upload returned no video id." };
    }
    const privacy = (body as { status?: { privacyStatus?: string } }).status?.privacyStatus;
    return {
      status: "SUCCESS",
      platformPostId: videoId,
      url: `https://www.youtube.com/shorts/${videoId}`,
      rawResponse: body,
      errorMessage:
        privacy && privacy !== this.config.privacyStatus
          ? `YouTube set this upload to "${privacy}" (requested "${this.config.privacyStatus}").`
          : undefined,
    };
  }

  /** videos.list?part=status — exists + upload/privacy state. A requested-public video that
   * comes back private is verified (it exists) but flagged: Google can lock uploads from
   * unverified API projects to private until the project passes its API audit. */
  async verify(platformPostId: string): Promise<VerifyResult> {
    const token = await this.config.getAccessToken();
    if (!token) return { verified: false, rawResponse: null, note: "YouTube is not connected." };
    const result = await this.get(`${API_BASE}/videos?part=status&id=${encodeURIComponent(platformPostId)}`, token);
    if (!result.ok) return { verified: false, rawResponse: result.body };
    const item = (result.body as {
      items?: { status?: { uploadStatus?: string; privacyStatus?: string; failureReason?: string; rejectionReason?: string } }[];
    } | null)?.items?.[0];
    if (!item) return { verified: false, rawResponse: result.body, note: "YouTube video not found." };
    const uploadStatus = item.status?.uploadStatus;
    const privacy = item.status?.privacyStatus;
    if (uploadStatus === "failed" || uploadStatus === "rejected" || uploadStatus === "deleted") {
      const why = item.status?.failureReason ?? item.status?.rejectionReason ?? uploadStatus;
      return { verified: false, rawResponse: result.body, note: `YouTube upload ${uploadStatus} (${why}).` };
    }
    let note: string | null = null;
    if (this.config.privacyStatus === "public" && privacy === "private") {
      note = "Uploaded but private — YouTube API audit required (unverified API projects' uploads can be locked to private), or the channel defaults uploads to private.";
    }
    return {
      verified: true,
      rawResponse: result.body,
      url: `https://www.youtube.com/shorts/${platformPostId}`,
      note,
    };
  }

  /** videos.list?part=statistics — viewCount/likeCount/commentCount only (the Data API has no
   * share/save/watch-time fields). Throws on HTTP error or a missing video so nothing is
   * recorded as a fake all-null snapshot. */
  async getMetrics(platformPostId: string): Promise<PlatformMetrics> {
    const token = await this.token();
    const result = await this.get(`${API_BASE}/videos?part=statistics&id=${encodeURIComponent(platformPostId)}`, token);
    assertOk("YOUTUBE", "videos.list statistics", result);
    const stats = (
      result.body as { items?: { statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }[] } | null
    )?.items?.[0]?.statistics;
    if (!stats) throw new PlatformHttpError("YOUTUBE", "videos.list statistics (video not found)", result.status, result.body);
    const toInt = (v: string | undefined): number | null => (v !== undefined ? parseInt(v, 10) : null);
    return {
      viewCount: toInt(stats.viewCount),
      likeCount: toInt(stats.likeCount),
      commentCount: toInt(stats.commentCount),
      shareCount: null,
      saveCount: null,
      reach: null,
      avgWatchTimeSeconds: null,
      rawResponse: result.body,
    };
  }

  /** commentThreads.list, paginated by pageToken. Comments disabled -> []. */
  async listComments(platformPostId: string): Promise<PlatformComment[]> {
    const token = await this.token();
    const out: PlatformComment[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < this.config.maxCommentPages; page++) {
      const url =
        `${API_BASE}/commentThreads?part=snippet&maxResults=100&videoId=${encodeURIComponent(platformPostId)}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const result = await this.get(url, token);
      if (result.status === 403 && JSON.stringify(result.body ?? "").includes("commentsDisabled")) return out;
      assertOk("YOUTUBE", "commentThreads.list", result);
      const body = result.body as {
        nextPageToken?: string;
        items?: {
          snippet?: {
            topLevelComment?: { id?: string; snippet?: { textDisplay?: string; authorDisplayName?: string; publishedAt?: string } };
          };
        }[];
      } | null;
      for (const item of body?.items ?? []) {
        const c = item.snippet?.topLevelComment;
        if (!c?.id || !c.snippet?.textDisplay) continue;
        out.push({
          platformCommentId: c.id,
          authorHandle: c.snippet.authorDisplayName ?? null,
          text: c.snippet.textDisplay,
          postedAt: c.snippet.publishedAt ? new Date(c.snippet.publishedAt) : null,
        });
      }
      pageToken = body?.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  /** Looks through the channel's most recent uploads (uploads playlist; 1 quota unit per call,
   * unlike search.list's 100) for a video with the exact title this system would have sent. */
  async findExistingPost(lookup: ExistingPostLookup): Promise<ExistingPost | null> {
    const token = await this.token();
    const channels = await this.get(`${API_BASE}/channels?part=contentDetails&mine=true`, token);
    assertOk("YOUTUBE", "channels.list", channels);
    const uploads = (channels.body as { items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] } | null)
      ?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) throw new Error("YouTube channel has no uploads playlist.");
    const items = await this.get(`${API_BASE}/playlistItems?part=snippet&maxResults=15&playlistId=${encodeURIComponent(uploads)}`, token);
    assertOk("YOUTUBE", "playlistItems.list", items);
    const expectedTitle = composeYouTubeMetadata({ title: lookup.title, caption: lookup.caption, hashtags: lookup.hashtags }).title;
    const list = (items.body as {
      items?: { snippet?: { title?: string; publishedAt?: string; resourceId?: { videoId?: string } } }[];
    } | null)?.items ?? [];
    const match = list.find(
      (i) =>
        i.snippet?.title === expectedTitle &&
        i.snippet.resourceId?.videoId &&
        (!i.snippet.publishedAt || new Date(i.snippet.publishedAt) >= lookup.since),
    );
    const videoId = match?.snippet?.resourceId?.videoId;
    return videoId ? { platformPostId: videoId, url: `https://www.youtube.com/shorts/${videoId}`, rawResponse: match } : null;
  }
}

type UploadSessionState = { complete: true; body: unknown } | { complete: false; offset: number };

/** `Range: bytes=0-12345` -> 12346; absent -> 0 (nothing persisted yet). */
export function nextOffsetFromRange(range: string | null): number {
  const match = range?.match(/bytes=\d+-(\d+)/);
  return match ? Number(match[1]) + 1 : 0;
}
