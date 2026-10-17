"use server";

import { redirect } from "next/navigation";
import {
  prisma,
  recordEvidenceEntry,
  listEvidenceEntries,
  proposeBelief,
  acceptBelief,
  rejectBelief,
  createBrandEra,
  createExperiment,
  addExperimentVariant,
  startExperiment,
  concludeExperiment,
  recordWeeklyBrief,
  listContentItems,
  listAudienceInsights,
  listExperiments,
  setAutonomyCeiling,
  setFlag,
  AUTONOMY_SHADOW_ONLY_FLAG,
  forgetMotionPreference,
} from "@chris/domain";
import {
  runLearningAgent,
  runExperimentAgent,
  runWeeklyReviewAgent,
  getBrandContextText,
  refreshTasteModel,
} from "@chris/agents";
import { requireSession } from "../../lib/session";
import { getModelProvider } from "../../lib/model-provider";

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}
function lines(formData: FormData, key: string): string[] {
  return str(formData, key)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function submitManualEvidence(formData: FormData) {
  const session = await requireSession();
  await recordEvidenceEntry(prisma, {
    statement: str(formData, "statement"),
    sourceType: "MANUAL",
    confidence: Number(str(formData, "confidence") || 0.5),
  });
  void session;
  redirect("/learnings");
}

/**
 * Runs the Learning Agent against every entry currently in the Evidence Ledger. Real
 * evidence-statement -> id resolution happens here (the model cites statements, never ids
 * directly — see packages/agents/src/schemas.ts's BeliefProposalOutputSchema) so the resulting
 * proposal can only ever reference real, existing Evidence Ledger rows. Requires
 * ANTHROPIC_API_KEY.
 */
export async function runLearningAgentAction() {
  const session = await requireSession();

  try {
    const evidence = await listEvidenceEntries(prisma);
    if (evidence.length === 0) {
      throw new Error("No evidence in the ledger yet — record some first.");
    }
    const brandContext = await getBrandContextText(prisma);
    const proposal = await runLearningAgent(getModelProvider(), {
      evidence: evidence.map((e) => ({ id: e.id, statement: e.statement, sourceType: e.sourceType, confidence: e.confidence })),
      brandContext,
    });

    const cited = evidence.filter((e) => proposal.evidenceStatements.includes(e.statement));
    if (cited.length === 0) {
      throw new Error("The model's cited evidence statements didn't match any real Evidence Ledger entry.");
    }

    await proposeBelief(
      prisma,
      {
        statement: proposal.statement,
        causalClaim: proposal.causalClaim,
        isExperimentalEvidence: proposal.isExperimentalEvidence,
        evidenceIds: cited.map((e) => e.id),
        sampleSize: proposal.sampleSize,
        applicablePlatform: proposal.applicablePlatform,
        applicableTopic: proposal.applicableTopic,
        applicableFormat: proposal.applicableFormat,
        confidence: proposal.confidence,
        confounders: proposal.confounders,
        contradictoryEvidence: proposal.contradictoryEvidence,
        retestConditions: proposal.retestConditions,
      },
      { actorId: session.user!.id! },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown learning-agent error";
    redirect(`/learnings?learningError=${encodeURIComponent(message)}`);
  }

  redirect("/learnings");
}

export async function approveBeliefAction(formData: FormData) {
  const session = await requireSession();
  await acceptBelief(prisma, str(formData, "beliefId"), { actorId: session.user!.id! });
  redirect("/learnings");
}

export async function rejectBeliefAction(formData: FormData) {
  const session = await requireSession();
  await rejectBelief(prisma, str(formData, "beliefId"), { actorId: session.user!.id! });
  redirect("/learnings");
}

export async function submitBrandEra(formData: FormData) {
  const session = await requireSession();
  await createBrandEra(
    prisma,
    { name: str(formData, "name"), startDate: new Date(str(formData, "startDate")), description: str(formData, "description") },
    { actorId: session.user!.id! },
  );
  redirect("/learnings");
}

export async function submitExperiment(formData: FormData) {
  const session = await requireSession();
  const experiment = await createExperiment(
    prisma,
    {
      hypothesis: str(formData, "hypothesis"),
      confounders: lines(formData, "confounders"),
      minSampleSize: Number(str(formData, "minSampleSize") || 10),
      minDurationDays: Number(str(formData, "minDurationDays") || 7),
      portfolioMapping: str(formData, "portfolioMapping") || null,
    },
    { actorId: session.user!.id! },
  );
  const variantA = str(formData, "variantALabel");
  const variantB = str(formData, "variantBLabel");
  if (variantA) {
    await addExperimentVariant(prisma, { experimentId: experiment.id, label: variantA, description: str(formData, "variantADescription") });
  }
  if (variantB) {
    await addExperimentVariant(prisma, { experimentId: experiment.id, label: variantB, description: str(formData, "variantBDescription") });
  }
  redirect("/learnings");
}

/** Proposes new experiments from the current weekly slate + prior results. Requires
 * ANTHROPIC_API_KEY. */
export async function runExperimentAgentAction() {
  const session = await requireSession();

  try {
    const slate = await listContentItems(prisma, { state: ["SCHEDULED", "PUBLISHED", "MEASURING"] });
    const priorExperiments = await listExperiments(prisma);
    const brandContext = await getBrandContextText(prisma);

    const result = await runExperimentAgent(getModelProvider(), {
      weeklySlateSummary: slate.length === 0 ? "(no active slate)" : slate.map((i) => `- ${i.title}`).join("\n"),
      priorExperiments: priorExperiments.map((e) => ({ hypothesis: e.hypothesis, status: e.status, conclusion: e.conclusion })),
      brandContext,
    });

    for (const proposal of result.experiments) {
      const experiment = await createExperiment(
        prisma,
        {
          hypothesis: proposal.hypothesis,
          confounders: proposal.confounders,
          minSampleSize: proposal.minSampleSize,
          minDurationDays: proposal.minDurationDays,
          portfolioMapping: proposal.portfolioMapping,
        },
        { actorId: session.user!.id! },
      );
      for (const variant of proposal.variants) {
        await addExperimentVariant(prisma, { experimentId: experiment.id, label: variant.label, description: variant.description });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown experiment-agent error";
    redirect(`/learnings?learningError=${encodeURIComponent(message)}`);
  }

  redirect("/learnings");
}

export async function startExperimentAction(formData: FormData) {
  const session = await requireSession();
  await startExperiment(prisma, str(formData, "experimentId"), { actorId: session.user!.id! });
  redirect("/learnings");
}

export async function concludeExperimentAction(formData: FormData) {
  const session = await requireSession();
  const status = str(formData, "status") as "CONCLUDED" | "INCONCLUSIVE";
  await concludeExperiment(
    prisma,
    str(formData, "experimentId"),
    { status, conclusion: str(formData, "conclusion") },
    { actorId: session.user!.id! },
  );
  redirect("/learnings");
}

/** Closes out the most recently completed week — real performance evaluations, audience
 * insights, experiment results, and Decision Journal overrides, compressed into a brief plus
 * candidate beliefs. Requires ANTHROPIC_API_KEY. */
export async function runWeeklyReviewAction(formData: FormData) {
  const session = await requireSession();
  const weekStartDate = new Date(str(formData, "weekStartDate"));

  try {
    const evaluations = await prisma.performanceEvaluation.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const insights = await listAudienceInsights(prisma);
    const experiments = await listExperiments(prisma);
    const overrides = await prisma.auditLog.findMany({
      where: { action: { contains: "OVERRIDE" } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const contracts = await prisma.productionContract.findMany({
      take: 20,
      orderBy: { id: "desc" },
    });
    const brandContext = await getBrandContextText(prisma);

    const result = await runWeeklyReviewAgent(getModelProvider(), {
      weekSummary:
        evaluations.length === 0
          ? "(no performance evaluations yet)"
          : evaluations.map((e) => `- ${e.overallSummary}`).join("\n"),
      audienceSignalsSummary:
        insights.length === 0 ? "(no audience insights yet)" : insights.map((i) => `- ${i.description}`).join("\n"),
      experimentsSummary:
        experiments.length === 0
          ? "(no experiments yet)"
          : experiments.map((e) => `- [${e.status}] ${e.hypothesis}`).join("\n"),
      productionCostSummary:
        contracts.length === 0
          ? "(no production cost data yet)"
          : `${contracts.length} production contracts on record, average editing budget ${
              Math.round(
                contracts.reduce((sum, c) => sum + (c.humanEditingBudgetMinutes ?? 0), 0) / contracts.length,
              )
            } minutes.`,
      overridesSummary:
        overrides.length === 0 ? "(no recorded overrides this period)" : overrides.map((o) => `- ${o.action}`).join("\n"),
      brandContext,
    });

    await recordWeeklyBrief(
      prisma,
      {
        weekStartDate,
        whatHappened: result.whatHappened,
        whatItMeans: result.whatItMeans,
        stillUncertain: result.stillUncertain,
        recommendationsForNextWeek: result.recommendationsForNextWeek,
      },
      { actorId: session.user!.id! },
    );

    for (const candidate of result.candidateBeliefs) {
      const evidence = await listEvidenceEntries(prisma);
      const cited = evidence.filter((e) => candidate.evidenceStatements.includes(e.statement));
      if (cited.length === 0) continue; // skip a candidate the ledger can't actually back
      await proposeBelief(
        prisma,
        {
          statement: candidate.statement,
          causalClaim: candidate.causalClaim,
          isExperimentalEvidence: candidate.isExperimentalEvidence,
          evidenceIds: cited.map((e) => e.id),
          sampleSize: candidate.sampleSize,
          applicablePlatform: candidate.applicablePlatform,
          applicableTopic: candidate.applicableTopic,
          applicableFormat: candidate.applicableFormat,
          confidence: candidate.confidence,
          confounders: candidate.confounders,
          contradictoryEvidence: candidate.contradictoryEvidence,
          retestConditions: candidate.retestConditions,
        },
        { actorId: session.user!.id! },
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown weekly-review error";
    redirect(`/learnings?learningError=${encodeURIComponent(message)}`);
  }

  redirect("/learnings");
}

/**
 * Phase 8 — the one way to implement spec's "HERO/high-risk/ambiguous content may require
 * human review permanently": a human sets a permanent ceiling on a (subsystem, tier) pair, no
 * amount of accumulated approved outcomes can escalate past it. Human-only by construction —
 * this Server Action is the only caller of `setAutonomyCeiling` in the app.
 */
export async function submitAutonomyCeiling(formData: FormData) {
  const session = await requireSession();
  await setAutonomyCeiling(
    prisma,
    str(formData, "subsystem") as never,
    str(formData, "productionTier") as never,
    Number(str(formData, "ceilingLevel") || 4),
    { actorId: session.user!.id! },
  );
  redirect("/learnings");
}

/** The global kill switch (spec: "use feature flags for risky/new autonomous behavior") —
 * flipping this on forces every subsystem back to level-0 behavior instantly, regardless of
 * what's actually been earned. */
export async function toggleShadowOnly(formData: FormData) {
  const session = await requireSession();
  await setFlag(prisma, {
    key: AUTONOMY_SHADOW_ONLY_FLAG,
    enabled: str(formData, "enabled") === "true",
    actor: session.user!.id!,
    actorType: "HUMAN",
  });
  redirect("/learnings");
}

/** Runs the Taste Learner over accumulated feedback, per artifact type (spec §7 Human Taste
 * Model) — interpretations are stored alongside the raw feedback, never replacing it, and a
 * single instance is never turned into a universal rule (TASTE_LEARNER.md). */
export async function refreshTasteModelAction() {
  const session = await requireSession();
  let summary = "";
  try {
    const results = await refreshTasteModel(prisma, getModelProvider(), { actorId: session.user!.id! });
    summary = results.map((r) => `${r.artifactType}: ${r.status}${r.error ? ` (${r.error})` : ""}`).join(" · ") || "No feedback recorded yet.";
  } catch (err) {
    redirect(`/learnings?learningError=${encodeURIComponent(err instanceof Error ? err.message : "Taste refresh failed")}`);
  }
  redirect(`/learnings?tasteRefreshed=${encodeURIComponent(summary)}`);
}

/** "Forget this" on a learned motion preference: records a counter-signal (FORGET) so the
 * profile stops using that preference's evidence so far — the evidence itself is kept
 * (audit trails are permanent). New edits can re-teach it. */
export async function forgetMotionPreferenceAction(formData: FormData) {
  const session = await requireSession();
  const key = str(formData, "key");
  if (!key) redirect("/learnings");
  await forgetMotionPreference(prisma, { key, label: str(formData, "label") || null, actorId: session.user!.id! });
  redirect("/learnings#motion-style");
}
