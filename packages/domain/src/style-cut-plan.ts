import type { ContentState, PrismaClient } from "@prisma/client";
import { recordAudit } from "./audit";
import { STARTER_EDIT_ORIGIN } from "./starter-edit";
import { getLatestEditPlan, saveFinishingEdit } from "./edit-plan";

/**
 * Persistence for the "Style cut" (packages/media style-cut.ts — the cut itself is pure and
 * computed by the worker; this module only decides WHETHER a cut may be written and writes it
 * through the normal append-only EditPlan path). See docs/decisions-pending/style-cut.md.
 *
 * Two writers:
 *  - AUTO (system, after captions / face tracking land): only while the item is EDIT_PLANNED
 *    and its latest plan is still untouched — the original no-AI starter edit, or an earlier
 *    AUTO style cut. Anything Chris saved (a finishing edit, a manual re-apply, "plain full
 *    take") is his and is never replaced. Compare-and-swap on the latest plan id under an
 *    advisory lock, so two triggers racing can't write twice. Idempotent: same inputsKey →
 *    no new row.
 *  - CHRIS (editor buttons "Re-apply style cut" / "Use the plain full take"): a finishing edit
 *    via saveFinishingEdit (state rollback rules included), each a new version.
 */

export const STYLE_CUT_AUTO_REASON = "Style cut (automatic, no AI)";

/** What a plan row's `plan.styleCut` holds (JSON; written by the worker). */
export interface StoredStyleCut {
  version: number;
  origin: "AUTO" | "CHRIS";
  inputsKey: string;
  summary: string;
  profileNote: string;
  stats: Record<string, unknown>;
  target: Record<string, unknown>;
  /** Measured silences (s) — cached so a re-apply needn't decode the take again. */
  silences?: Array<{ start: number; end: number }> | null;
  /** The take cut (the first part, for a multi-part recording). */
  mediaAssetId: string;
  /** Multi-part recording: every part, in order, and each part's measured silences. */
  mediaAssetIds?: string[];
  silencesByAsset?: Record<string, Array<{ start: number; end: number }> | null>;
}

export function readStoredStyleCut(plan: unknown): StoredStyleCut | null {
  const sc = (plan as { styleCut?: unknown } | null)?.styleCut;
  if (!sc || typeof sc !== "object") return null;
  const s = sc as Partial<StoredStyleCut>;
  return typeof s.inputsKey === "string" && typeof s.summary === "string" ? (s as StoredStyleCut) : null;
}

export type StyleCutEligibility =
  | { eligible: true; latestPlanId: string; replaces: "STARTER" | "AUTO_STYLE_CUT"; currentKey: string | null }
  | { eligible: false; reason: string };

/** Pure: may an AUTOMATIC style cut replace this item's latest plan? */
export function autoStyleCutEligibility(
  state: ContentState,
  latest: { id: string; plan: unknown; revisionReason: string | null } | null,
): StyleCutEligibility {
  if (!latest) return { eligible: false, reason: "No edit yet." };
  if (state !== "EDIT_PLANNED") return { eligible: false, reason: `Not while the video is ${state}.` };
  const plan = (latest.plan ?? {}) as Record<string, unknown>;
  const sc = readStoredStyleCut(plan);
  if (sc && sc.origin === "AUTO" && latest.revisionReason === STYLE_CUT_AUTO_REASON) {
    return { eligible: true, latestPlanId: latest.id, replaces: "AUTO_STYLE_CUT", currentKey: sc.inputsKey };
  }
  if (plan.origin === STARTER_EDIT_ORIGIN && plan.timeline == null && latest.revisionReason == null) {
    return { eligible: true, latestPlanId: latest.id, replaces: "STARTER", currentKey: null };
  }
  return { eligible: false, reason: "You've edited this video — your edit is kept." };
}

export class StyleCutConflictError extends Error {
  constructor() {
    super("The edit changed while the style cut was being made — nothing was replaced.");
    this.name = "StyleCutConflictError";
  }
}

/**
 * Writes an AUTO style cut as a new EditPlan version (no state transition: EDIT_PLANNED stays
 * EDIT_PLANNED, the next render reads the latest plan). Returns null (and writes nothing) when
 * the item is no longer eligible, the latest plan isn't `expectedLatestPlanId`, or the cut is
 * identical to the current AUTO one.
 */
export async function recordAutoStyleCut(
  prisma: PrismaClient,
  input: {
    contentItemId: string;
    expectedLatestPlanId: string;
    timeline: unknown;
    durationSeconds: number;
    styleCut: StoredStyleCut;
  },
  actor: { actorId: string },
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`style-cut:${input.contentItemId}`}))::text AS locked`;
    const item = await tx.contentItem.findUniqueOrThrow({ where: { id: input.contentItemId }, select: { currentState: true } });
    const latest = await tx.editPlan.findFirst({ where: { contentItemId: input.contentItemId }, orderBy: { createdAt: "desc" } });
    const elig = autoStyleCutEligibility(item.currentState, latest);
    if (!elig.eligible || !latest || latest.id !== input.expectedLatestPlanId) return null;
    if (elig.currentKey === input.styleCut.inputsKey) return null;
    const basePlan = (latest.plan ?? {}) as Record<string, unknown>;
    const editPlan = await tx.editPlan.create({
      data: {
        contentItemId: input.contentItemId,
        takeSelectionId: latest.takeSelectionId,
        productionTier: latest.productionTier,
        targetDurationSeconds: Math.max(0.1, input.durationSeconds),
        doNothingElse: false,
        plan: { ...basePlan, timeline: input.timeline, styleCut: { ...input.styleCut, origin: "AUTO" } } as never,
        revisionOfEditPlanId: null,
        revisionReason: STYLE_CUT_AUTO_REASON,
      },
    });
    await recordAudit(tx, {
      actor: actor.actorId,
      actorType: "SYSTEM",
      action: "EDIT_PLAN_REPLANNED",
      entityType: "ContentItem",
      entityId: input.contentItemId,
      before: { editPlanId: latest.id },
      after: { editPlanId: editPlan.id, revisionReason: STYLE_CUT_AUTO_REASON, styleCut: input.styleCut.summary, inputsKey: input.styleCut.inputsKey },
    });
    return editPlan;
  });
}

/**
 * Chris's editor buttons: saves `timeline` as a finishing edit (new version, normal rollback
 * rules) with `plan.styleCut` set (re-apply) or cleared (plain full take).
 */
export async function saveStyleCutChoice(
  prisma: PrismaClient,
  input: {
    contentItemId: string;
    timeline: unknown;
    durationSeconds: number;
    actorId: string;
    styleCut: StoredStyleCut | null;
  },
) {
  return saveFinishingEdit(prisma, {
    contentItemId: input.contentItemId,
    timeline: input.timeline,
    durationSeconds: input.durationSeconds,
    actorId: input.actorId,
    note: input.styleCut ? `Style cut — ${input.styleCut.summary}` : "Plain full take (style cut off)",
    planExtras: { styleCut: input.styleCut ? { ...input.styleCut, origin: "CHRIS" } : null },
  });
}

/** The latest plan's stored style cut (for the editor's summary line). */
export async function getCurrentStyleCut(prisma: PrismaClient, contentItemId: string) {
  const latest = await getLatestEditPlan(prisma, contentItemId);
  return latest ? readStoredStyleCut(latest.plan) : null;
}
