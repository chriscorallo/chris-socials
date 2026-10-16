import {
  getLatestEditPlan,
  getLatestScriptVersion,
  getProductionContract,
  getLatestQCReport,
  getQCIssuesForReport,
  recordReplannedEditPlan,
  parseTranscriptWords,
  MAX_REPAIR_ATTEMPTS,
  type PrismaClient,
} from "@chris/domain";
import {
  EditPlanOutputSchema,
  runEditPlannerAgent,
  getBrandContextText,
  type ModelProvider,
  type EditPlanRepairContext,
} from "@chris/agents";
import type { StorageAdapter } from "@chris/media";
import { renderContentItem } from "./render-job";
import { runQualityGateForContentItem } from "./quality-gate-job";

export interface AutoRepairStep {
  iteration: number;
  action: "QUALITY_GATE" | "REVISE_PLAN" | "RENDER";
  outcome: string;
}

export interface AutoRepairResult {
  finalState: string;
  steps: AutoRepairStep[];
  /** Why the loop stopped without reaching READY, when it didn't. */
  stoppedBecause: string | null;
}

/** Gates a re-edit can actually fix. FACTUAL/BRAND/CREATIVE blocks come from the script or
 * research (Claims Gate, Brand Guardian) — re-cutting the same footage can't change them, so
 * the loop stops and hands those to Chris instead of burning render budget. */
const REPAIRABLE_REASON = /technical|visual qa|overlay|collision|qc fail/i;

/**
 * Spec §9 step 15 — EDIT -> RENDER -> INSPECT -> FIX -> RENDER -> REINSPECT, with the shared
 * repair budget (MAX_REPAIR_ATTEMPTS across the whole revision chain — see
 * packages/domain/src/render-record.ts). Starting from RENDERED (runs the gate first) or
 * QC_REPAIR:
 *   1. collect the blocking issues (Quality Gate QCIssues, or the failed technical-QC checks
 *      when the render itself failed QC),
 *   2. ask the Edit Planner for a minimal revision addressing exactly those issues,
 *   3. record it as a revision of the previous plan (same chain, same budget), re-render,
 *   4. re-run the Quality Gate; repeat until READY, QC_BLOCKED, or a non-visual block.
 * Every step is persisted by the domain calls it makes; this function only sequences them.
 */
export async function autoRepairContentItem(
  db: PrismaClient,
  storage: StorageAdapter,
  provider: ModelProvider,
  contentItemId: string,
  options: { fontPath?: string; maxIterations?: number } = {},
  actor: { actorId: string },
): Promise<AutoRepairResult> {
  const steps: AutoRepairStep[] = [];
  const maxIterations = options.maxIterations ?? MAX_REPAIR_ATTEMPTS + 1;
  const stateOf = async () =>
    (await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId } })).currentState;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const state = await stateOf();

    if (state === "RENDERED") {
      const gate = await runQualityGateForContentItem(db, storage, provider, contentItemId, actor);
      steps.push({ iteration, action: "QUALITY_GATE", outcome: `${gate.overallStatus}${gate.reasons.length ? `: ${gate.reasons.join("; ")}` : ""}` });
      continue;
    }
    if (state !== "QC_REPAIR") {
      return { finalState: state, steps, stoppedBecause: state === "READY" ? null : `Item is at ${state}` };
    }

    const editPlanRow = await getLatestEditPlan(db, contentItemId);
    if (!editPlanRow) return { finalState: state, steps, stoppedBecause: "No edit plan to revise." };
    const latestRender = await db.render.findFirst({ where: { contentItemId }, orderBy: { createdAt: "desc" } });

    // What to fix: the latest Quality Gate's issues if it inspected the latest render;
    // otherwise the render failed technical QC before ever reaching the gate.
    const qcReport = await getLatestQCReport(db, contentItemId);
    let qcIssues: EditPlanRepairContext["qcIssues"] = [];
    if (qcReport && latestRender && qcReport.renderId === latestRender.id) {
      const reasons = (qcReport.reasons as string[] | null) ?? [];
      const nonVisual = [qcReport.factualStatus, qcReport.brandStatus, qcReport.creativeStatus].includes("BLOCK");
      if (nonVisual) {
        return {
          finalState: state,
          steps,
          stoppedBecause:
            "Blocked on a factual/brand/creative gate — those come from the script, not the edit, so " +
            `re-cutting can't fix them. ${reasons.filter((r) => !REPAIRABLE_REASON.test(r)).join("; ")}`.trim(),
        };
      }
      qcIssues = (await getQCIssuesForReport(db, qcReport.id)).map((i) => ({
        category: i.category,
        severity: i.severity,
        description: i.description,
        timestampSeconds: i.timestampSeconds,
        recommendedRepair: i.recommendedRepair,
      }));
    } else if (latestRender?.technicalQCReport) {
      const report = latestRender.technicalQCReport as { checks?: { name: string; passed: boolean; detail: string; severity?: string }[] };
      qcIssues = (report.checks ?? [])
        .filter((c) => !c.passed && c.severity !== "WARN")
        .map((c) => ({ category: `TECHNICAL_${c.name.toUpperCase()}`, severity: "BLOCKING", description: c.detail }));
    }
    if (qcIssues.length === 0) {
      return { finalState: state, steps, stoppedBecause: "QC_REPAIR with no recorded issues to act on." };
    }

    const takeSelection = await db.takeSelection.findUniqueOrThrow({ where: { id: editPlanRow.takeSelectionId } });
    const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id: takeSelection.selectedMediaAssetId } });
    const contract = await getProductionContract(db, contentItemId);
    if (!contract) return { finalState: state, steps, stoppedBecause: "No Production Contract." };
    const script = await getLatestScriptVersion(db, contentItemId);
    const brandContext = await getBrandContextText(db);

    const revised = await runEditPlannerAgent(provider, {
      contract,
      scriptText: script?.spokenScript ?? contract.primaryIdea,
      takeTranscript: asset.transcript,
      takeWords: parseTranscriptWords(asset.transcriptWords),
      sourceDurationSeconds: asset.durationSeconds,
      brandContext,
      repairContext: { previousPlan: EditPlanOutputSchema.parse(editPlanRow.plan), qcIssues },
    });
    const revisionReason = `Auto-repair: ${qcIssues.map((i) => i.category).join(", ")}`;
    await recordReplannedEditPlan(
      db,
      {
        contentItemId,
        takeSelectionId: editPlanRow.takeSelectionId,
        productionTier: revised.productionTier,
        targetDurationSeconds: revised.targetDurationSeconds,
        doNothingElse: revised.doNothingElse,
        plan: revised,
        revisionOfEditPlanId: editPlanRow.id,
        revisionReason,
      },
      { actorId: actor.actorId, actorType: "SYSTEM" },
    );
    steps.push({ iteration, action: "REVISE_PLAN", outcome: revisionReason });

    const render = await renderContentItem(db, storage, contentItemId, { fontPath: options.fontPath }, actor);
    steps.push({ iteration, action: "RENDER", outcome: render.status === "SUCCESS" ? `rendered → ${await stateOf()}` : `failed: ${render.errorMessage}` });
    if (render.status !== "SUCCESS") {
      return { finalState: await stateOf(), steps, stoppedBecause: `Render failed: ${render.errorMessage}` };
    }
  }

  const finalState = await stateOf();
  return { finalState, steps, stoppedBecause: finalState === "READY" ? null : "Iteration limit reached." };
}
