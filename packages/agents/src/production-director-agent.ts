import { z } from "zod";
import type { PrismaClient, CreateProductionContractInput, CreateCreatorCardInput } from "@chris/domain";
import {
  createProductionContractAndAdvance,
  createCreatorCardAndAdvance,
  getCurrentWeekThesis,
  getLatestScriptVersion,
  getProductionContract,
  isEnabled,
  journalDecision,
} from "@chris/domain";
import { scopeProvider, type ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { getBrandContextText } from "./brand-context";

/**
 * Production Director (prompts/agents/PRODUCTION_DIRECTOR.md). Drafts the two hand-filled
 * artifacts that sat between an approved idea and filming:
 * - CONTRACT mode: a full Production Contract (every field of packages/domain's
 *   CreateProductionContractSchema) from an idea + the week's thesis + brand.
 * - CREATOR_CARD mode: a Creator Card from the final, gated script.
 * Drafts are returned for human review (the UI prefills the existing forms); the
 * draftAndIssue* functions are the non-interactive (autopilot) path.
 *
 * Schemas live here rather than in schemas.ts to keep this agent self-contained.
 */

export const ProductionContractDraftSchema = z.object({
  purpose: z.string(),
  primaryIdea: z.string(),
  audiencePromise: z.string(),
  topic: z.string(),
  format: z.string(),
  productionTier: z.enum(["RAW", "FAST", "MEDIUM", "HERO"]),
  targetLengthMinSeconds: z.number().int().nonnegative(),
  targetLengthMaxSeconds: z.number().int().nonnegative(),
  researchDepth: z.enum(["NONE", "LIGHT", "STANDARD", "DEEP"]),
  factualRisk: z.enum(["LOW", "MEDIUM", "HIGH"]),
  experiment: z.string().nullable(),
  platformOpportunities: z.array(z.string()),
  humanEditingBudgetMinutes: z.number().int().nonnegative().nullable(),
  requiredAssets: z.array(z.string()),
  scope: z.string(),
  doNotExpandInto: z.string(),
  /** Why these choices — shown to Chris next to the prefilled form, and journaled. */
  rationale: z.string(),
});
export type ProductionContractDraft = z.infer<typeof ProductionContractDraftSchema>;

export const CreatorCardDraftSchema = z.object({
  hook: z.string(),
  talkingPoints: z.array(z.string()).min(1),
  setup: z.enum(["DESK", "STANDING", "CASUAL", "WALKING", "SKIT", "SPECIAL"]),
  estimatedMinutes: z.number().int().nonnegative().nullable(),
  notes: z.string().nullable(),
});
export type CreatorCardDraft = z.infer<typeof CreatorCardDraftSchema>;

export interface IdeaForContract {
  title: string;
  description?: string | null;
  pillar?: string | null;
  format?: string | null;
}

/** Optional per-idea allocation from the weekly portfolio (WeeklyPortfolioItem fields). */
export interface PortfolioAllocationHint {
  purpose?: string | null;
  topic?: string | null;
  format?: string | null;
  productionTier?: string | null;
  targetLengthSeconds?: number | null;
  primaryHypothesis?: string | null;
  whyThisWeek?: string | null;
}

export async function runProductionDirectorContractAgent(
  provider: ModelProvider,
  input: {
    idea: IdeaForContract;
    thesisSummary?: string;
    allocation?: PortfolioAllocationHint;
    editingBudgetMinutesPerWeek?: number;
    brandContext: string;
  },
): Promise<ProductionContractDraft> {
  const { systemPrompt, modelClass } = buildSystemPrompt("PRODUCTION_DIRECTOR");
  const a = input.allocation;
  const userPrompt = `## Idea

Title: ${input.idea.title}
Description: ${input.idea.description ?? "(none)"}
Pillar: ${input.idea.pillar ?? "(unset)"}
Format: ${input.idea.format ?? "(unset)"}

## This week's thesis

${input.thesisSummary ?? "(no thesis recorded for this week)"}

## Portfolio allocation for this idea

${a ? Object.entries(a).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}: ${v}`).join("\n") || "(none)" : "(none — idea not yet allocated)"}

Weekly human editing budget: ~${input.editingBudgetMinutesPerWeek ?? 300} minutes across ~30 videos.

## Task

