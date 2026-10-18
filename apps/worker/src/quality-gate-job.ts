import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getLatestEditPlan,
  getLatestResearchPacket,
  getLatestScriptVersion,
  recordQualityGateResult,
  parseTranscriptWords,
  aggregateHardGates,
  isScriptVersionFilmable,
  brandGateFromScores,
  creativeGateFromScore,
  technicalGateFromIssues,
  type PrismaClient,
  type QCIssueInput,
  type GateStatus,
} from "@chris/domain";
import {
  EditPlanOutputSchema,
  runVisualQAAgent,
  groundedNumbers,
  numberIsGrounded,
  numbersShownBy,
  type ModelProvider,
  type MotionResearchInput,
} from "@chris/agents";
import {
  probeMedia,
  extractFrames,
  pickSampleTimestamps,
  checkOverlayCollisions,
  checkCaptionOverlayCollisions,
  DEFAULT_CAPTIONS_CONFIG,
  EditTimelineSchema,
  timelineCaptionChunks,
  findTimelineCollisions,
  nodeMeasureText,
  type CaptionCollision,
  type TimelineVisual,
} from "@chris/media";
import type { StorageAdapter } from "@chris/media";

export interface QualityGateJobResult {
  qcReportId: string;
  overallStatus: GateStatus;
  gates: { factual: GateStatus; technical: GateStatus; brand: GateStatus; creative: GateStatus };
  reasons: string[];
}

const DEFAULT_MAX_FRAMES = 6;

function captionCollisionToIssue(c: CaptionCollision): QCIssueInput {
  return {
    category: "CAPTION_COLLISION",
    description: `Caption "${c.captionText}" overlaps overlay "${c.overlayText}" from ${c.overlapStartSeconds}s to ${c.overlapEndSeconds}s with no free position to move it to.`,
    severity: "BLOCKING",
    timestampSeconds: c.overlapStartSeconds,
    recommendedRepair: "Shorten or move the overlay, shift its timing off this phrase, or move captions to CENTER for this stretch.",
    source: "OVERLAY_COLLISION",
  };
}

export interface UngroundedVisualNumbers {
  visualId: string;
  template: string;
  start: number;
  end: number;
  numbers: Array<{ value: number; field: string }>;
}

/**
 * On-screen numbers in motion graphics vs the fact-checked sources — PURE and deterministic.
 * Every number a visual would show (numbersShownBy: numeric props and digits/spelled-out
 * numbers inside its strings) must match a number from the research packet (numeric inputs,
 * FACT statements, calculation notes, primary claim) or the Claims-Gate-passed script, with
 * the same formatting/rounding tolerance the Motion Designer applies (numberIsGrounded). This
 * is the Quality Gate's second line behind the Motion Designer's own check: Chris can type
 * any number into a graphic in the editor, and nothing on screen ships unchecked.
 */
export function findUngroundedVisualNumbers(
  visuals: Pick<TimelineVisual, "id" | "template" | "props" | "start" | "end">[],
  research: MotionResearchInput | null,
  script: { spokenScript: string } | null,
): UngroundedVisualNumbers[] {
  const allowed = groundedNumbers(research, script);
  const out: UngroundedVisualNumbers[] = [];
  for (const v of visuals) {
    const bad = numbersShownBy(v.template, v.props as Record<string, unknown>).filter((n) => !numberIsGrounded(n.value, allowed));
    if (bad.length) out.push({ visualId: v.id, template: v.template, start: v.start, end: v.end, numbers: bad });
  }
  return out;
}

const TEMPLATE_NAMES: Record<string, string> = {
  KINETIC_TEXT: "kinetic text",
  NUMBER_COUNTER: "number counter",
  STAT_CARD: "stat card",
  BAR_CHART: "bar chart",
  LINE_CHART: "line chart",
  COMPARISON: "comparison",
  PERCENT_RING: "percent ring",
  LIST_STEPS: "list",
  ICON_3D: "3D icon",
  MONEY_STACK_3D: "money stack",
  CALLOUT: "callout",
  TIMELINE: "timeline",
  DEFINITION: "definition",
  TITLE_CARD: "title card",
};

