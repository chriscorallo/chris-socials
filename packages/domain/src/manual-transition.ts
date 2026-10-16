import type { ContentState, PrismaClient } from "@prisma/client";
import { applyTransition } from "./state-machine";

/**
 * The only state transitions a human may trigger with a bare "advance" button — each one is
 * a fact only Chris can attest to (he started research, he filmed it) or an explicit
 * rollback. Every other transition must go through the action that produces its evidence:
 * RENDERED -> READY only via the Quality Gate, RESEARCHING -> RESEARCHED only via Research +
 * Claims Gate, SCHEDULED -> PUBLISHING only via a real publish, and so on.
 *
 * Before this existed, the content page offered a generic "-> {next state}" button for almost
 * every state, which let a single click skip all four hard gates and then genuinely publish
 * the ungated render — the exact "a BLOCK is never averaged away" violation CLAUDE.md forbids.
 * See /docs/DECISIONS.md ("Manual transitions are an explicit allowlist").
 */
export const MANUAL_TRANSITIONS: ReadonlyArray<{
  from: ContentState;
  to: ContentState;
  label: string;
  description: string;
}> = [
  {
    from: "CONTRACTED",
    to: "RESEARCHING",
    label: "Start research",
    description: "Opens the research step; the AI pipeline then runs from RESEARCHING.",
  },
  {
    from: "READY_TO_FILM",
    to: "FILMED",
    label: "I've filmed this",
    description: "Marks the shoot done. Upload the raw takes next.",
  },
  {
    from: "RESEARCH_BLOCKED",
    to: "RESEARCHING",
    label: "Retry research",
    description: "Rollback: re-open research after a Claims Gate block (e.g. after changing the contract's angle).",
  },
  {
    from: "QC_BLOCKED",
    to: "EDIT_PLANNED",
    label: "Send back to edit planning",
    description: "Rollback: the repair budget is exhausted — re-plan the edit before rendering again.",
  },
];

export class ManualTransitionNotAllowedError extends Error {
  constructor(from: ContentState, to: ContentState) {
    super(
      `${from} -> ${to} can't be advanced manually — it must go through its own step ` +
        `(e.g. the Quality Gate, the AI pipeline, or a real publish) so its gate actually runs.`,
    );
    this.name = "ManualTransitionNotAllowedError";
  }
}

export function listManualTransitions(from: ContentState) {
  return MANUAL_TRANSITIONS.filter((t) => t.from === from);
}

export function isManualTransitionAllowed(from: ContentState, to: ContentState): boolean {
  return MANUAL_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export async function applyManualTransition(
  prisma: PrismaClient,
  input: { contentItemId: string; to: ContentState; actorId: string; reason?: string },
) {
  const item = await prisma.contentItem.findUniqueOrThrow({
    where: { id: input.contentItemId },
    select: { currentState: true },
  });
  const rule = MANUAL_TRANSITIONS.find((t) => t.from === item.currentState && t.to === input.to);
  if (!rule) {
    throw new ManualTransitionNotAllowedError(item.currentState, input.to);
  }
  return applyTransition(prisma, {
    contentItemId: input.contentItemId,
    to: input.to,
    actorType: "HUMAN",
    actorId: input.actorId,
    reason: input.reason ?? `Manual: ${rule.label}`,
  });
}
