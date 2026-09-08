import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getLatestEditPlan,
  getLatestResearchPacket,
  getLatestScriptVersion,
  recordQualityGateResult,
  aggregateHardGates,
  brandGateFromScores,
  creativeGateFromScore,
  technicalGateFromIssues,
  type PrismaClient,
  type QCIssueInput,
  type GateStatus,
} from "@chris/domain";
import { EditPlanOutputSchema, runVisualQAAgent, type ModelProvider } from "@chris/agents";
import { probeMedia, extractFrames, pickSampleTimestamps, checkOverlayCollisions } from "@chris/media";
import type { StorageAdapter } from "@chris/media";

export interface QualityGateJobResult {
  qcReportId: string;
  overallStatus: GateStatus;
  gates: { factual: GateStatus; technical: GateStatus; brand: GateStatus; creative: GateStatus };
  reasons: string[];
}

const DEFAULT_MAX_FRAMES = 6;

/**
 * Runs the Phase 4 Hard Gate quality check on a ContentItem currently at RENDERED (spec §9
 * step 16), and persists+transitions via recordQualityGateResult (packages/domain). Combines:
 *
 * - FACTUAL: the ClaimsGateResult already recorded on the ResearchPacket at RESEARCHING time
 *   (Phase 2) — this system doesn't re-run Claims Gate against the final edit; Claims Gate's
 *   contract (/docs/AGENT_CONTRACTS.md) is ResearchPacket + ScriptVersion, not Render, and an
 *   EditPlan can only ever trim/caption the script's spoken content, never add a new claim.
 * - TECHNICAL: the deterministic TechnicalQCReport from the render itself (Phase 3), escalated
 *   to BLOCK by any BLOCKING-severity finding from Visual QA or the overlay-collision check.
 * - BRAND / CREATIVE: the BrandGuardianReport already recorded on the ScriptVersion (Phase 2),
 *   reduced to PASS/BLOCK via threshold — see /docs/DECISIONS.md for why Brand Guardian's
 *   existing scores are reused here instead of inventing a second brand-review agent call.
 *
 * Visual QA (this phase's new agent) is the only actual model call this job makes; frame
 * extraction and overlay-collision checking are both deterministic (packages/media).
 */
