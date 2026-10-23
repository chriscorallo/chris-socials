import type { ContentState, PrismaClient } from "@prisma/client";
import { recordAudit } from "./audit";
import { STARTER_EDIT_ORIGIN } from "./starter-edit";
import { getLatestEditPlan, saveFinishingEdit } from "./edit-plan";
import { setFlag } from "./feature-flags";

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
  /** Loudness envelope + the splice engine's voice analysis, cached with the silences. */
  envelope?: { frameS: number; db: number[] } | null;
  splice?: unknown | null;
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

// ---------------------------------------------------------------------------------------
// Full edit (free) — docs/decisions-pending/full-edit.md. Same writers, same rules: AUTO only
// over an untouched starter edit (or an earlier AUTO cut/full edit); Chris's choices are
// finishing edits (new versions).
// ---------------------------------------------------------------------------------------

export const FULL_EDIT_AUTO_REASON = "Full edit (automatic, no AI)";

/**
 * A plan row Chris cut by hand in the editor — not one the editor's buttons or a bot saved under
 * his name ("Try another hook", "Cuts only", plain take, "Design visuals with AI"). The golden-set
 * harness learns splices from these (docs/PREMIUM_EDITOR_HANDOFF.md §3.1).
 */
export function isHandEditReason(reason: string | null | undefined): boolean {
  if (!reason?.startsWith("Finishing edit by Chris")) return false;
  const note = reason.slice("Finishing edit by Chris".length).replace(/^:\s*/, "");
  return !/^(Full edit —|Style cut —|Plain full take|Watch-back fixes)/.test(note) && !note.includes("(Design visuals with AI)");
}

/** Feature flag: ON = new uploads get "Cuts only"; OFF/absent (default) = "Full edit". */
export const AUTO_EDIT_CUTS_ONLY_FLAG = "auto_edit.cuts_only";
/** On: new uploads get the AI Editor's cut (2026-10-23: opt-in — the free Full edit is the
 * default again until the Editor beats it on the golden set, judged by watching). */
export const AUTO_EDIT_EDITOR_FLAG = "auto_edit.editor";
/** Kept for older rows/settings: on = the free Full edit (now the default anyway). */
export const AUTO_EDIT_NO_EDITOR_FLAG = "auto_edit.no_editor";

/** EDITOR = the AI Editor writes the cut (default; falls back to FULL without AI credit);
 * FULL = the free heuristic Full edit; CUTS = pauses out only. */
export type AutoEditMode = "EDITOR" | "FULL" | "CUTS";

/** What a plan row's `plan.fullEdit` holds (JSON; written by the worker). */
export interface StoredFullEdit {
  version: number;
  origin: "AUTO" | "CHRIS";
  inputsKey: string;
  summary: string;
  /** media full-edit FullEditReport (hook candidates, removed lines, graphics, checks…). */
  report: Record<string, unknown>;
  /** The choices it was built with (hook index, restored lines, removed graphics). */
  choices: Record<string, unknown>;
  mediaAssetId: string;
  /** Measured silences + loudness envelope — cached so "Try another hook" needn't decode again. */
  silences?: Array<{ start: number; end: number }> | null;
  envelope?: { frameS: number; db: number[] } | null;
  /** The splice engine's voice analysis (packages/media splice/analysis.ts SpliceAnalysis). */
  splice?: unknown | null;
}

export function readStoredFullEdit(plan: unknown): StoredFullEdit | null {
  const fe = (plan as { fullEdit?: unknown } | null)?.fullEdit;
  if (!fe || typeof fe !== "object") return null;
  const f = fe as Partial<StoredFullEdit>;
  return typeof f.inputsKey === "string" && typeof f.summary === "string" && f.report && typeof f.report === "object" ? (f as StoredFullEdit) : null;
}

/** Which automatic edit new uploads get (Chris's setting; default the AI Editor's cut). */
export async function getAutoEditMode(prisma: PrismaClient): Promise<AutoEditMode> {
  const [cuts, editor] = await Promise.all([
    prisma.featureFlag.findUnique({ where: { key: AUTO_EDIT_CUTS_ONLY_FLAG } }),
    prisma.featureFlag.findUnique({ where: { key: AUTO_EDIT_EDITOR_FLAG } }),
  ]);
  if (cuts?.enabled) return "CUTS";
  return editor?.enabled ? "EDITOR" : "FULL";
}

export async function setAutoEditMode(prisma: PrismaClient, mode: AutoEditMode, actorId: string): Promise<void> {
  await setFlag(prisma, {
    key: AUTO_EDIT_CUTS_ONLY_FLAG,
    enabled: mode === "CUTS",
    description: "New uploads get the Cuts-only style cut instead of an edit (default off).",
    actor: actorId,
    actorType: "HUMAN",
  });
  await setFlag(prisma, {
    key: AUTO_EDIT_EDITOR_FLAG,
    enabled: mode === "EDITOR",
    description: "New uploads get the AI Editor's cut instead of the free Full edit (default off = Full edit).",
    actor: actorId,
    actorType: "HUMAN",
  });
}

