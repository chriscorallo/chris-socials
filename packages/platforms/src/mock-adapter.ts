import type {
  Platform,
  PlatformAdapter,
  PublishRequest,
  PublishResult,
  VerifyResult,
  CredentialCheckResult,
  PlatformMetrics,
  PlatformComment,
} from "./adapter";

/**
 * Deterministic, zero-cost adapter for tests — the platform-adapter equivalent of
 * MockModelProvider. Configurable per-instance behavior (not hardcoded always-success) so a
 * single test file can exercise success, failure, and TikTok's draft outcome without a real
 * network call. Records every call so tests can assert idempotent retries didn't actually
 * re-call the adapter.
 */
export class MockPlatformAdapter implements PlatformAdapter {
  public readonly publishCalls: PublishRequest[] = [];
  public readonly verifyCalls: string[] = [];
  public readonly getMetricsCalls: string[] = [];
  public readonly listCommentsCalls: string[] = [];

  constructor(
    public readonly platform: Platform,
    private readonly behavior: {
      credentialsOk?: boolean;
      publishResult?: PublishResult | ((request: PublishRequest) => PublishResult);
      metricsResult?: PlatformMetrics | ((platformPostId: string) => PlatformMetrics);
      commentsResult?: PlatformComment[] | ((platformPostId: string) => PlatformComment[]);
    } = {},
  ) {}

  async checkCredentials(): Promise<CredentialCheckResult> {
    return this.behavior.credentialsOk === false
      ? { ok: false, reason: "Mock credentials configured as not-ok for this test." }
      : { ok: true };
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    this.publishCalls.push(request);
    if (typeof this.behavior.publishResult === "function") {
      return this.behavior.publishResult(request);
    }
    return (
      this.behavior.publishResult ?? {
        status: "SUCCESS",
        platformPostId: `mock-${this.platform.toLowerCase()}-${this.publishCalls.length}`,
        url: `https://example.invalid/${this.platform.toLowerCase()}/mock-${this.publishCalls.length}`,
        rawResponse: { mock: true },
      }
    );
  }

  async verify(platformPostId: string): Promise<VerifyResult> {
    this.verifyCalls.push(platformPostId);
    return { verified: true, rawResponse: { mock: true, platformPostId } };
  }

  async getMetrics(platformPostId: string): Promise<PlatformMetrics> {
    this.getMetricsCalls.push(platformPostId);
    if (typeof this.behavior.metricsResult === "function") {
      return this.behavior.metricsResult(platformPostId);
    }
    return (
      this.behavior.metricsResult ?? {
        viewCount: 100,
        likeCount: 10,
        commentCount: 2,
        shareCount: 1,
        saveCount: null,
        reach: null,
        avgWatchTimeSeconds: null,
        rawResponse: { mock: true },
      }
    );
  }

  async listComments(platformPostId: string): Promise<PlatformComment[]> {
    this.listCommentsCalls.push(platformPostId);
    if (typeof this.behavior.commentsResult === "function") {
      return this.behavior.commentsResult(platformPostId);
    }
    return this.behavior.commentsResult ?? [];
  }
}