export async function runQualityGateForContentItem(
  db: PrismaClient,
  storage: StorageAdapter,
  modelProvider: ModelProvider,
  contentItemId: string,
  actor: { actorId: string },
  options: { maxFrames?: number } = {},
): Promise<QualityGateJobResult> {
  const render = await db.render.findFirst({
    where: { contentItemId, status: "SUCCESS" },
    orderBy: { createdAt: "desc" },
  });
  if (!render || !render.storageKey) {
    throw new Error(`No successful Render with a stored output found for content item ${contentItemId}.`);
  }

  const technicalQC = render.technicalQCReport as { overall?: "PASS" | "FAIL" } | null;
  const technicalBase: GateStatus = technicalQC?.overall === "PASS" ? "PASS" : "BLOCK";

  const editPlanRow = await getLatestEditPlan(db, contentItemId);
  if (!editPlanRow) {
    throw new Error(`No EditPlan found for content item ${contentItemId}.`);
  }
  const plan = EditPlanOutputSchema.parse(editPlanRow.plan);

  const researchPacket = await getLatestResearchPacket(db, contentItemId);
  const scriptVersion = await getLatestScriptVersion(db, contentItemId);

  const claimsGateResult = researchPacket?.claimsGateResult as
    | { result?: string; blockReason?: string | null }
    | null;
  // RESEARCH_BLOCKED items never reach FILMED/RENDERED at all (see /docs/STATE_MACHINE.md),
  // so a genuine BLOCK here would mean the persisted record was mutated after the fact — not
  // reachable through normal flow, but checked explicitly rather than assumed away.
  const factualStatus: GateStatus = claimsGateResult?.result === "BLOCK" ? "BLOCK" : "PASS";

  const brandGuardianReport = scriptVersion?.brandGuardianReport as
    | { brandScore?: number; voiceScore?: number; originalityScore?: number }
    | null;
  const brandScore = brandGuardianReport?.brandScore ?? 0;
  const voiceScore = brandGuardianReport?.voiceScore ?? 0;
  const originalityScore = brandGuardianReport?.originalityScore ?? 0;
  const brandStatus = brandGateFromScores(brandScore, voiceScore);
  const creativeStatus = creativeGateFromScore(originalityScore);

  // Deterministic overlay-collision check — pure code, no model call, no I/O beyond what's
  // already in memory (the EditPlan itself).
  const overlayCollisions = checkOverlayCollisions(plan.textOverlays);
  const collisionIssues: QCIssueInput[] = overlayCollisions.map((c) => ({
    category: "CAPTION_COLLISION",
    description: `"${c.a}" and "${c.b}" occupy the same ${c.position} region from ${c.overlapStartSeconds}s to ${c.overlapEndSeconds}s.`,
    severity: "BLOCKING",
    timestampSeconds: c.overlapStartSeconds,
    recommendedRepair: "Stagger the two overlays in time, or move one to a different screen position.",
    source: "OVERLAY_COLLISION",
  }));

  const workDir = await mkdtemp(join(tmpdir(), "chris-quality-gate-"));
  // No initializer: either both are assigned before the try block ends, or it throws and
  // control never reaches the code below that reads them — an initial [] / null here would be
  // dead weight, not a real fallback.
  let visualQAIssues: QCIssueInput[];
  let visualQAImpression: string | null;
  try {
    const videoBytes = await storage.get(render.storageKey);
    const videoPath = join(workDir, "render.mp4");
    await writeFile(videoPath, videoBytes);

    const probed = await probeMedia(videoPath);
    const timestamps = pickSampleTimestamps(
      probed.durationSeconds,
      options.maxFrames ?? DEFAULT_MAX_FRAMES,
    );
    const frames = await extractFrames(videoPath, timestamps);

    const overlaySummary =
      plan.textOverlays.length === 0
        ? "(none planned)"
        : plan.textOverlays
            .map((o) => `- "${o.text}" [${o.position}] ${o.startSeconds}s-${o.endSeconds}s (${o.style})`)
            .join("\n");

    const visualQAReport = await runVisualQAAgent(modelProvider, {
      frames,
      durationSeconds: probed.durationSeconds,
      productionTier: plan.productionTier,
      textOverlaySummary: overlaySummary,
      // Visual QA judges pixels, not brand voice — no Brand Constitution text is relevant to
      // "is there a caption over the speaker's mouth." Kept as a parameter (rather than
      // dropped) for consistency with every other agent's call shape and in case a future
      // check genuinely needs it (e.g. tier-appropriateness against brand production
      // standards).
      brandContext: "",
    });
    visualQAImpression = visualQAReport.overallImpression;
    visualQAIssues = visualQAReport.issues.map((issue) => ({
      category: issue.category,
      description: issue.description,
      severity: issue.severity,
      timestampSeconds: issue.timestampSeconds,
      recommendedRepair: issue.recommendedRepair,
      source: "VISUAL_QA",
    }));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  const allIssues = [...collisionIssues, ...visualQAIssues];
  const technicalStatus = technicalGateFromIssues(technicalBase, allIssues);

  const gates = { factual: factualStatus, technical: technicalStatus, brand: brandStatus, creative: creativeStatus };

  const reasonsByGate: Partial<Record<"factual" | "technical" | "brand" | "creative", string>> = {};
  if (factualStatus === "BLOCK") {
    reasonsByGate.factual = claimsGateResult?.blockReason ?? "Claims Gate result was BLOCK";
  }
  if (technicalStatus === "BLOCK") {
    reasonsByGate.technical =
      technicalBase === "BLOCK"
        ? "Technical QC FAIL"
        : "A Visual QA or overlay-collision finding was BLOCKING severity";
  }
  if (brandStatus === "BLOCK") {
    reasonsByGate.brand = `Brand/voice score below threshold (brand=${brandScore}, voice=${voiceScore})`;
  }
  if (creativeStatus === "BLOCK") {
    reasonsByGate.creative = `Originality score below threshold (${originalityScore})`;
  }

  const aggregation = aggregateHardGates(gates, reasonsByGate);

  const qcReport = await recordQualityGateResult(
    db,
    {
      contentItemId,
      renderId: render.id,
      gates,
      reasons: aggregation.reasons,
      visualQAImpression,
      issues: allIssues,
    },
    actor,
  );

  return { qcReportId: qcReport.id, overallStatus: qcReport.overallStatus, gates, reasons: aggregation.reasons };
}
