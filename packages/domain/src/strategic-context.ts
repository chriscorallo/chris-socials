import type { PrismaClient } from "@prisma/client";

/**
 * Closes the learning loop (spec §9 step 27: "accepted learnings feed the next Weekly
 * Programming Thesis"). Assembles a compact, token-bounded text block of what the system has
 * learned — for the Creative Director and Weekly Strategist, which previously saw only the IDEA
 * backlog + brand.
 *
 * Bounded deterministically: each section has a row limit AND a character budget, and the
 * whole block is capped at `maxChars` (~4 chars/token, so the 8,000 default is ~2K tokens).
 * Empty stores render an explicit "no data yet" line so the model plans around missing
 * evidence instead of inventing it. Sequential reads (PGlite — see /docs/DECISIONS.md).
 */
export interface StrategicContextOptions {
  maxChars?: number;
  /** Rows per section (default 8). */
  limitPerSection?: number;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function section(title: string, lines: string[], budget: number, emptyNote: string): string {
  const body = lines.length ? lines.map((l) => `- ${l}`).join("\n") : `- ${emptyNote}`;
  return clip(`### ${title}\n${body}`, budget);
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export async function buildStrategicContext(
  prisma: PrismaClient,
  opts: StrategicContextOptions = {},
): Promise<string> {
  const maxChars = opts.maxChars ?? 8000;
  const take = opts.limitPerSection ?? 8;
  const budget = Math.floor(maxChars / 6);

  const beliefs = await prisma.belief.findMany({
    where: { status: "ACCEPTED" },
    orderBy: [{ confidence: "desc" }, { createdAt: "desc" }],
    take,
  });
  const brief = await prisma.weeklyBrief.findFirst({ orderBy: { weekStartDate: "desc" } });
  const evaluations = await prisma.performanceEvaluation.findMany({ orderBy: { createdAt: "desc" }, take });
  const evalTitles = new Map(
    (
      await prisma.contentItem.findMany({
        where: { id: { in: evaluations.map((e) => e.contentItemId) } },
        select: { id: true, title: true },
      })
    ).map((i) => [i.id, i.title]),
  );
  const insights = await prisma.audienceInsight.findMany({ orderBy: { createdAt: "desc" }, take });
  const tasteByTag = await prisma.tasteFeedback.groupBy({
    by: ["normalizedTag", "artifactType"],
    _count: { _all: true },
    orderBy: { _count: { normalizedTag: "desc" } },
    take,
  });
  const recentTaste = await prisma.tasteFeedback.findMany({ orderBy: { createdAt: "desc" }, take: 3 });
  const observations = await prisma.referenceObservation.findMany({ orderBy: { createdAt: "desc" }, take: Math.min(take, 5) });

  const parts = [
    "## Strategic context (what the system has learned — weigh by evidence, not recency)",
    section(
      "Accepted beliefs (semantic memory)",
      beliefs.map(
        (b) =>
          `${b.statement} (confidence ${b.confidence.toFixed(2)}, n=${b.sampleSize}${b.applicablePlatform ? `, ${b.applicablePlatform}` : ""}${b.applicableTopic ? `, topic ${b.applicableTopic}` : ""}${b.isExperimentalEvidence ? ", experimental" : ", observational"})`,
      ),
      budget,
      "No accepted beliefs yet — treat every pattern as a hypothesis.",
    ),
    section(
      `Last weekly brief${brief ? ` (week of ${brief.weekStartDate.toISOString().slice(0, 10)})` : ""}`,
      brief
        ? [
            `What happened: ${clip(brief.whatHappened, 400)}`,
            `What it means: ${clip(brief.whatItMeans, 400)}`,
            ...strs(brief.recommendationsForNextWeek).slice(0, 5).map((r) => `Recommendation: ${clip(r, 200)}`),
            ...strs(brief.stillUncertain).slice(0, 3).map((u) => `Still uncertain: ${clip(u, 160)}`),
          ]
        : [],
      budget,
      "No weekly brief yet.",
    ),
    section(
      "Recent performance evaluations",
      evaluations.map(
        (e) =>
          `"${evalTitles.get(e.contentItemId) ?? e.contentItemId}": ${clip(e.overallSummary, 220)}${e.strategicallyValuableDespiteLowerViews ? " [strategically valuable despite lower views]" : ""}`,
      ),
      budget,
      "No performance data yet.",
    ),
    section(
      "Audience insights (first-party research)",
      insights.map(
        (i) =>
          `[${i.category}, ${i.supportingCommentCount} comments] ${clip(i.description, 200)}${i.actionableSuggestion ? ` → ${clip(i.actionableSuggestion, 120)}` : ""}`,
      ),
      budget,
      "No audience insights yet.",
    ),
    section(
      "Chris taste feedback (counts by tag; one instance is not a rule)",
      [
        ...tasteByTag.map((t) => `${t.normalizedTag} on ${t.artifactType}: ${t._count._all}×`),
        ...recentTaste.map((t) => `Recent, verbatim: "${clip(t.rawFeedback, 140)}" (${t.artifactType})`),
      ],
      budget,
      "No taste feedback recorded yet.",
    ),
    section(
      "Reference observations (supporting evidence only — principles transfer, identity does not)",
      observations.map((o) => `${clip(o.likelyPrinciple, 160)} — transferability: ${clip(o.transferabilityToChris, 120)}; test: ${clip(o.testRequired, 120)}`),
      budget,
      "No reference observations yet.",
    ),
  ];

  return clip(parts.join("\n\n"), maxChars);
}
