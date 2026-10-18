import type { PrismaClient } from "@prisma/client";
import { getCurrentWeekThesis } from "./weekly-thesis";
import { queryAll } from "./db-concurrency";

/**
 * Home's "NEEDS YOU" queue — spec §20, verbatim: "Default human review queue should show only
 * subjective choice, factual nuance, unresolved QC, platform issue, strategy decision, or
 * uncertainty above threshold. Do not create approval fatigue." Six named categories, each
 * mapped here to one real, already-existing schema signal — nothing invented, nothing
 * synthesized just to have something to show:
 *
 * - UNRESOLVED_QC        -> ContentItem.currentState === QC_BLOCKED (repair-iteration limit
 *                           hit; needs a human call per /docs/STATE_MACHINE.md)
 * - FACTUAL_NUANCE        -> ContentItem.currentState === RESEARCH_BLOCKED (Claims Gate BLOCK)
 * - PLATFORM_ISSUE        -> Publication.status === FAILED, most recent attempt per
 *                           (contentItem, platform) — superseded by a later attempt is excluded
 * - STRATEGY_DECISION     -> the current WeeklyProgrammingThesis's own humanDecisionsNeeded —
 *                           the Weekly Strategist already names these explicitly; this queue
 *                           doesn't infer them
 * - SUBJECTIVE_CHOICE     -> Belief rows with status PROPOSED (the Learning System can never
 *                           self-promote a belief — see /docs/DECISIONS.md's Belief-promotion
 *                           entry — so every PROPOSED belief is, by construction, waiting on a
 *                           human judgment call)
 * - UNCERTAINTY           -> AdversarialCritique rows where noMaterialWeaknessesFound is false
 *                           (the independent evaluator found something real, not routine)
 *
 * Deliberately capped (`limit`, default 8) and sorted newest-first across categories, not
 * per-category — the spec's explicit warning ("do not create approval fatigue") is a hard
 * constraint on this function's shape, not just a UI nicety layered on top of an unbounded
 * list.
 */

export type NeedsYouCategory =
  | "SUBJECTIVE_CHOICE"
  | "FACTUAL_NUANCE"
  | "UNRESOLVED_QC"
  | "PLATFORM_ISSUE"
  | "STRATEGY_DECISION"
  | "UNCERTAINTY";

export interface NeedsYouEntry {
  category: NeedsYouCategory;
  title: string;
  description: string;
  href: string;
  createdAt: Date;
}

const CATEGORY_LABEL: Record<NeedsYouCategory, string> = {
  SUBJECTIVE_CHOICE: "Subjective choice",
  FACTUAL_NUANCE: "Factual nuance",
  UNRESOLVED_QC: "Unresolved QC",
  PLATFORM_ISSUE: "Platform issue",
  STRATEGY_DECISION: "Strategy decision",
  UNCERTAINTY: "Uncertainty",
};

export function needsYouCategoryLabel(category: NeedsYouCategory): string {
  return CATEGORY_LABEL[category];
}

export interface NeedsYouQueue {
  entries: NeedsYouEntry[];
  /** How many real signals existed before the cap — lets the UI say "+N more" honestly
   * instead of implying the queue is exhaustive. */
  totalBeforeCap: number;
}