MODE: CONTRACT. Draft the Production Contract for this idea per your instructions above.
Every field is required; use null only for experiment and humanEditingBudgetMinutes when they
genuinely don't apply. targetLengthMaxSeconds must be >= targetLengthMinSeconds.`;

  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext || undefined,
    userPrompt,
    schema: ProductionContractDraftSchema,
    promptId: "PRODUCTION_DIRECTOR",
  });
  const d = result.output;
  // Deterministic repair of the one cross-field invariant the domain schema enforces.
  return d.targetLengthMaxSeconds >= d.targetLengthMinSeconds
    ? d
    : { ...d, targetLengthMinSeconds: d.targetLengthMaxSeconds, targetLengthMaxSeconds: d.targetLengthMinSeconds };
}

export async function runProductionDirectorCreatorCardAgent(
  provider: ModelProvider,
  input: {
    spokenScript: string;
    requiredFactualCaveats?: string[];
    contract?: { productionTier?: string; format?: string; requiredAssets?: unknown } | null;
    brandContext: string;
  },
): Promise<CreatorCardDraft> {
  const { systemPrompt, modelClass } = buildSystemPrompt("PRODUCTION_DIRECTOR");
  const userPrompt = `## Final script (already fact-checked — do not change claims)

${input.spokenScript}

Caveats Chris must say: ${input.requiredFactualCaveats?.join("; ") || "(none)"}
Production tier: ${input.contract?.productionTier ?? "(unknown)"}
Format: ${input.contract?.format ?? "(unknown)"}
Required assets: ${Array.isArray(input.contract?.requiredAssets) ? (input.contract!.requiredAssets as unknown[]).join(", ") || "(none)" : "(none)"}

## Task

MODE: CREATOR_CARD. Draft the Creator Card for filming this script per your instructions above.`;

  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext || undefined,
    userPrompt,
    schema: CreatorCardDraftSchema,
    promptId: "PRODUCTION_DIRECTOR",
  });
  return result.output;
}

/** Dispatcher matching the roster name — CONTRACT or CREATOR_CARD mode. */
export async function runProductionDirectorAgent(
  provider: ModelProvider,
  input:
    | ({ mode: "CONTRACT" } & Parameters<typeof runProductionDirectorContractAgent>[1])
    | ({ mode: "CREATOR_CARD" } & Parameters<typeof runProductionDirectorCreatorCardAgent>[1]),
): Promise<ProductionContractDraft | CreatorCardDraft> {
  return input.mode === "CONTRACT"
    ? runProductionDirectorContractAgent(provider, input)
    : runProductionDirectorCreatorCardAgent(provider, input);
}

export function toCreateProductionContractInput(
  contentItemId: string,
  draft: ProductionContractDraft,
): CreateProductionContractInput {
  return {
    contentItemId,
    purpose: draft.purpose,
    primaryIdea: draft.primaryIdea,
    audiencePromise: draft.audiencePromise,
    topic: draft.topic,
    format: draft.format,
    productionTier: draft.productionTier,
    targetLengthMinSeconds: draft.targetLengthMinSeconds,
    targetLengthMaxSeconds: draft.targetLengthMaxSeconds,
    researchDepth: draft.researchDepth,
    factualRisk: draft.factualRisk,
    experiment: draft.experiment ?? undefined,
    platformOpportunities: draft.platformOpportunities,
    humanEditingBudgetMinutes: draft.humanEditingBudgetMinutes ?? undefined,
    requiredAssets: draft.requiredAssets,
    scope: draft.scope,
    doNotExpandInto: draft.doNotExpandInto,
  };
}

export function toCreateCreatorCardInput(contentItemId: string, draft: CreatorCardDraft): CreateCreatorCardInput {
  return {
    contentItemId,
    hook: draft.hook,
    talkingPoints: draft.talkingPoints,
    setup: draft.setup,
    estimatedMinutes: draft.estimatedMinutes ?? undefined,
    notes: draft.notes ?? undefined,
  };
}

/** Feature flag gating the autopilot path (off unless Chris turns it on — CLAUDE.md: autonomy
 * is earned per subsystem). A human clicking "draft & issue" passes triggeredByHuman. */
export const AUTOPILOT_PRODUCTION_DIRECTOR_FLAG = "AUTOPILOT_PRODUCTION_DIRECTOR";

