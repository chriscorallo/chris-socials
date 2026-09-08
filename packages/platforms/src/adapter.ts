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
}

export type PublishOutcome = "SUCCESS" | "FAILED" | "DRAFT";

export interface PublishResult {
  status: PublishOutcome;
  platformPostId: string | null;
  url: string | null;
  rawResponse: unknown;
  errorMessage?: string;
}

export interface VerifyResult {
  verified: boolean;
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
}

export class PlatformAdapterNotConfiguredError extends Error {
  constructor(platform: Platform, reason: string) {
    super(`${platform} adapter is not usable: ${reason}`);
    this.name = "PlatformAdapterNotConfiguredError";
  }
}
