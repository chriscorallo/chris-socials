import {
  getPlatformCredentialRow,
  upsertPlatformCredentialRow,
  type PrismaClient,
} from "@chris/domain";
import type { Platform } from "./adapter";
import type { FetchLike } from "./http";
import { refreshAccessToken, type OAuthEnv, type OAuthTokenSet } from "./oauth";
import { decryptToken, encryptToken } from "./token-crypto";

/**
 * Encrypted credential storage + automatic refresh (spec §22). Adapters never hold a token
 * string: they call `getAccessToken(platform)` per request, which
 *   1. loads the PlatformCredential row (AES-256-GCM, TOKEN_ENCRYPTION_KEY),
 *   2. refreshes it when near expiry and persists the new tokens (audit-logged, no secrets),
 *   3. falls back to the legacy static env tokens (INSTAGRAM_ACCESS_TOKEN,
 *      YOUTUBE_ACCESS_TOKEN, TIKTOK_ACCESS_TOKEN) when no row exists — backward compatible
 *      with deployments configured before the OAuth flow existed.
 *
 * Refresh windows: YouTube (~1h tokens) and TikTok (24h) refresh within 5 minutes of expiry.
 * Instagram long-lived tokens (60d) refresh within 7 days of expiry, but only once the token is
 * ≥24h old (Meta's rule). A failed refresh of a still-valid token is tolerated (used as-is); a
 * failed refresh of an expired token throws a "reconnect" error that preflight surfaces.
 */
export const SHORT_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const INSTAGRAM_REFRESH_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;
export const INSTAGRAM_MIN_TOKEN_AGE_FOR_REFRESH_MS = 24 * 60 * 60 * 1000;

export interface DecryptedCredential {
  platform: Platform;
  accountId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  metadata: Record<string, unknown>;
}

export async function saveOAuthTokenSet(
  prisma: PrismaClient,
  platform: Platform,
  tokens: OAuthTokenSet,
  actor: { actorId: string; actorType?: "HUMAN" | "SYSTEM" },
): Promise<void> {
  await upsertPlatformCredentialRow(
    prisma,
    {
      platform,
      accountId: tokens.accountId,
      encryptedAccessToken: encryptToken(tokens.accessToken),
      encryptedRefreshToken: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt,
      metadata: tokens.metadata,
    },
    { actorId: actor.actorId, actorType: actor.actorType ?? "HUMAN" },
    { reason: "CONNECTED" },
  );
}

export async function loadDecryptedCredential(prisma: PrismaClient, platform: Platform): Promise<DecryptedCredential | null> {
  const row = await getPlatformCredentialRow(prisma, platform);
  if (!row) return null;
  return {
    platform,
    accountId: row.accountId,
    accessToken: decryptToken(row.encryptedAccessToken),
    refreshToken: row.encryptedRefreshToken ? decryptToken(row.encryptedRefreshToken) : null,
    expiresAt: row.expiresAt,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

export interface CredentialStoreOptions {
  prisma: PrismaClient;
  env?: OAuthEnv;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export class PlatformCredentialStore {
  private readonly env: OAuthEnv;
  private readonly now: () => Date;
  private readonly inFlight = new Map<Platform, Promise<DecryptedCredential>>();

  constructor(private readonly options: CredentialStoreOptions) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
  }

  private envFallback(platform: Platform): DecryptedCredential | null {
    const token =
      platform === "INSTAGRAM" ? this.env.INSTAGRAM_ACCESS_TOKEN : platform === "YOUTUBE" ? this.env.YOUTUBE_ACCESS_TOKEN : this.env.TIKTOK_ACCESS_TOKEN;
    if (!token) return null;
    const accountId = platform === "INSTAGRAM" ? (this.env.INSTAGRAM_IG_USER_ID ?? "") : "env";
    if (platform === "INSTAGRAM" && !accountId) return null;
    return { platform, accountId, accessToken: token, refreshToken: null, expiresAt: null, metadata: { source: "env" } };
  }

  needsRefresh(credential: DecryptedCredential): boolean {
    if (!credential.expiresAt) return false;
    const remaining = credential.expiresAt.getTime() - this.now().getTime();
    if (credential.platform === "INSTAGRAM") {
      const issuedAt = typeof credential.metadata.issuedAt === "string" ? new Date(credential.metadata.issuedAt) : null;
      const oldEnough = !issuedAt || this.now().getTime() - issuedAt.getTime() >= INSTAGRAM_MIN_TOKEN_AGE_FOR_REFRESH_MS;
      return remaining > 0 && remaining < INSTAGRAM_REFRESH_MARGIN_MS && oldEnough;
    }
    return remaining < SHORT_TOKEN_REFRESH_MARGIN_MS;
  }

  /** Returns a currently-valid credential (refreshed if needed), or null when not connected. */
  async getCredential(platform: Platform): Promise<DecryptedCredential | null> {
    const stored = await loadDecryptedCredential(this.options.prisma, platform);
    if (!stored) return this.envFallback(platform);
    if (!this.needsRefresh(stored)) {
      if (stored.expiresAt && stored.expiresAt <= this.now()) {
        throw new Error(`${platform} token expired — reconnect in Settings → Connections.`);
      }
      return stored;
    }
    const pending = this.inFlight.get(platform);
    if (pending) return pending;
    const refresh = this.refresh(stored).finally(() => this.inFlight.delete(platform));
    this.inFlight.set(platform, refresh);
    return refresh;
  }

  private async refresh(stored: DecryptedCredential): Promise<DecryptedCredential> {
    const now = this.now();
    try {
      const refreshed = await refreshAccessToken(stored.platform, {
        env: this.env,
        fetchImpl: this.options.fetchImpl,
        now,
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
      });
      const metadata: Record<string, unknown> = {
        ...stored.metadata,
        issuedAt: now.toISOString(),
        lastRefreshedAt: now.toISOString(),
        ...(refreshed.refreshExpiresAt ? { refreshExpiresAt: refreshed.refreshExpiresAt.toISOString() } : {}),
      };
      await upsertPlatformCredentialRow(
        this.options.prisma,
        {
          platform: stored.platform,
          accountId: stored.accountId,
          encryptedAccessToken: encryptToken(refreshed.accessToken),
          encryptedRefreshToken: refreshed.refreshToken ? encryptToken(refreshed.refreshToken) : null,
          expiresAt: refreshed.expiresAt,
          metadata,
        },
        { actorId: "system:credential-refresh", actorType: "SYSTEM" },
        { reason: "REFRESHED" },
      );
      return { ...stored, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken, expiresAt: refreshed.expiresAt, metadata };
    } catch (err) {
      if (stored.expiresAt && stored.expiresAt > now) return stored; // still valid; retry refresh next call
      throw new Error(
        `${stored.platform} token expired and refresh failed (${err instanceof Error ? err.message : String(err)}) — reconnect in Settings → Connections.`,
        { cause: err },
      );
    }
  }

  async getAccessToken(platform: Platform): Promise<string | null> {
    return (await this.getCredential(platform))?.accessToken ?? null;
  }

  async getInstagramAuth(): Promise<{ accessToken: string; igUserId: string } | null> {
    const credential = await this.getCredential("INSTAGRAM");
    return credential ? { accessToken: credential.accessToken, igUserId: credential.accountId } : null;
  }
}
