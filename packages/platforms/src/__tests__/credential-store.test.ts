import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prisma, listPlatformConnectionSummaries } from "@chris/domain";
import { PlatformCredentialStore, saveOAuthTokenSet, loadDecryptedCredential } from "../credential-store";
import { createPlatformAdapters } from "../factory";
import { createMockFetch } from "./mock-fetch";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ENV = {
  GOOGLE_CLIENT_ID: "g",
  GOOGLE_CLIENT_SECRET: "gs",
  TIKTOK_CLIENT_KEY: "t",
  TIKTOK_CLIENT_SECRET: "ts",
  APP_BASE_URL: "https://chris.example.com",
};

/** PlatformCredential is one global row per platform — every test starts from a clean table
 * (this suite runs against the throwaway test database only). */
async function clearCredentials() {
  await prisma.platformCredential.deleteMany({});
}

describe("PlatformCredentialStore (encrypted at rest, auto-refresh)", () => {
  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "test-only-encryption-key-do-not-use-in-prod";
  });
  beforeEach(clearCredentials);
  afterAll(clearCredentials);

  it("stores tokens encrypted — the DB row never contains the plaintext — and round-trips them", async () => {
    await saveOAuthTokenSet(
      prisma,
      "YOUTUBE",
      { accessToken: "ya29.secret", refreshToken: "1//refresh-secret", expiresAt: new Date(Date.now() + HOUR), accountId: "UC1", accountName: "Chris", scopes: ["s"], metadata: { scopes: ["s"], accountName: "Chris" } },
      { actorId: "chris" },
    );
    const row = await prisma.platformCredential.findUniqueOrThrow({ where: { platform: "YOUTUBE" } });
    expect(row.encryptedAccessToken).not.toContain("ya29.secret");
    expect(row.encryptedRefreshToken).not.toContain("refresh-secret");
    const loaded = await loadDecryptedCredential(prisma, "YOUTUBE");
    expect(loaded).toMatchObject({ accessToken: "ya29.secret", refreshToken: "1//refresh-secret", accountId: "UC1" });

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: row.id, action: "PLATFORM_CREDENTIAL_CONNECTED" } });
    expect(JSON.stringify(audit)).not.toContain("ya29.secret");

    const summaries = await listPlatformConnectionSummaries(prisma);
    expect(summaries.find((s) => s.platform === "YOUTUBE")).toMatchObject({ connected: true, accountName: "Chris", hasRefreshToken: true, expired: false });
    expect(summaries.find((s) => s.platform === "TIKTOK")).toMatchObject({ connected: false });
  });

  it("YouTube: refreshes a token about to expire, persists the new one, and doesn't refresh a fresh one", async () => {
    await saveOAuthTokenSet(
      prisma,
      "YOUTUBE",
      { accessToken: "old", refreshToken: "1//r", expiresAt: new Date(Date.now() + 60 * 1000), accountId: "UC1", accountName: null, scopes: [], metadata: {} },
      { actorId: "chris" },
    );
    const mock = createMockFetch().on("POST", "oauth2.googleapis.com/token", { access_token: "new", expires_in: 3600 });
    const store = new PlatformCredentialStore({ prisma, env: ENV, fetchImpl: mock.fetchImpl });

    expect(await store.getAccessToken("YOUTUBE")).toBe("new");
    expect(mock.calls).toHaveLength(1);
    const stored = await loadDecryptedCredential(prisma, "YOUTUBE");
    expect(stored?.accessToken).toBe("new");
    expect(stored?.refreshToken).toBe("1//r");
    expect(stored!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
    expect(await prisma.auditLog.count({ where: { action: "PLATFORM_CREDENTIAL_REFRESHED" } })).toBeGreaterThan(0);

    expect(await store.getAccessToken("YOUTUBE")).toBe("new");
    expect(mock.calls).toHaveLength(1); // still fresh — no second refresh
  });

  it("TikTok: persists a rotated refresh token", async () => {
    await saveOAuthTokenSet(
      prisma,
      "TIKTOK",
      { accessToken: "act.1", refreshToken: "rft.1", expiresAt: new Date(Date.now() - 1000), accountId: "open-1", accountName: null, scopes: [], metadata: {} },
      { actorId: "chris" },
    );
    const mock = createMockFetch().on("POST", "/v2/oauth/token/", { access_token: "act.2", expires_in: 86400, refresh_token: "rft.2", refresh_expires_in: 31536000 });
    const store = new PlatformCredentialStore({ prisma, env: ENV, fetchImpl: mock.fetchImpl });
    expect(await store.getAccessToken("TIKTOK")).toBe("act.2");
    expect((await loadDecryptedCredential(prisma, "TIKTOK"))?.refreshToken).toBe("rft.2");
  });

  it("Instagram: refreshes inside the 7-day window only once the token is ≥24h old", async () => {
    const now = new Date();
    await saveOAuthTokenSet(
      prisma,
      "INSTAGRAM",
      { accessToken: "long1", refreshToken: null, expiresAt: new Date(now.getTime() + 3 * DAY), accountId: "1784", accountName: "chris", scopes: [], metadata: { issuedAt: new Date(now.getTime() - 2 * HOUR).toISOString() } },
      { actorId: "chris" },
    );
    const mock = createMockFetch().on("GET", "ig_refresh_token", { access_token: "long2", expires_in: 5184000 });
    const young = new PlatformCredentialStore({ prisma, env: ENV, fetchImpl: mock.fetchImpl });
    expect(await young.getInstagramAuth()).toEqual({ accessToken: "long1", igUserId: "1784" });
    expect(mock.calls).toHaveLength(0);

    const later = new PlatformCredentialStore({ prisma, env: ENV, fetchImpl: mock.fetchImpl, now: () => new Date(now.getTime() + DAY) });
    expect(await later.getInstagramAuth()).toEqual({ accessToken: "long2", igUserId: "1784" });
    expect(mock.calls).toHaveLength(1);
  });

  it("a failed refresh of a still-valid token falls back to it; of an expired token, asks to reconnect", async () => {
    await saveOAuthTokenSet(
      prisma,
      "YOUTUBE",
      { accessToken: "still-valid", refreshToken: "1//r", expiresAt: new Date(Date.now() + 2 * 60 * 1000), accountId: "UC1", accountName: null, scopes: [], metadata: {} },
      { actorId: "chris" },
    );
    const failing = createMockFetch().on("POST", "oauth2.googleapis.com/token", { error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 });
    const store = new PlatformCredentialStore({ prisma, env: ENV, fetchImpl: failing.fetchImpl });
    expect(await store.getAccessToken("YOUTUBE")).toBe("still-valid");

    const expiredStore = new PlatformCredentialStore({ prisma, env: ENV, fetchImpl: failing.fetchImpl, now: () => new Date(Date.now() + HOUR) });
    await expect(expiredStore.getAccessToken("YOUTUBE")).rejects.toThrow(/reconnect in Settings → Connections/);
  });

  it("falls back to legacy env tokens when no credential row exists", async () => {
    const store = new PlatformCredentialStore({
      prisma,
      env: { YOUTUBE_ACCESS_TOKEN: "env-yt", INSTAGRAM_ACCESS_TOKEN: "env-ig", INSTAGRAM_IG_USER_ID: "99" },
    });
    expect(await store.getAccessToken("YOUTUBE")).toBe("env-yt");
    expect(await store.getInstagramAuth()).toEqual({ accessToken: "env-ig", igUserId: "99" });
    expect(await store.getAccessToken("TIKTOK")).toBeNull();
  });

  it("createPlatformAdapters wires the store end-to-end: the YouTube adapter sends the refreshed token", async () => {
    await saveOAuthTokenSet(
      prisma,
      "YOUTUBE",
      { accessToken: "expired", refreshToken: "1//r", expiresAt: new Date(Date.now() - 1000), accountId: "UC1", accountName: null, scopes: [], metadata: {} },
      { actorId: "chris" },
    );
    const mock = createMockFetch()
      .on("POST", "oauth2.googleapis.com/token", { access_token: "fresh", expires_in: 3600 })
      .on("GET", "/youtube/v3/channels?part=id", { items: [{ id: "UC1" }] });
    const adapters = createPlatformAdapters({ prisma, env: ENV, fetchImpl: mock.fetchImpl });
    expect(await adapters.YOUTUBE.checkCredentials()).toEqual({ ok: true });
    expect(mock.callsTo("/channels")[0]!.headers["authorization"]).toBe("Bearer fresh");
    expect(await adapters.TIKTOK.checkCredentials()).toMatchObject({ ok: false });
  });
});
