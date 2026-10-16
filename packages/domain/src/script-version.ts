import type { PrismaClient, ContentState, ScriptVersion } from "@prisma/client";
import { z } from "zod";
import { applyTransition } from "./state-machine";
import { recordAudit } from "./audit";
import { journalDecision } from "./decision-journal";

/**
 * Human script edits — immutable history. Chris editing a script never overwrites the agent's
 * version: it creates a new ScriptVersion (authorType HUMAN, revisedFromId = the version he
 * edited). A human edit must still pass the factual gate before filming: the new version
 * starts with NO scriptClaimsGateResult, and `isScriptVersionFilmable` refuses it until
 * `recordScriptRegate` has stored a PASS from the Claims Gate (agents: regateEditedScript).
 */

/** States in which a script may be edited: before filming starts. RESEARCH_BLOCKED covers the
 * script-level BLOCK case (the blocked script is what Chris fixes). */
const EDITABLE_STATES = new Set<ContentState>(["SCRIPTED", "RESEARCH_BLOCKED"]);

export class ScriptNotEditableError extends Error {
  constructor(state: ContentState) {
    super(`Scripts can only be edited while the item is SCRIPTED or RESEARCH_BLOCKED (current state: ${state}).`);
    this.name = "ScriptNotEditableError";
  }
}

export class ScriptRegateAlreadyRecordedError extends Error {
  constructor(scriptVersionId: string) {
    super(`ScriptVersion ${scriptVersionId} already has a Claims Gate result — create a new version instead of overwriting.`);
    this.name = "ScriptRegateAlreadyRecordedError";
  }
}

export const CreateHumanScriptVersionSchema = z.object({
  contentItemId: z.string().min(1),
  baseScriptVersionId: z.string().min(1),
  spokenScript: z.string().trim().min(1),
  note: z.string().optional(),
  actorId: z.string().min(1),
});
export type CreateHumanScriptVersionInput = z.input<typeof CreateHumanScriptVersionSchema>;

/** ~150 spoken words per minute — a deterministic estimate for a human-written script. */
export function estimateSpeakingSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 2.5));
}

export async function createHumanScriptVersion(prisma: PrismaClient, input: CreateHumanScriptVersionInput) {
  const parsed = CreateHumanScriptVersionSchema.parse(input);
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: parsed.contentItemId } });
  if (!EDITABLE_STATES.has(item.currentState)) throw new ScriptNotEditableError(item.currentState);

  const base = await prisma.scriptVersion.findUniqueOrThrow({ where: { id: parsed.baseScriptVersionId } });
  if (base.contentItemId !== parsed.contentItemId) {
    throw new Error(`ScriptVersion ${base.id} does not belong to ContentItem ${parsed.contentItemId}.`);
  }

  const row = await prisma.scriptVersion.create({
    data: {
      contentItemId: parsed.contentItemId,
      researchPacketId: base.researchPacketId,
      spokenScript: parsed.spokenScript,
      // Beat/pause/emphasis annotations described the agent's wording; they'd be stale for
      // the human text, so they are cleared rather than silently mismatched.
      beats: [],
      intendedPauses: [],
      emphasizedWords: [],
      visualBeats: [],
      requiredFactualCaveats: base.requiredFactualCaveats as never,
      targetRuntimeSeconds: base.targetRuntimeSeconds,
      estimatedSpeakingRuntimeSeconds: estimateSpeakingSeconds(parsed.spokenScript),
      followUpIdeas: base.followUpIdeas as never,
      authorType: "HUMAN",
      revisedFromId: base.id,
      revisionNote: parsed.note ?? null,
    },
  });

  await recordAudit(prisma, {
    actor: parsed.actorId,
    actorType: "HUMAN",
    action: "SCRIPT_VERSION_HUMAN_EDIT",
    entityType: "ContentItem",
    entityId: parsed.contentItemId,
    before: { scriptVersionId: base.id },
    after: { scriptVersionId: row.id, revisedFromId: base.id },
    metadata: { note: parsed.note ?? null },
  });

  // A human rewrite of an agent script is an override of a specialist recommendation —
  // /docs/ARCHITECTURE.md requires it in the Decision Journal (Taste Model raw material).
  await journalDecision(prisma, {
    question: `Which script wording should "${item.title}" use?`,
    selectedDecision: `Human edit (ScriptVersion ${row.id})`,
    alternatives: [`Agent version ${base.id}`],
    rationale: parsed.note?.trim() || "Chris edited the script by hand.",
    decisionOwner: parsed.actorId,
    agentOrModel: base.authorType === "AGENT" ? "SCRIPT" : undefined,
    userOverride: base.authorType === "AGENT",
    evidenceIds: [base.id, row.id],
  });

  return row;
}

