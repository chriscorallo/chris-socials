/**
 * The one interface every platform adapter implements — spec §4/§21: "one platform's
 * limitation must never leak into the others." `apps/worker`'s publish job only ever talks to
 * this interface, never to a concrete Instagram/TikTok/YouTube client directly, so a platform
 * outage, an API change, or TikTok's audit-gated fallback are all contained inside one
 * adapter's implementation.
 */
export type Platform = "INSTAGRAM" | "TIKTOK" | "YOUTUBE";

export interface PublishRequest {
  contentItemId: string;
  /** Real video bytes — used directly by adapters that support binary/chunked upload
   * (YouTube's resumable upload, TikTok's FILE_UPLOAD flow). */
  videoBytes: Buffer;
  /** A real, publicly-fetchable URL for the same bytes — required by adapters whose only
   * publish path is "give us a URL and we'll fetch it" (Instagram Graph API's Content
   * Publishing API has no direct-binary-upload option; TikTok's PULL_FROM_URL flow is an
   * alternative to FILE_UPLOAD but still needs this for a verified domain). `null` when the
   * caller's storage adapter can't produce a real public URL — see
   * /docs/DECISIONS.md ("Instagram adapter needs a real public signed URL"); an adapter that
   * needs this and receives `null` returns a clear FAILED result rather than guessing. */
  publicVideoUrl: string | null;
  caption: string;
  title: string | null;
  hashtags: string[];
  coverFrameSeconds: number | null;
  /** Stable per (contentItemId, platform) — see packages/domain/src/publication.ts. Adapters
   * that support a native idempotency mechanism (e.g. an upload-session key) should use this
   * value for it; adapters that don't are still safe because packages/domain never calls
   * publish() twice for the same already-succeeded attempt. */
  idempotencyKey: string;
  /** Render duration, when known — lets an adapter enforce a live per-account cap (TikTok
   * creator_info `max_video_post_duration_sec`) before uploading. */
  durationSeconds?: number | null;
  /** Opaque adapter-specific state returned by a previous FAILED-but-resumable attempt (e.g.
   * an Instagram container id still processing). When present the adapter resumes instead of
   * re-uploading. */
  resumeToken?: unknown;
}

export type PublishOutcome = "SUCCESS" | "FAILED" | "DRAFT";

export interface PublishResult {
  status: PublishOutcome;
  platformPostId: string | null;
  url: string | null;
  rawResponse: unknown;
  errorMessage?: string;
  /** Set only with status FAILED when the platform holds resumable state (see
   * PublishRequest.resumeToken). The publish job persists it on the attempt row. */
  resumeToken?: unknown;
}

export interface VerifyResult {
  verified: boolean;
  rawResponse: unknown;
  /** The platform is still processing — not verified yet, but not a failure either. */
  pending?: boolean;
  /** The durable post id when it differs from what publish() returned (TikTok publish_id ->
   * video id). */
  resolvedPostId?: string | null;
  url?: string | null;
  /** A caveat a human should see (e.g. "uploaded but private"). */
  note?: string | null;
}

/** What a retry after an AMBIGUOUS attempt uses to look for a post that may already exist. */
export interface ExistingPostLookup {
  caption: string;
  title: string | null;
  hashtags: string[];
  /** Only posts created at/after this time are considered. */
  since: Date;
}

export interface ExistingPost {
  platformPostId: string;
  url: string | null;
  rawResponse: unknown;
}

export interface CredentialCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Every field nullable, on purpose — spec §23: "never fabricate an unavailable metric." Each
 * adapter fills in only what its platform's API genuinely returns and leaves the rest `null`;
 * see each adapter file's comment for exactly which fields that platform supports (verified
 * against live docs during Phase 6, not assumed — e.g. YouTube's Data API v3 returns no
 * watch-time/share/save metric at all).
 */
export interface PlatformMetrics {
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  saveCount: number | null;
  reach: number | null;
  avgWatchTimeSeconds: number | null;
  rawResponse: unknown;
}

export interface PlatformComment {
  platformCommentId: string;
  authorHandle: string | null;
  text: string;
  postedAt: Date | null;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  /** Cheap, no side effects — called by preflight (spec §21) before any publish attempt so a
   * missing/expired credential is reported clearly rather than surfacing as a confusing
   * publish failure. */
  checkCredentials(): Promise<CredentialCheckResult>;
  publish(request: PublishRequest): Promise<PublishResult>;
  /** A publish is not "done" until verified (spec §22) — a second, independent read against
   * the platform confirming the post actually exists. */
  verify(platformPostId: string): Promise<VerifyResult>;
  /** Spec §23 — Metric Snapshots. */
  getMetrics(platformPostId: string): Promise<PlatformMetrics>;
  /** Spec §24 — Audience Intelligence's raw material. */
  listComments(platformPostId: string): Promise<PlatformComment[]>;
  /** Optional: look up a post a previous AMBIGUOUS attempt may have created. Returns null when
   * nothing matches; throws when the platform can't be checked. Adapters that can't support
   * this simply don't implement it. */
  findExistingPost?(lookup: ExistingPostLookup): Promise<ExistingPost | null>;
  /** Optional: live, account-specific publish constraints for preflight. */
  getPublishConstraints?(): Promise<{ maxDurationSeconds?: number }>;
}

/** Async source of a currently-valid access token (refreshing if needed), or null when the
 * platform isn't connected. Called per request — never cache a token string in an adapter. */
export type AccessTokenProvider = () => Promise<string | null>;

/** A non-2xx platform response. Thrown by read paths (metrics, comments) so a 401 is never
 * mistaken for "no data" and persisted as a fake all-null snapshot. */
export class PlatformHttpError extends Error {
  constructor(
    public readonly platform: Platform,
    public readonly operation: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`${platform} ${operation} failed (HTTP ${status})${describePlatformError(body)}.`);
    this.name = "PlatformHttpError";
  }
}

/**
 * The publish request may have reached the platform but no response came back (timeout,
 * connection reset) during a step that commits the post. The publish job records the attempt
 * as AMBIGUOUS and a retry checks the platform before posting again.
 */
export class AmbiguousPublishError extends Error {
  constructor(
    public readonly platform: Platform,
    message: string,
    public readonly partialResponse: unknown = null,
  ) {
    super(message);
    this.name = "AmbiguousPublishError";
  }
}

/** Short, token-free summary of a platform error body for error messages. */
export function describePlatformError(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  const err = (b.error ?? b) as Record<string, unknown> | string;
  if (typeof err === "string") return `: ${err.slice(0, 200)}`;
  const message = err.message ?? err.error_description ?? err.error_message ?? b.error_description;
  const code = err.code ?? err.status ?? err.type;
  const parts = [code !== undefined ? String(code) : null, typeof message === "string" ? message : null].filter(Boolean);
  return parts.length > 0 ? `: ${parts.join(" — ").slice(0, 200)}` : "";
}

export class PlatformAdapterNotConfiguredError extends Error {
  constructor(platform: Platform, reason: string) {
    super(`${platform} adapter is not usable: ${reason}`);
    this.name = "PlatformAdapterNotConfiguredError";
  }
}