export type StyleCutEligibility =
  | { eligible: true; latestPlanId: string; replaces: "STARTER" | "AUTO_STYLE_CUT" | "AUTO_FULL_EDIT"; currentKey: string | null }
  | { eligible: false; reason: string };

/** Pure: may an AUTOMATIC style cut / full edit replace this item's latest plan? */
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
  const fe = readStoredFullEdit(plan);
  if (fe && fe.origin === "AUTO" && latest.revisionReason === FULL_EDIT_AUTO_REASON) {
    return { eligible: true, latestPlanId: latest.id, replaces: "AUTO_FULL_EDIT", currentKey: fe.inputsKey };
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
  return recordAutoEdit(prisma, { ...input, fullEdit: null }, actor);
}

/** The AUTO full edit: same rules as the AUTO style cut (eligibility, CAS, lock, idempotency). */
export async function recordAutoFullEdit(
  prisma: PrismaClient,
  input: {
    contentItemId: string;
    expectedLatestPlanId: string;
    timeline: unknown;
    durationSeconds: number;
    fullEdit: StoredFullEdit;
  },
  actor: { actorId: string },
) {
  return recordAutoEdit(prisma, { ...input, styleCut: null }, actor);
}

async function recordAutoEdit(
  prisma: PrismaClient,
  input: {
    contentItemId: string;
    expectedLatestPlanId: string;
    timeline: unknown;
    durationSeconds: number;
    styleCut: StoredStyleCut | null;
    fullEdit: StoredFullEdit | null;
  },
  actor: { actorId: string },
) {
  const key = input.fullEdit?.inputsKey ?? input.styleCut!.inputsKey;
  const reason = input.fullEdit ? FULL_EDIT_AUTO_REASON : STYLE_CUT_AUTO_REASON;
  const summary = input.fullEdit?.summary ?? input.styleCut!.summary;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`style-cut:${input.contentItemId}`}))::text AS locked`;
    const item = await tx.contentItem.findUniqueOrThrow({ where: { id: input.contentItemId }, select: { currentState: true } });
    const latest = await tx.editPlan.findFirst({ where: { contentItemId: input.contentItemId }, orderBy: { createdAt: "desc" } });
    const elig = autoStyleCutEligibility(item.currentState, latest);
    if (!elig.eligible || !latest || latest.id !== input.expectedLatestPlanId) return null;
    if (elig.currentKey === key) return null;
    const basePlan = (latest.plan ?? {}) as Record<string, unknown>;
    const editPlan = await tx.editPlan.create({
      data: {
        contentItemId: input.contentItemId,
        takeSelectionId: latest.takeSelectionId,
        productionTier: latest.productionTier,
        targetDurationSeconds: Math.max(0.1, input.durationSeconds),
        doNothingElse: false,
        plan: {
          ...basePlan,
          timeline: input.timeline,
          styleCut: input.styleCut ? { ...input.styleCut, origin: "AUTO" } : null,
          fullEdit: input.fullEdit ? { ...input.fullEdit, origin: "AUTO" } : null,
        } as never,
        revisionOfEditPlanId: null,
        revisionReason: reason,
      },
    });
    await recordAudit(tx, {
      actor: actor.actorId,
      actorType: "SYSTEM",
      action: "EDIT_PLAN_REPLANNED",
      entityType: "ContentItem",
      entityId: input.contentItemId,
      before: { editPlanId: latest.id },
      after: { editPlanId: editPlan.id, revisionReason: reason, [input.fullEdit ? "fullEdit" : "styleCut"]: summary, inputsKey: key },
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
    planExtras: { styleCut: input.styleCut ? { ...input.styleCut, origin: "CHRIS" } : null, fullEdit: null },
  });
}

/** Chris's "Full edit" / "Try another hook" / "Restore line": a finishing edit (new version). */
export async function saveFullEditChoice(
  prisma: PrismaClient,
  input: { contentItemId: string; timeline: unknown; durationSeconds: number; actorId: string; fullEdit: StoredFullEdit },
) {
  return saveFinishingEdit(prisma, {
    contentItemId: input.contentItemId,
    timeline: input.timeline,
    durationSeconds: input.durationSeconds,
    actorId: input.actorId,
    note: `Full edit — ${input.fullEdit.summary}`.slice(0, 400),
    planExtras: { fullEdit: { ...input.fullEdit, origin: "CHRIS" }, styleCut: null },
  });
}

/** The latest plan's stored full edit (for the editor). */
export async function getCurrentFullEdit(prisma: PrismaClient, contentItemId: string) {
  const latest = await getLatestEditPlan(prisma, contentItemId);
  return latest ? readStoredFullEdit(latest.plan) : null;
}

/** The latest plan's stored style cut (for the editor's summary line). */
export async function getCurrentStyleCut(prisma: PrismaClient, contentItemId: string) {
  const latest = await getLatestEditPlan(prisma, contentItemId);
  return latest ? readStoredStyleCut(latest.plan) : null;
}
