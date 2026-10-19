import type { PrismaClient, ContentPlatform, ContentState } from "@prisma/client";
import { validateMediaSpec, validatePackageText } from "./platform-limits";
import { renderPublishApproval } from "./quality-override";

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
  /** Optional per-account duration cap discovered live (TikTok creator_info's
   * `max_video_post_duration_sec`), tighter than the platform's static limit. */
  maxDurationSecondsOverride?: number;
}

/** States from which a publish attempt for a platform may run. PUBLISHED/MEASURING are
 * allowed only to retry a platform that has not yet succeeded (one platform failing after
 * another succeeded must not strand the failed one forever) — never a state regression. */
const PUBLISHABLE_STATES: ContentState[] = ["SCHEDULED", "PUBLISHING", "PUBLISHED", "MEASURING"];

export async function runPreflight(prisma: PrismaClient, input: PreflightInput): Promise<PreflightStatus> {
  const reasons: string[] = [];

  const item = await prisma.contentItem.findUnique({ where: { id: input.contentItemId } });
  if (!item) {
    return { status: "BLOCK", reasons: [`ContentItem ${input.contentItemId} does not exist.`] };
  }

  // Approval state / no active block: only SCHEDULED items should ever reach a publish
  // attempt — CANCELLED, QC_BLOCKED, or anything earlier in the pipeline is a hard block.
  if (!PUBLISHABLE_STATES.includes(item.currentState)) {
    reasons.push(
      `ContentItem is at ${item.currentState}, not SCHEDULED/PUBLISHING — not approved to publish.`,
    );
  } else if (item.currentState === "PUBLISHED" || item.currentState === "MEASURING") {
    const latest = await prisma.publication.findFirst({
      where: { contentItemId: input.contentItemId, platform: input.platform },
      orderBy: { createdAt: "desc" },
    });
    if (latest && (latest.status === "SUCCESS" || latest.status === "DRAFT")) {
      reasons.push(`${input.platform} already published for this item — nothing to retry.`);
    }
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
  } else {
    if (!render.storageKey) {
      reasons.push("Latest successful Render has no storageKey (file check).");
    }
    // Hard-gate requirement (spec §9 step 17 -> 21): the exact render being published must
    // have a QC report whose aggregate is PASS — or the OWNER's explicit, journaled override
    // for that exact render (technical gate passed; AI checks skipped by Chris — spec §5, the
    // owner outranks the gates; docs/decisions-pending/quality-override.md). Anything else
    // (no check, pending, BLOCKed, or a later AI check that BLOCKed after an override) is a
    // hard stop — never "probably fine". The latest record for this render is the one that
    // counts (a re-run after a repair supersedes an older one).
    const approval = await renderPublishApproval(prisma, render.id);
    if (!approval.ok) reasons.push(approval.reason);
    reasons.push(
      ...validateMediaSpec(
        input.platform,
        {
          durationSeconds: render.durationSeconds,
          width: render.width,
          height: render.height,
          fileSizeBytes: render.fileSizeBytes,
        },
        { maxDurationSeconds: input.maxDurationSecondsOverride },
      ),
    );
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
  } else {
    reasons.push(
      ...validatePackageText(input.platform, {
        caption: pkg.caption,
        title: pkg.title,
        hashtags: (pkg.hashtags as unknown as string[]) ?? [],
      }),
    );
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