/** One sentence naming every offending number, for the FACTUAL block reason. */
export function describeUngroundedVisualNumbers(found: UngroundedVisualNumbers[]): string {
  const parts = found.map((f) => {
    const nums = [...new Set(f.numbers.map((n) => n.value.toLocaleString("en-US")))].join(", ");
    return `the ${TEMPLATE_NAMES[f.template] ?? f.template} at ${f.start.toFixed(1)}s shows ${nums}`;
  });
  return `On-screen numbers aren't in the fact-checked research or script: ${parts.join("; ")}. Fix the graphic to use a researched number, or remove it.`;
}

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

  // FACTUAL fails CLOSED. The authoritative verdict is the Claims Gate run against the final
  // script's own wording (ScriptVersion.scriptClaimsGateResult — added so numbers the Script
  // Agent or a human edit introduced are checked too); the research-packet verdict is the
  // fallback for scripts recorded before that existed. No verdict at all used to PASS
  // silently (e.g. after a manual RESEARCHING -> RESEARCHED skip); now it BLOCKs, except for
  // content whose contract explicitly declares no factual surface (research depth NONE + low
  // factual risk — opinion/lifestyle pieces). See /docs/DECISIONS.md ("FACTUAL gate fails
  // closed").
  type ClaimsVerdict = { result?: string; blockReason?: string | null } | null;
  const scriptVerdict = (scriptVersion?.scriptClaimsGateResult ?? null) as ClaimsVerdict;
  const researchVerdict = (researchPacket?.claimsGateResult ?? null) as ClaimsVerdict;
  // A latest script a person wrote or pasted in (HUMAN edit, IMPORTED from ChatGPT) that was
  // never checked must not borrow an older research verdict: its own wording is unchecked.
  // See docs/decisions-pending/chatgpt-scripts.md.
  const latestUncheckedNonAgent = !!scriptVersion && scriptVersion.authorType !== "AGENT" && !scriptVerdict?.result;
  const claimsGateResult = scriptVerdict?.result ? scriptVerdict : latestUncheckedNonAgent ? null : researchVerdict;
  const contract = await db.productionContract.findUnique({ where: { contentItemId } });
  const factCheckExempt = contract?.researchDepth === "NONE" && contract?.factualRisk === "LOW";
  let factualStatus: GateStatus;
  let factualBlockReason: string | null = null;
  if (claimsGateResult?.result === "BLOCK") {
    factualStatus = "BLOCK";
    factualBlockReason = claimsGateResult.blockReason ?? "Claims Gate result was BLOCK";
  } else if (claimsGateResult?.result) {
    factualStatus = "PASS";
  } else if (factCheckExempt) {
    factualStatus = "PASS";
  } else {
    factualStatus = "BLOCK";
    factualBlockReason = latestUncheckedNonAgent
      ? scriptVersion!.authorType === "IMPORTED"
        ? "The script was imported from ChatGPT and its claims haven't been fact-checked yet — check them before this can pass."
        : "The latest script was edited by hand and hasn't been re-checked by the Claims Gate — re-check it before this can pass."
      : "No Claims Gate verdict on record for this item's research or script — run the AI " +
        "Research -> Script pipeline (or re-gate the edited script) before this can pass.";
  }

  const brandGuardianReport = scriptVersion?.brandGuardianReport as
    | { brandScore?: number; voiceScore?: number; originalityScore?: number }
    | null;
  const brandScore = brandGuardianReport?.brandScore ?? 0;
  const voiceScore = brandGuardianReport?.voiceScore ?? 0;
  const originalityScore = brandGuardianReport?.originalityScore ?? 0;
  const brandStatus = brandGateFromScores(brandScore, voiceScore);
  const creativeStatus = creativeGateFromScore(originalityScore);

  // A finishing edit (plan.timeline) is what rendered — check ITS texts and captions with the
  // exact layouts the timeline renderer drew. Plain plans keep the original checks.
  const rawTimeline = (editPlanRow.plan as Record<string, unknown> | null)?.timeline;
  const parsedTimeline = rawTimeline != null ? EditTimelineSchema.safeParse(rawTimeline) : null;
  const timeline = parsedTimeline?.success ? parsedTimeline.data : null;

  // FACTUAL also covers numbers drawn by motion graphics (deterministic, no model call).
  if (timeline && timeline.visuals.length > 0) {
    const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    const research: MotionResearchInput | null = researchPacket
      ? {
          primaryClaim: researchPacket.primaryClaim,
          numericInputs: asArray<{ label: string; value: string }>(researchPacket.numericInputs),
          facts: asArray<{ statement: string; type: string }>(researchPacket.facts),
          calculationNotes: researchPacket.calculationNotes,
        }
      : null;
    const scripts = await db.scriptVersion.findMany({ where: { contentItemId }, orderBy: { createdAt: "desc" } });
    const gated = scripts.find((s) => isScriptVersionFilmable(s).ok) ?? null;
    const ungrounded = findUngroundedVisualNumbers(timeline.visuals, research, gated ? { spokenScript: gated.spokenScript } : null);
    if (ungrounded.length > 0) {
      const reason = describeUngroundedVisualNumbers(ungrounded);
      factualStatus = "BLOCK";
      factualBlockReason = factualBlockReason ? `${factualBlockReason} Also: ${reason}` : reason;
    }
  }

  const collisionIssues: QCIssueInput[] = [];
  if (timeline) {
    // Deterministic, pure layout arithmetic — no model call.
    const assetIds = [...new Set(timeline.clips.map((c) => c.mediaAssetId))];
    const assets = await db.mediaAsset.findMany({ where: { id: { in: assetIds } } });
    const wordsByAsset = Object.fromEntries(assets.map((a) => [a.id, parseTranscriptWords(a.transcriptWords)]));
    const chunks = timelineCaptionChunks(timeline, wordsByAsset);
    for (const c of findTimelineCollisions(timeline, chunks, nodeMeasureText)) {
      collisionIssues.push(
        c.kind === "TEXT_TEXT"
          ? {
              category: "CAPTION_COLLISION",
              description: `"${c.a}" and "${c.b}" overlap on screen from ${c.overlapStartSeconds}s to ${c.overlapEndSeconds}s.`,
              severity: "BLOCKING",
              timestampSeconds: c.overlapStartSeconds,
              recommendedRepair: "Stagger the two texts in time, or move one of them.",
              source: "OVERLAY_COLLISION",
            }
          : captionCollisionToIssue({
              captionText: c.a,
              overlayText: c.b,
              overlapStartSeconds: c.overlapStartSeconds,
              overlapEndSeconds: c.overlapEndSeconds,
            }),
      );
    }
  } else {
    // Deterministic overlay-collision check — pure code, no model call, no I/O beyond what's
    // already in memory (the EditPlan itself).
    const overlayCollisions = checkOverlayCollisions(plan.textOverlays);
    for (const c of overlayCollisions) {
      collisionIssues.push({
        category: "CAPTION_COLLISION",
        description: `"${c.a}" and "${c.b}" occupy the same ${c.position} region from ${c.overlapStartSeconds}s to ${c.overlapEndSeconds}s.`,
        severity: "BLOCKING",
        timestampSeconds: c.overlapStartSeconds,
        recommendedRepair: "Stagger the two overlays in time, or move one to a different screen position.",
        source: "OVERLAY_COLLISION",
      });
    }

    // Word captions vs overlays — also deterministic. The renderer already relocates captions
    // around overlays where it can; only collisions it couldn't avoid are reported here.
    const takeSelection = await db.takeSelection.findUnique({ where: { id: editPlanRow.takeSelectionId } });
    const sourceAsset = takeSelection
      ? await db.mediaAsset.findUnique({ where: { id: takeSelection.selectedMediaAssetId } })
      : null;
    const captionCollisions = checkCaptionOverlayCollisions({
      overlays: plan.textOverlays,
      captions: plan.captions ?? DEFAULT_CAPTIONS_CONFIG,
      sourceWords: parseTranscriptWords(sourceAsset?.transcriptWords) ?? [],
      segments: plan.segments,
      canvas: plan.targetDimensions ?? { width: 1080, height: 1920 },
    });
    for (const c of captionCollisions) collisionIssues.push(captionCollisionToIssue(c));
  }

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

    const overlaySummary = timeline
      ? timeline.texts.length === 0
        ? "(none planned)"
        : timeline.texts.map((t) => `- "${t.text}" at (${t.x}, ${t.y}) ${t.start}s-${t.end}s (${t.preset})`).join("\n")
      : plan.textOverlays.length === 0
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
    reasonsByGate.factual = factualBlockReason ?? "Claims Gate result was BLOCK";
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
