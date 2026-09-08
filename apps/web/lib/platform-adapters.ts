import {
  InstagramGraphAdapter,
  YouTubeDataApiAdapter,
  TikTokContentPostingAdapter,
  type PlatformAdapter,
  type Platform,
} from "@chris/platforms";

/**
 * Real adapters, built from environment credentials — same "ready the moment configured"
 * pattern as lib/model-provider.ts. No PlatformCredential DB rows are read here yet (a full
 * OAuth-token-refresh flow is a documented future enhancement — see .env.example /
 * /docs/DECISIONS.md); credentials come directly from env vars for now.
 */
let instance: Partial<Record<Platform, PlatformAdapter>> | undefined;

export function getPlatformAdapters(): Partial<Record<Platform, PlatformAdapter>> {
  if (!instance) {
    const instagramToken = process.env.INSTAGRAM_ACCESS_TOKEN;
    const instagramUserId = process.env.INSTAGRAM_IG_USER_ID;
    const youtubeToken = process.env.YOUTUBE_ACCESS_TOKEN;
    const tiktokToken = process.env.TIKTOK_ACCESS_TOKEN;

    instance = {
      INSTAGRAM: new InstagramGraphAdapter(
        instagramToken && instagramUserId ? { accessToken: instagramToken, igUserId: instagramUserId } : null,
      ),
      YOUTUBE: new YouTubeDataApiAdapter(youtubeToken ? { accessToken: youtubeToken } : null),
      TIKTOK: new TikTokContentPostingAdapter(
        tiktokToken
          ? { accessToken: tiktokToken, appAudited: process.env.TIKTOK_APP_AUDITED === "true" }
          : null,
      ),
    };
  }
  return instance;
}