export class AutopilotDisabledError extends Error {
  constructor(flag: string) {
    super(`Autopilot path refused: feature flag ${flag} is off.`);
    this.name = "AutopilotDisabledError";
  }
}

async function assertAutopilotAllowed(prisma: PrismaClient, triggeredByHuman: boolean | undefined) {
  if (triggeredByHuman) return;
  if (!(await isEnabled(prisma, AUTOPILOT_PRODUCTION_DIRECTOR_FLAG))) {
    throw new AutopilotDisabledError(AUTOPILOT_PRODUCTION_DIRECTOR_FLAG);
  }
}

/** Builds the CONTRACT-mode inputs for an item from the database (also what the UI should use
 * to prefill the contract form). */
export async function draftProductionContract(prisma: PrismaClient, provider: ModelProvider, contentItemId: string) {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  const thesis = await getCurrentWeekThesis(prisma);
  const allocation = thesis
    ? await prisma.weeklyPortfolioItem.findFirst({ where: { weeklyThesisId: thesis.id, contentItemId } })
    : null;
  const brandContext = await getBrandContextText(prisma);
  return runProductionDirectorContractAgent(scopeProvider(provider, { contentItemId }), {
    idea: item,
    thesisSummary: thesis
      ? `${thesis.thesis}\nPrimary objectives: ${(thesis.primaryObjectives as string[]).join("; ")}\nActive experiments: ${(thesis.activeExperiments as string[]).join("; ")}`
      : undefined,
    allocation: allocation ?? undefined,
    brandContext,
  });
}

/** Non-interactive path: draft + issue (SELECTED -> CONTRACTED) + journal. */
export async function draftAndIssueProductionContract(
  prisma: PrismaClient,
  provider: ModelProvider,
  input: { contentItemId: string; actorId: string; triggeredByHuman?: boolean },
) {
  await assertAutopilotAllowed(prisma, input.triggeredByHuman);
  const draft = await draftProductionContract(prisma, provider, input.contentItemId);
  const contract = await createProductionContractAndAdvance(
    prisma,
    toCreateProductionContractInput(input.contentItemId, draft),
    { actorId: input.actorId },
  );
  await journalDecision(prisma, {
    question: `How should "${draft.primaryIdea}" be produced?`,
    selectedDecision: `${draft.productionTier} tier, ${draft.targetLengthMinSeconds}-${draft.targetLengthMaxSeconds}s, research ${draft.researchDepth}, factual risk ${draft.factualRisk}`,
    alternatives: ["RAW", "FAST", "MEDIUM", "HERO"].filter((t) => t !== draft.productionTier).map((t) => `${t} tier`),
    rationale: draft.rationale,
    decisionOwner: input.triggeredByHuman ? input.actorId : "PRODUCTION_DIRECTOR",
    agentOrModel: "PRODUCTION_DIRECTOR",
    evidenceIds: [contract.id],
  });
  return { contract, draft };
}

/** Drafts a Creator Card from the latest (gated) script — the UI prefills its form with this. */
export async function draftCreatorCard(prisma: PrismaClient, provider: ModelProvider, contentItemId: string) {
  const script = await getLatestScriptVersion(prisma, contentItemId);
  if (!script) throw new Error("No script exists for this item yet.");
  const contract = await getProductionContract(prisma, contentItemId);
  const brandContext = await getBrandContextText(prisma);
  return runProductionDirectorCreatorCardAgent(scopeProvider(provider, { contentItemId }), {
    spokenScript: script.spokenScript,
    requiredFactualCaveats: Array.isArray(script.requiredFactualCaveats) ? (script.requiredFactualCaveats as string[]) : [],
    contract,
    brandContext,
  });
}

/** Non-interactive path: draft + issue (SCRIPTED -> READY_TO_FILM). The domain still refuses
 * if the latest script hasn't passed the script-level Claims Gate. */
export async function draftAndIssueCreatorCard(
  prisma: PrismaClient,
  provider: ModelProvider,
  input: { contentItemId: string; actorId: string; triggeredByHuman?: boolean },
) {
  await assertAutopilotAllowed(prisma, input.triggeredByHuman);
  const draft = await draftCreatorCard(prisma, provider, input.contentItemId);
  const card = await createCreatorCardAndAdvance(prisma, toCreateCreatorCardInput(input.contentItemId, draft), {
    actorId: input.actorId,
  });
  return { card, draft };
}
