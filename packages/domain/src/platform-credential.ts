import type { PrismaClient, ContentPlatform } from "@prisma/client";
import { recordAudit } from "./audit";

/**
 * Persistence for `PlatformCredential` — one row per platform (spec §22: "encrypted token
 * storage for platform credentials, with refresh handling"). This file only ever handles the
 * *already-encrypted* strings: encryption/decryption and the OAuth refresh calls live in
 * packages/platforms (credential-store.ts), because packages/domain must not depend on
 * packages/platforms (see /docs/ARCHITECTURE.md's package boundaries) and token refresh is
 * real network I/O.
 *
 * Audit entries never contain token material — only platform, accountId, expiry, and the
 * non-secret metadata keys.
 */

export interface PlatformCredentialRowInput {
  platform: ContentPlatform;
  accountId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  expiresAt: Date | null;
  /** Non-secret only (scopes, username/display name, issuedAt, open_id). */
  metadata?: Record<string, unknown> | null;
}

export async function getPlatformCredentialRow(prisma: PrismaClient, platform: ContentPlatform) {
  return prisma.platformCredential.findUnique({ where: { platform } });
}

export async function upsertPlatformCredentialRow(
  prisma: PrismaClient,
  input: PlatformCredentialRowInput,
  actor: { actorId: string; actorType?: "HUMAN" | "SYSTEM" },
  options: { reason?: "CONNECTED" | "REFRESHED" } = {},
) {
  const row = await prisma.platformCredential.upsert({
    where: { platform: input.platform },
    create: {
      platform: input.platform,
      accountId: input.accountId,
      encryptedAccessToken: input.encryptedAccessToken,
      encryptedRefreshToken: input.encryptedRefreshToken,
      expiresAt: input.expiresAt,
      metadata: (input.metadata ?? undefined) as never,
    },
    update: {
      accountId: input.accountId,
      encryptedAccessToken: input.encryptedAccessToken,
      encryptedRefreshToken: input.encryptedRefreshToken,
      expiresAt: input.expiresAt,
      metadata: (input.metadata ?? undefined) as never,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: actor.actorType ?? "SYSTEM",
    action: options.reason === "REFRESHED" ? "PLATFORM_CREDENTIAL_REFRESHED" : "PLATFORM_CREDENTIAL_CONNECTED",
    entityType: "PlatformCredential",
    entityId: row.id,
    after: {
      platform: row.platform,
      accountId: row.accountId,
      expiresAt: row.expiresAt,
      hasRefreshToken: row.encryptedRefreshToken !== null,
    },
  });

  return row;
}

export async function deletePlatformCredentialRow(
  prisma: PrismaClient,
  platform: ContentPlatform,
  actor: { actorId: string },
): Promise<boolean> {
  const existing = await prisma.platformCredential.findUnique({ where: { platform } });
  if (!existing) return false;
  await prisma.platformCredential.delete({ where: { platform } });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "PLATFORM_CREDENTIAL_DISCONNECTED",
    entityType: "PlatformCredential",
    entityId: existing.id,
    before: { platform: existing.platform, accountId: existing.accountId },
  });
  return true;
}

export interface PlatformConnectionSummary {
  platform: ContentPlatform;
  connected: boolean;
  accountId: string | null;
  accountName: string | null;
  expiresAt: Date | null;
  expired: boolean;
  hasRefreshToken: boolean;
  scopes: string[];
  updatedAt: Date | null;
}

const ALL_PLATFORMS: ContentPlatform[] = ["INSTAGRAM", "TIKTOK", "YOUTUBE"];

/** Non-secret view for the Settings → Connections page. Never returns token material. */
export async function listPlatformConnectionSummaries(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<PlatformConnectionSummary[]> {
  const rows = await prisma.platformCredential.findMany();
  return ALL_PLATFORMS.map((platform) => {
    const row = rows.find((r) => r.platform === platform);
    if (!row) {
      return {
        platform,
        connected: false,
        accountId: null,
        accountName: null,
        expiresAt: null,
        expired: false,
        hasRefreshToken: false,
        scopes: [],
        updatedAt: null,
      };
    }
    const metadata = (row.metadata ?? {}) as { scopes?: unknown; accountName?: unknown; refreshExpiresAt?: unknown };
    return {
      platform,
      connected: true,
      accountId: row.accountId,
      accountName: typeof metadata.accountName === "string" ? metadata.accountName : null,
      expiresAt: row.expiresAt,
      // A refreshable credential past its access-token expiry is still usable (refreshed on
      // next use); "expired" here means "needs Chris to reconnect". Instagram has no separate
      // refresh token (the long-lived token refreshes itself while still valid), so an
      // expired Instagram token is always a reconnect.
      expired:
        (row.expiresAt !== null && row.expiresAt <= now && row.encryptedRefreshToken === null) ||
        (typeof metadata.refreshExpiresAt === "string" && new Date(metadata.refreshExpiresAt) <= now),
      hasRefreshToken: row.encryptedRefreshToken !== null,
      scopes: Array.isArray(metadata.scopes) ? metadata.scopes.filter((s): s is string => typeof s === "string") : [],
      updatedAt: row.updatedAt,
    };
  });
}
