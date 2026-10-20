import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { recordAudit } from "./audit";

/**
 * The Creative Brief — one video's creative plan in Chris's "Content Intelligence Engine" output
 * format (prompts/shared/CONTENT_INTELLIGENCE.md): series, three hooks that differ by mechanism
 * and the pick, the story arc (with a midpoint only when it's real), the ending's single
 * objective, a storyboard, engagement design, an editorial scorecard and research status.
 *
 * Written by the in-app script pipeline (AGENT), the free ChatGPT script import (CHATGPT) or by
 * hand (HUMAN). Append-only; downstream bots (hook picker, visual strategist, viewer check,
 * captions, director, take selector, Full edit) read the latest via `formatCreativeBrief`.
 */

export const SERIES = [
  "PICK_YOUR_POISON",
  "I_DID_THE_MATH",
  "BUTTERFLY_EFFECT",
  "HOW_BROKE_IS_THIS_CHARACTER",
  "MONEY_MAKES_NO_SENSE",
  "COST_OF_BEING_ALIVE",
  "OTHER",
] as const;
export type Series = (typeof SERIES)[number];

export const SERIES_LABEL: Record<Series, string> = {
  PICK_YOUR_POISON: "Pick Your Poison",
  I_DID_THE_MATH: "I Did The Math",
  BUTTERFLY_EFFECT: "The Financial Butterfly Effect",
  HOW_BROKE_IS_THIS_CHARACTER: "How Broke Is This Character?",
  MONEY_MAKES_NO_SENSE: "Money Makes No Sense",
  COST_OF_BEING_ALIVE: "The Cost of Being Alive",
  OTHER: "Other",
};

export const HOOK_MECHANISMS = [
  "IMPOSSIBLE_CHOICE",
  "ABSURD_INVESTIGATION",
  "PERSONAL_CONTRADICTION",
  "IMPOSSIBLE_QUESTION",
  "SHOWDOWN",
  "SOCIAL_ACCUSATION",
  "FUTURE_SELF_WARNING",
  "MONEY_MYSTERY",
  "RELATABLE_CONFESSION",
  "COUNTDOWN",
  "UNPOPULAR_OPINION",
  "BEFORE_AFTER",
] as const;
export type HookMechanism = (typeof HOOK_MECHANISMS)[number];

export const ENDING_OBJECTIVES = ["COMMENT", "SHARE", "FOLLOW", "PUNCHLINE"] as const;
export type EndingObjective = (typeof ENDING_OBJECTIVES)[number];

export const SCORECARD_DIMENSIONS = [
  "hookStrength",
  "immediateClarity",
  "curiosity",
  "narrativeProgression",
  "retentionPotential",
  "emotionalRelevance",
  "entertainment",
  "visualStorytelling",
  "factualAccuracy",
  "payoffQuality",
  "brandFit",
  "followerConversion",
] as const;

/** Lenient enum: anything unknown becomes the fallback (a model or a paste may drift). */
const looseEnum = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z.preprocess((v) => {
    const s = typeof v === "string" ? v.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "") : v;
    return (values as readonly string[]).includes(s as string) ? s : fallback;
  }, z.enum(values));

const S = z.string();

export const CreativeBriefSchema = z.object({
  series: looseEnum(SERIES, "OTHER"),
  targetAudience: S,
  primaryObjective: looseEnum(ENDING_OBJECTIVES, "PUNCHLINE"),
  coreReaction: S,
  whyInteresting: S,
  hooks: z
    .array(
      z.object({
        text: S,
        mechanism: looseEnum(HOOK_MECHANISMS, "IMPOSSIBLE_QUESTION"),
        onScreenText: S,
        openingVisual: S,
      }),
    )
    .min(1)
    .max(5),
  chosenHookIndex: z.number().int().min(0),
  hookRationale: S,
  story: z.object({
    hook: S,
    setup: S,
    firstDiscovery: S,
    /** null when there's no legitimate second reveal — a fake twist is worse than none. */
    midpointReversal: S.nullable(),
    payoff: S,
    ending: S,
  }),
  storyboard: z.object({
    openingFrame: S,
    onScreenText: z.array(S),
    scenes: z.array(S),
    keyCalculations: z.array(S),
    midpointVisual: S.nullable(),
    payoffVisual: S,
    closingFrame: S,
  }),
  engagement: z.object({ whyShare: S, whyComment: S, whyFollow: S }),
  /** Editorial judgments 1–10, never probabilities of success. */
  scorecard: z.preprocess(
    (v) => (Array.isArray(v) ? Object.fromEntries(v.filter((x) => x && typeof x.dimension === "string").map((x) => [x.dimension, Math.max(0, Math.min(10, Number(x.score) || 0))])) : v),
    z.record(z.string(), z.number().min(0).max(10)),
  ),
  editorial: z.object({ strongest: S, weakest: S, mostImportantRevision: S, whatToTest: S }),
  research: z.object({
    verified: z.array(S),
    assumptions: z.array(S),
    unverified: z.array(S),
    complianceFlags: z.array(S),
  }),
});
export type CreativeBrief = z.infer<typeof CreativeBriefSchema>;

