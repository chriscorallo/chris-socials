import { describe, it, expect } from "vitest";
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  missingOAuthEnv,
  oauthRedirectUri,
  parsePlatformParam,
  OAuthError,
} from "../oauth";
import { createMockFetch } from "./mock-fetch";

const ENV = {
  APP_BASE_URL: "https://chris.example.com/",
  INSTAGRAM_APP_ID: "ig-app",
  INSTAGRAM_APP_SECRET: "ig-secret",
  GOOGLE_CLIENT_ID: "g-client",
  GOOGLE_CLIENT_SECRET: "g-secret",
  TIKTOK_CLIENT_KEY: "tt-key",
  TIKTOK_CLIENT_SECRET: "tt-secret",
  TOKEN_ENCRYPTION_KEY: "k",
};
const NOW = new Date("2026-10-16T12:00:00Z");

describe("OAuth authorization URLs", () => {
  it("Instagram (Instagram Login): business scopes, comma-separated, state, exact redirect", () => {
    const url = new URL(buildAuthorizationUrl("INSTAGRAM", { env: ENV, state: "s1" }));
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("ig-app");
    expect(url.searchParams.get("redirect_uri")).toBe("https://chris.example.com/api/oauth/instagram/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights,instagram_business_manage_comments",
    );
    expect(url.searchParams.get("state")).toBe("s1");
  });

  it("YouTube: offline access + forced consent so a refresh_token is always issued", () => {
    const url = new URL(buildAuthorizationUrl("YOUTUBE", { env: ENV, state: "s2" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
    );
  });

  it("TikTok: client_key + comma-separated scopes incl. video.upload (inbox) and video.list", () => {
    const url = new URL(buildAuthorizationUrl("TIKTOK", { env: ENV, state: "s3" }));
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(url.searchParams.get("client_key")).toBe("tt-key");
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.publish,video.upload,video.list");
  });

  it("missing configuration is reported by name and throws", () => {
    expect(missingOAuthEnv("YOUTUBE", { APP_BASE_URL: "x" })).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"]);
    expect(() => buildAuthorizationUrl("YOUTUBE", { env: {}, state: "s" })).toThrow(OAuthError);
    expect(() => oauthRedirectUri("TIKTOK", {})).toThrow(/APP_BASE_URL/);
  });

  it("parsePlatformParam accepts only the three platforms", () => {
    expect(parsePlatformParam("youtube")).toBe("YOUTUBE");
    expect(parsePlatformParam("facebook")).toBeNull();
  });
});

describe("exchangeAuthorizationCode", () => {
  it("Instagram: strips '#_', exchanges short -> long-lived (60d), resolves the professional account id", async () => {
    const mock = createMockFetch()
      .on("POST", "api.instagram.com/oauth/access_token", {
        data: [{ access_token: "short", user_id: "app-scoped", permissions: "instagram_business_basic,instagram_business_content_publish" }],
      })
      .on("GET", "grant_type=ig_exchange_token", { access_token: "long", token_type: "bearer", expires_in: 5183944 })
      .on("GET", "/me?fields=user_id,username", { user_id: "17841400000", username: "chris" });

    const tokens = await exchangeAuthorizationCode("INSTAGRAM", { code: "abc#_", env: ENV, fetchImpl: mock.fetchImpl, now: NOW });
    expect(new URLSearchParams(mock.calls[0]!.body as string).get("code")).toBe("abc");
    expect(mock.calls[1]!.url).toContain("client_secret=ig-secret");
    expect(tokens).toMatchObject({ accessToken: "long", refreshToken: null, accountId: "17841400000", accountName: "chris" });
    expect(tokens.scopes).toEqual(["instagram_business_basic", "instagram_business_content_publish"]);
    expect(tokens.expiresAt?.getTime()).toBe(NOW.getTime() + 5183944 * 1000);
    expect(tokens.metadata.issuedAt).toBe(NOW.toISOString());
  });

  it("YouTube: requires a refresh_token and resolves the channel", async () => {
    const mock = createMockFetch()
      .on("POST", "oauth2.googleapis.com/token", { access_token: "ya29", expires_in: 3599, refresh_token: "1//r", scope: "a b" })
      .on("GET", "/channels?part=snippet&mine=true", { items: [{ id: "UC123", snippet: { title: "Chris" } }] });
    const tokens = await exchangeAuthorizationCode("YOUTUBE", { code: "c", env: ENV, fetchImpl: mock.fetchImpl, now: NOW });
    expect(tokens).toMatchObject({ accessToken: "ya29", refreshToken: "1//r", accountId: "UC123", accountName: "Chris", scopes: ["a", "b"] });
    const form = new URLSearchParams(mock.calls[0]!.body as string);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe("https://chris.example.com/api/oauth/youtube/callback");

    const noRefresh = createMockFetch().on("POST", "oauth2.googleapis.com/token", { access_token: "ya29", expires_in: 3599 });
    await expect(exchangeAuthorizationCode("YOUTUBE", { code: "c", env: ENV, fetchImpl: noRefresh.fetchImpl })).rejects.toThrow(/refresh_token/);
  });

  it("TikTok: stores open_id and the 365d refresh expiry", async () => {
    const mock = createMockFetch()
      .on("POST", "/v2/oauth/token/", {
        access_token: "act.1",
        expires_in: 86400,
        open_id: "open-1",
        refresh_token: "rft.1",
        refresh_expires_in: 31536000,
        scope: "user.info.basic,video.publish",
        token_type: "Bearer",
      })
      .on("GET", "/v2/user/info/", { data: { user: { display_name: "Chris" } } });
    const tokens = await exchangeAuthorizationCode("TIKTOK", { code: "c", env: ENV, fetchImpl: mock.fetchImpl, now: NOW });
    expect(tokens).toMatchObject({ accessToken: "act.1", refreshToken: "rft.1", accountId: "open-1", accountName: "Chris" });
    expect(tokens.metadata.refreshExpiresAt).toBe(new Date(NOW.getTime() + 31536000 * 1000).toISOString());
    expect(new URLSearchParams(mock.calls[0]!.body as string).get("client_key")).toBe("tt-key");
  });

  it("surfaces the provider's error without leaking secrets", async () => {
    const mock = createMockFetch().on("POST", "/v2/oauth/token/", { error: "invalid_grant", error_description: "Authorization code is expired." }, { status: 400 });
    const err = await exchangeAuthorizationCode("TIKTOK", { code: "c", env: ENV, fetchImpl: mock.fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as Error).message).toContain("Authorization code is expired.");
    expect((err as Error).message).not.toContain("tt-secret");
  });
});

describe("refreshAccessToken", () => {
  it("YouTube keeps the existing refresh token when Google doesn't return a new one", async () => {
    const mock = createMockFetch().on("POST", "oauth2.googleapis.com/token", { access_token: "ya29.new", expires_in: 3600 });
    const out = await refreshAccessToken("YOUTUBE", { env: ENV, fetchImpl: mock.fetchImpl, now: NOW, accessToken: "old", refreshToken: "1//r" });
    expect(out).toMatchObject({ accessToken: "ya29.new", refreshToken: "1//r" });
    expect(new URLSearchParams(mock.calls[0]!.body as string).get("grant_type")).toBe("refresh_token");
  });

  it("TikTok stores a rotated refresh token", async () => {
    const mock = createMockFetch().on("POST", "/v2/oauth/token/", { access_token: "act.2", expires_in: 86400, refresh_token: "rft.2", refresh_expires_in: 31536000 });
    const out = await refreshAccessToken("TIKTOK", { env: ENV, fetchImpl: mock.fetchImpl, now: NOW, accessToken: "act.1", refreshToken: "rft.1" });
    expect(out.refreshToken).toBe("rft.2");
  });

  it("Instagram refreshes the long-lived token itself via ig_refresh_token", async () => {
    const mock = createMockFetch().on("GET", "refresh_access_token?grant_type=ig_refresh_token", { access_token: "long2", expires_in: 5184000 });
    const out = await refreshAccessToken("INSTAGRAM", { env: ENV, fetchImpl: mock.fetchImpl, now: NOW, accessToken: "long1", refreshToken: null });
    expect(out.accessToken).toBe("long2");
    expect(mock.calls[0]!.url).toContain("access_token=long1");
  });
});
