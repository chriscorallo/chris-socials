import type { PrismaClient } from "@chris/domain";
import type { Platform, PlatformAdapter } from "./adapter";
import { PlatformCredentialStore } from "./credential-store";
import type { FetchLike } from "./http";
import { InstagramGraphAdapter } from "./instagram-adapter";
import { TikTokContentPostingAdapter, type TikTokPostMode } from "./tiktok-adapter";
import { YouTubeDataApiAdapter, type YouTubePrivacyStatus } from "./youtube-adapter";
import type { OAuthEnv } from "./oauth";

/**
 * The refresh-aware replacement for apps/web/lib/platform-adapters.ts's static-env factory.
 * Each adapter asks the credential store for a fresh token per call (DB row, auto-refreshed,
 * env-token fallback). Cheap to construct — safe to call per request.
 *
 * Env read here (all optional): TIKTOK_APP_AUDITED ("true" to enable public direct posts),
 * TIKTOK_POST_MODE ("INBOX" | "DIRECT"; default INBOX unless audited), YOUTUBE_PRIVACY_STATUS
 * ("public" | "unlisted" | "private"; default public), INSTAGRAM_GRAPH_API_VERSION (default
 * v25.0), plus the store's OAuth client env and legacy *_ACCESS_TOKEN fallbacks.
 */
export function createPlatformAdapters(input: {
  prisma: PrismaClient;
  env?: OAuthEnv;
  fetchImpl?: FetchLike;
  store?: PlatformCredentialStore;
}): Record<Platform, PlatformAdapter> {
  const env = input.env ?? process.env;
  const store = input.store ?? new PlatformCredentialStore({ prisma: input.prisma, env, fetchImpl: input.fetchImpl });
  const appAudited = env.TIKTOK_APP_AUDITED === "true";
  const postMode: TikTokPostMode | undefined =
    env.TIKTOK_POST_MODE === "DIRECT" || env.TIKTOK_POST_MODE === "INBOX" ? env.TIKTOK_POST_MODE : undefined;
  const privacy = env.YOUTUBE_PRIVACY_STATUS;
  const privacyStatus: YouTubePrivacyStatus = privacy === "unlisted" || privacy === "private" ? privacy : "public";

  return {
    INSTAGRAM: new InstagramGraphAdapter({
      getAuth: () => store.getInstagramAuth(),
      apiVersion: env.INSTAGRAM_GRAPH_API_VERSION,
      fetchImpl: input.fetchImpl,
    }),
    YOUTUBE: new YouTubeDataApiAdapter({
      getAccessToken: () => store.getAccessToken("YOUTUBE"),
      privacyStatus,
      fetchImpl: input.fetchImpl,
    }),
    TIKTOK: new TikTokContentPostingAdapter({
      getAccessToken: () => store.getAccessToken("TIKTOK"),
      appAudited,
      postMode: postMode ?? (appAudited ? "DIRECT" : "INBOX"),
      fetchImpl: input.fetchImpl,
    }),
  };
}