/** FOOTAGE = recovered from a filmed take by the Footage Brief agent (no script on record). */
export type CreativeBriefSource = "AGENT" | "CHATGPT" | "HUMAN" | "FOOTAGE";

export async function recordCreativeBrief(
  prisma: PrismaClient,
  input: { contentItemId: string; scriptVersionId?: string | null; source: CreativeBriefSource; brief: unknown },
  actor: { actorId: string; actorType?: "HUMAN" | "SYSTEM" | "JOB" },
) {
  const brief = CreativeBriefSchema.parse(input.brief);
  const chosen = brief.hooks[Math.min(brief.chosenHookIndex, brief.hooks.length - 1)]!;
  const fixed = { ...brief, chosenHookIndex: brief.hooks.indexOf(chosen) };
  const row = await prisma.creativeBrief.create({
    data: {
      contentItemId: input.contentItemId,
      scriptVersionId: input.scriptVersionId ?? null,
      source: input.source,
      series: fixed.series,
      primaryObjective: fixed.primaryObjective,
      hookMechanism: chosen.mechanism,
      brief: fixed as never,
    },
  });
  await prisma.contentItem.update({ where: { id: input.contentItemId }, data: { series: fixed.series } });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: actor.actorType ?? (input.source === "AGENT" || input.source === "FOOTAGE" ? "SYSTEM" : "HUMAN"),
    action: "CREATIVE_BRIEF_RECORDED",
    entityType: "ContentItem",
    entityId: input.contentItemId,
    after: { creativeBriefId: row.id, source: input.source, series: fixed.series, objective: fixed.primaryObjective, hookMechanism: chosen.mechanism },
  });
  return { ...row, brief: fixed };
}

export async function getLatestCreativeBrief(prisma: PrismaClient, contentItemId: string): Promise<(CreativeBrief & { id: string; source: string; createdAt: Date }) | null> {
  const row = await prisma.creativeBrief.findFirst({ where: { contentItemId }, orderBy: { createdAt: "desc" } });
  if (!row) return null;
  const parsed = CreativeBriefSchema.safeParse(row.brief);
  return parsed.success ? { ...parsed.data, id: row.id, source: row.source, createdAt: row.createdAt } : null;
}

/** The brief as every downstream bot reads it — compact, plain text. */
export function formatCreativeBrief(b: CreativeBrief): string {
  const chosen = b.hooks[b.chosenHookIndex] ?? b.hooks[0]!;
  const lines = [
    `Series: ${SERIES_LABEL[b.series]} · Ending objective: ${b.primaryObjective} · Intended reaction: ${b.coreReaction}`,
    `Audience: ${b.targetAudience}`,
    `Chosen hook (${chosen.mechanism}): "${chosen.text}" — on screen: "${chosen.onScreenText}" — opening visual: ${chosen.openingVisual}`,
    `Why this hook: ${b.hookRationale}`,
    `Story: hook → ${b.story.hook} | setup → ${b.story.setup} | first discovery → ${b.story.firstDiscovery} | midpoint → ${b.story.midpointReversal ?? "(none — no legitimate reversal)"} | payoff → ${b.story.payoff} | ending → ${b.story.ending}`,
    `Storyboard: opening frame → ${b.storyboard.openingFrame}; midpoint visual → ${b.storyboard.midpointVisual ?? "—"}; payoff visual → ${b.storyboard.payoffVisual}; closing frame → ${b.storyboard.closingFrame}`,
    b.storyboard.keyCalculations.length ? `Key calculations: ${b.storyboard.keyCalculations.join("; ")}` : "",
    `Why share: ${b.engagement.whyShare} · Why comment: ${b.engagement.whyComment} · Why follow: ${b.engagement.whyFollow}`,
    b.research.unverified.length ? `Unverified (don't present as fact): ${b.research.unverified.join("; ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}
