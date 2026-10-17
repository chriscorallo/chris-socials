import type { ContentItem, ContentState, PrismaClient } from "@prisma/client";
import { createContentItem } from "./content-item";
import { applyTransition } from "./state-machine";
import { createProductionContractAndAdvance } from "./production-contract";

/**
 * "I already filmed something" — the footage-first path. Chris often films without going
 * through the plan → research → script flow first; requiring that before he can even upload
 * was the single biggest "where do I upload?" dead end.
 *
 * Creates the ContentItem and walks it to FILMED so uploaded takes ingest normally
 * (FILMED -> MEDIA_INGESTED on the first analyzed take). Honesty about what was skipped:
 *  - every skipped step is a SYSTEM transition whose reason says "footage-first", so the
 *    history shows exactly what did and didn't happen;
 *  - the contract records researchDepth STANDARD / factualRisk MEDIUM — NOT the NONE/LOW
 *    combination that exempts an item from fact-checking — so the FACTUAL hard gate still
 *    BLOCKs publishing until the video's own transcript passes the Claims Gate
 *    ("Fact-check this video"). Footage-first is a shortcut to editing, never to publishing
 *    unchecked claims. See /docs/DECISIONS.md ("Footage-first upload").
 */
export async function createContentItemFromFootage(
  prisma: PrismaClient,
  input: { title: string; description?: string },
  actor: { actorId: string },
) {
  const title = input.title.trim() || "Untitled video";
  const item = await createContentItem(prisma, { title, description: input.description }, actor);
  await walkToFilmed(prisma, item, actor, {
    reason: "Footage-first: Chris filmed this outside the planning flow",
    purpose: "Footage-first upload",
  });
  return prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
}

/** The pre-film path, in order. */
const PATH_TO_FILMED: ContentState[] = ["IDEA", "SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED", "READY_TO_FILM", "FILMED"];

/** Footage can be added to these as extra takes without any transition. */
const ALREADY_FILMED: ReadonlySet<ContentState> = new Set<ContentState>([
  "FILMED", "MEDIA_INGESTED", "TAKE_SELECTED", "EDIT_PLANNED", "EDITING", "RENDERED", "QC_REPAIR", "QC_BLOCKED", "READY", "SCHEDULED",
]);

export class PlannedItemCannotTakeFootageError extends Error {
  constructor(state: ContentState) {
    super(
      state === "RESEARCH_BLOCKED"
        ? "The fact-check stopped this video — open it and fix the angle before adding footage."
        : state === "CANCELLED"
          ? "This video was cancelled — pick another one (or upload it as a new video)."
          : "This video has already been posted — upload new footage as a new video.",
    );
    this.name = "PlannedItemCannotTakeFootageError";
  }
}

/**
 * Footage arrived for a video that was planned (imported plan, Ideas, the weekly slate) but
 * hasn't been through research/script/filming in the app: walk it from wherever it is to
 * FILMED so the upload ingests normally. Same honesty rules as footage-first:
 *  - every skipped step is its own SYSTEM transition with reason "Planned video — footage
 *    uploaded" (IDEA -> SELECTED is HUMAN: uploading footage is Chris choosing the video);
 *  - a missing Production Contract is created as STANDARD research / MEDIUM risk — not the
 *    fact-check-exempt NONE/LOW — so the FACTUAL hard gate still requires the footage's own
 *    claims to pass before publishing. An existing contract is kept as-is.
 * Already at/after FILMED (takes being added): no-op. Research-blocked, cancelled or posted
 * videos are refused with a plain message. Idempotent and retry-safe (per-step idempotency
 * keys), so a batch upload can call it once per clip.
 */
export async function advancePlannedItemToFilmed(
  prisma: PrismaClient,
  contentItemId: string,
  actor: { actorId: string },
): Promise<{ item: ContentItem; advanced: boolean }> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (ALREADY_FILMED.has(item.currentState)) return { item, advanced: false };
  if (!PATH_TO_FILMED.includes(item.currentState)) throw new PlannedItemCannotTakeFootageError(item.currentState);
  await walkToFilmed(prisma, item, actor, { reason: "Planned video — footage uploaded", purpose: "Planned video — footage uploaded" });
  return { item: await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } }), advanced: true };
}

async function walkToFilmed(
  prisma: PrismaClient,
  item: ContentItem,
  actor: { actorId: string },
  how: { reason: string; purpose: string },
) {
  const { reason } = how;
  let state = item.currentState;
  const key = (to: ContentState) => `to-filmed:${item.id}:${to}`;
  if (state === "IDEA") {
    await applyTransition(prisma, { contentItemId: item.id, to: "SELECTED", actorType: "HUMAN", actorId: actor.actorId, reason, idempotencyKey: key("SELECTED") });
    state = "SELECTED";
  }
  if (state === "SELECTED") {
    const title = item.title;
    await createProductionContractAndAdvance(
      prisma,
      {
        contentItemId: item.id,
        purpose: how.purpose,
        primaryIdea: title,
        audiencePromise: "To be confirmed from the footage",
        topic: title,
        format: item.format?.trim() || "Talking head",
        productionTier: "FAST",
        targetLengthMinSeconds: 15,
        targetLengthMaxSeconds: 90,
        researchDepth: "STANDARD",
        factualRisk: "MEDIUM",
        scope: "What was said in the uploaded footage",
        doNotExpandInto: "Claims that aren't in the footage",
      },
      actor,
    );
    state = "CONTRACTED";
  }
  for (const to of PATH_TO_FILMED.slice(PATH_TO_FILMED.indexOf(state) + 1)) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM", actorId: actor.actorId, reason, idempotencyKey: key(to) });
  }
}
