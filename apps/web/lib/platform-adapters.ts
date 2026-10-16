import { createPlatformAdapters, type PlatformAdapter, type Platform } from "@chris/platforms";
import { prisma } from "@chris/domain";

/**
 * Real platform adapters backed by the encrypted PlatformCredential store (connected via
 * /settings/connections, auto-refreshed near expiry), falling back to legacy env tokens when
 * nothing is connected. Built per call, not cached: tokens are read fresh on every API call
 * anyway, and a module-level singleton would pin stale config across a reconnect.
 */
export function getPlatformAdapters(): Partial<Record<Platform, PlatformAdapter>> {
  return createPlatformAdapters({ prisma });
}