export async function getNeedsYouQueue(
  prisma: PrismaClient,
  opts: { limit?: number } = {},
): Promise<NeedsYouQueue> {
  const limit = opts.limit ?? 8;
  const entries: NeedsYouEntry[] = [];

  // Independent reads go out together on Neon and one at a time on PGlite (queryAll — see
  // db-concurrency.ts and /docs/DECISIONS.md's PGlite entries). Entries are still pushed in
  // the same order as before, so the final sort's tie-breaking is unchanged.
  const [qcBlocked, researchBlocked, failedPublications, thesis, proposedBeliefs, critiques] = await queryAll([
    () => prisma.contentItem.findMany({ where: { currentState: "QC_BLOCKED" }, orderBy: { updatedAt: "desc" } }),
    () => prisma.contentItem.findMany({ where: { currentState: "RESEARCH_BLOCKED" }, orderBy: { updatedAt: "desc" } }),
    () => prisma.publication.findMany({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" }, include: { contentItem: true } }),
    () => getCurrentWeekThesis(prisma),
    () => prisma.belief.findMany({ where: { status: "PROPOSED" }, orderBy: { createdAt: "desc" } }),
    () =>
      prisma.adversarialCritique.findMany({
        where: { noMaterialWeaknessesFound: false },
        orderBy: { createdAt: "desc" },
        take: limit, // a critique with no cap could dominate the queue on a rough week — pre-trim
      }),
  ] as const);

  for (const item of qcBlocked) {
    entries.push({
      category: "UNRESOLVED_QC",
      title: item.title,
      description: "Quality gate blocked after repair attempts — decide rework or cancel.",
      href: `/content/${item.id}`,
      createdAt: item.updatedAt,
    });
  }

  for (const item of researchBlocked) {
    entries.push({
      category: "FACTUAL_NUANCE",
      title: item.title,
      description: "Claims Gate blocked a factual claim — needs re-research direction or cancellation.",
      href: `/content/${item.id}`,
      createdAt: item.updatedAt,
    });
  }

  // Only the most recent attempt per (contentItem, platform) — a retry that later succeeded
  // must not leave a stale FAILED entry behind.
  const latestByKey = new Map<string, (typeof failedPublications)[number]>();
  for (const pub of failedPublications) {
    const key = `${pub.contentItemId}:${pub.platform}`;
    if (!latestByKey.has(key)) latestByKey.set(key, pub);
  }
  const failedLatest = [...latestByKey.values()];
  const latestAttempts = await queryAll(
    failedLatest.map(
      (pub) => () =>
        prisma.publication.findFirst({
          where: { contentItemId: pub.contentItemId, platform: pub.platform },
          orderBy: { attempt: "desc" },
        }),
    ),
  );
  for (const [i, pub] of failedLatest.entries()) {
    const latestAttempt = latestAttempts[i];
    if (latestAttempt?.status !== "FAILED") continue; // superseded by a later, non-failed attempt
    entries.push({
      category: "PLATFORM_ISSUE",
      title: `${pub.contentItem.title} — ${pub.platform}`,
      description: pub.errorMessage ?? "Publish attempt failed — needs a manual look.",
      href: `/content/${pub.contentItemId}`,
      createdAt: pub.createdAt,
    });
  }

  if (thesis) {
    const decisions = (thesis.humanDecisionsNeeded as unknown as string[]) ?? [];
    for (const decision of decisions) {
      entries.push({
        category: "STRATEGY_DECISION",
        title: decision,
        description: `Named by this week's Programming Thesis ("${thesis.thesis}").`,
        href: `/strategy`,
        createdAt: thesis.createdAt,
      });
    }
  }

  for (const belief of proposedBeliefs) {
    entries.push({
      category: "SUBJECTIVE_CHOICE",
      title: belief.statement,
      description: "Proposed belief awaiting your review — never promoted automatically.",
      href: `/learnings`,
      createdAt: belief.createdAt,
    });
  }

  for (const critique of critiques) {
    const concerns = (critique.concerns as unknown as { description: string }[]) ?? [];
    const first = concerns[0]?.description ?? "The adversarial evaluator flagged a concern.";
    entries.push({
      category: "UNCERTAINTY",
      title: `${critique.artifactType} under review`,
      description: concerns.length > 1 ? `${first} (+${concerns.length - 1} more)` : first,
      href: critique.contentItemId ? `/content/${critique.contentItemId}` : "/learnings",
      createdAt: critique.createdAt,
    });
  }

  entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return {
    entries: entries.slice(0, limit),
    totalBeforeCap: entries.length,
  };
}