const GateSchema = z
  .object({ result: z.enum(["PASS", "PASS_WITH_REQUIRED_EDIT", "BLOCK"]), blockReason: z.string().nullable().optional() })
  .passthrough();

export const RecordScriptRegateSchema = z.object({
  scriptVersionId: z.string().min(1),
  scriptClaimsGateResult: GateSchema,
  brandGuardianReport: z.unknown().nullable().optional(),
  actorId: z.string().min(1),
});
export type RecordScriptRegateInput = z.input<typeof RecordScriptRegateSchema>;

/**
 * Stores the Claims Gate (+ Brand Guardian) verdict for a version that has none yet — a one-
 * time fill, like brandGuardianReport; an existing verdict is never overwritten. If the verdict
 * is PASS and the item is RESEARCH_BLOCKED (a script-level block Chris has now fixed), walks
 * RESEARCH_BLOCKED -> RESEARCHING -> RESEARCHED -> SCRIPTING -> SCRIPTED, every step a real
 * audited transition.
 */
export async function recordScriptRegate(prisma: PrismaClient, input: RecordScriptRegateInput) {
  const parsed = RecordScriptRegateSchema.parse(input);
  const existing = await prisma.scriptVersion.findUniqueOrThrow({ where: { id: parsed.scriptVersionId } });
  if (existing.scriptClaimsGateResult !== null) throw new ScriptRegateAlreadyRecordedError(existing.id);

  const row = await prisma.scriptVersion.update({
    where: { id: existing.id },
    data: {
      scriptClaimsGateResult: parsed.scriptClaimsGateResult as never,
      ...(parsed.brandGuardianReport != null && existing.brandGuardianReport === null
        ? { brandGuardianReport: parsed.brandGuardianReport as never }
        : {}),
    },
  });

  const verdict = parsed.scriptClaimsGateResult.result;
  await recordAudit(prisma, {
    actor: parsed.actorId,
    actorType: "SYSTEM",
    action: "SCRIPT_REGATED",
    entityType: "ContentItem",
    entityId: existing.contentItemId,
    after: { scriptVersionId: existing.id, scriptClaimsGate: verdict },
  });

  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: existing.contentItemId } });
  if (verdict === "PASS" && item.currentState === "RESEARCH_BLOCKED") {
    for (const to of ["RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED"] as const) {
      await applyTransition(prisma, {
        contentItemId: item.id,
        to,
        actorType: "SYSTEM",
        actorId: parsed.actorId,
        reason: `Human-edited script ${existing.id} passed the script-level Claims Gate`,
      });
    }
  }

  const after = await prisma.contentItem.findUniqueOrThrow({ where: { id: existing.contentItemId } });
  return { scriptVersion: row, contentItemState: after.currentState };
}

/**
 * Deterministic filming gate on a script version. Backward compatible: agent versions written
 * before the script-level gate existed (no result, authorType AGENT) are allowed; a HUMAN
 * version must have been re-gated; any recorded verdict must be PASS.
 */
export function isScriptVersionFilmable(
  version: Pick<ScriptVersion, "authorType" | "scriptClaimsGateResult">,
): { ok: true } | { ok: false; reason: string } {
  const gate = version.scriptClaimsGateResult as { result?: string } | null;
  if (gate == null) {
    return version.authorType === "HUMAN"
      ? { ok: false, reason: "This hand-edited script hasn't been re-checked by the Claims Gate yet." }
      : { ok: true };
  }
  return gate.result === "PASS"
    ? { ok: true }
    : { ok: false, reason: `The latest script's Claims Gate result is ${gate.result}, not PASS.` };
}

export async function listScriptVersions(prisma: PrismaClient, contentItemId: string) {
  return prisma.scriptVersion.findMany({ where: { contentItemId }, orderBy: { createdAt: "asc" } });
}
