import type { PrismaClient, ContentPlatform } from "@prisma/client";

/**
 * Spec §9 step 21 — "verifies file/version/hash, credentials, account, packaging, schedule,
 * media spec, approval state, no active block, idempotency key." Deterministic code, not an
 * agent — every one of these is a real yes/no fact derivable from the database (or, for
 * credentials, from a caller-supplied check — see below), never a judgment call. Per
 * CLAUDE.md's "prefer deterministic code over LLM judgment when the check is actually
 * deterministic."
 *
 * Runs once per (ContentItem, platform) target, immediately before `apps/worker`'s publish job
 * would call that platform's adapter — a BLOCK here means that platform is skipped for this
 * run (recorded as a FAILED Publication with the block reasons) without ever making a network
 * call, while other platforms still proceed (spec §21 graceful failure).
 *
 * Credential checking itself can't happen inside packages/domain — adapters live in
 * packages/platforms, and packages/domain must not depend on it (same rule as domain never
 * depending on packages/agents; see /docs/ARCHITECTURE.md's package boundaries). The caller
 * (apps/worker, which depends on both) runs `adapter.checkCredentials()` and passes the result
 * in.
 */
export type PreflightStatus = { status: "PASS" } | { status: "BLOCK"; reasons: string[] };

export interface PreflightInput {
  contentItemId: string;
  platform: ContentPlatform;
  credentialsOk: boolean;
  credentialsReason?: string;
  /** A real hash of the exact render bytes about to be published — computed by the caller
   * (which has the actual file), not by this function. Its presence (not its exact value) is
   * what preflight checks; the value itself becomes part of the Publication record for later
   * audit (spec §22: "media hash"). */
  mediaHash: string | null;
}

export async function runPreflight(prisma: PrismaClient, input: PreflightInput): Promise<PreflightStatus> {
  const reasons: string[] = [];

  const item = await prisma.contentItem.findUnique({ where: { id: input.contentItemId } });
  if (!item) {
    return { status: "BLOCK", reasons: [`ContentItem ${input.contentItemId} does not exist.`] };
  }

  // Approval state / no active block: only SCHEDULED items should ever reach a publish
  // attempt — CANCELLED, QC_BLOCKED, or anything earlier in the pipeline is a hard block.
  if (item.currentState !== "SCHEDULED" && item.currentState !== "PUBLISHING") {
    reasons.push(
      `ContentItem is at ${item.currentState}, not SCHEDULED/PUBLISHING — not approved to publish.`,
    );
  }

  const schedule = await prisma.scheduleEntry.findUnique({ where: { contentItemId: input.contentItemId } });
  if (!schedule) {
    reasons.push("No ScheduleEntry found.");
  } else {
    const targets = schedule.targetPlatforms as unknown as string[];
    if (!Array.isArray(targets) || !targets.includes(input.platform)) {
      reasons.push(`${input.platform} is not in this item's scheduled target platforms.`);
    }
  }

  const render = await prisma.render.findFirst({
    where: { contentItemId: input.contentItemId, status: "SUCCESS" },
    orderBy: { createdAt: "desc" },
  });
  if (!render) {
    reasons.push("No successful Render found — nothing to publish (file/version check).");
  } else if (!render.storageKey) {
    reasons.push("Latest successful Render has no storageKey (file check).");
  }
  if (!input.mediaHash) {
    reasons.push("No media hash computed for the render (hash check).");
  }

  const pkg = await prisma.platformPackage.findFirst({
    where: { contentItemId: input.contentItemId, platform: input.platform },
    orderBy: { createdAt: "desc" },
  });
  if (!pkg) {
    reasons.push(`No PlatformPackage recorded for ${input.platform} (packaging check).`);
  }

  if (!input.credentialsOk) {
    reasons.push(input.credentialsReason ?? `${input.platform} credentials are not configured/valid.`);
  }

  if (reasons.length > 0) {
    return { status: "BLOCK", reasons };
  }
  return { status: "PASS" };
}

/** Stable per (ContentItem, platform) — see /docs/DECISIONS.md's idempotent-publish design.
 * Every retry of "publish this item to this platform" computes the same key, which is what
 * lets packages/domain/src/publication.ts recognize "we already succeeded here" without a
 * caller-managed retry token. */
export function computePublishIdempotencyKey(contentItemId: string, platform: ContentPlatform): string {
  return `${contentItemId}:${platform}`;
}
