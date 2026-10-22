import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getLatestEditPlan,
  getLatestResearchPacket,
  getLatestScriptVersion,
  recordQualityGateResult,
  recordLateQualityCheck,
  applyOwnerQualityOverride,
  FactualConfirmationRequiredError,
  AI_QUALITY_CHECKS,
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
  extractNumbers,
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
  directorOwnedVisualIds,
  auditSplices,
  refineWordEdges,
  type CaptionCollision,
  type EditTimeline,
  type TimelineVisual,
} from "@chris/media";
import { storedSpliceAnalysisFor } from "./splice-store";
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


/** Everything the Quality Gate decides WITHOUT a model call — shared by the full gate and the
 * owner's "skip the AI check" path, so both see exactly the same technical/factual facts. */
interface DeterministicChecks {
  render: { id: string; storageKey: string };
  plan: ReturnType<typeof EditPlanOutputSchema.parse>;
  timeline: EditTimeline | null;
  technicalBase: GateStatus;
  collisionIssues: QCIssueInput[];
  factualStatus: GateStatus;
  factualBlockReason: string | null;
  /** The Claims Gate said BLOCK (a real finding, not just "no verdict"). */
  claimsGateBlocked: boolean;
  ungroundedVisuals: UngroundedVisualNumbers[];
  allowedNumbers: number[];
  wordsByAsset: Record<string, ReturnType<typeof parseTranscriptWords>>;
  brand: { status: GateStatus; brandScore: number; voiceScore: number; originalityScore: number; creativeStatus: GateStatus; onRecord: boolean };
}

async function runDeterministicChecks(db: PrismaClient, contentItemId: string): Promise<DeterministicChecks> {
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

  // Numbers the video may show: the fact-checked research + the Claims-Gate-passed script.
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
  const gatedScript = gated ? { spokenScript: gated.spokenScript } : null;

  // FACTUAL also covers numbers drawn by motion graphics (deterministic, no model call).
  let ungroundedVisuals: UngroundedVisualNumbers[] = [];
  if (timeline && timeline.visuals.length > 0) {
    // Numbers Chris put on screen himself through the Director chat (unchanged since) are his own
    // (provenance "Chris via Director chat", plan.director) — see docs/DECISIONS.md "Director chat".
    const owned = directorOwnedVisualIds(editPlanRow.plan, timeline.visuals);
    ungroundedVisuals = findUngroundedVisualNumbers(timeline.visuals.filter((v) => !owned.has(v.id)), research, gatedScript);
    if (ungroundedVisuals.length > 0) {
      const reason = describeUngroundedVisualNumbers(ungroundedVisuals);
      factualStatus = "BLOCK";
      factualBlockReason = factualBlockReason ? `${factualBlockReason} Also: ${reason}` : reason;
    }
  }

  const collisionIssues: QCIssueInput[] = [];
  let wordsByAsset: Record<string, ReturnType<typeof parseTranscriptWords>> = {};
  if (timeline) {
    // Deterministic, pure layout arithmetic — no model call.
    const assetIds = [...new Set(timeline.clips.map((c) => c.mediaAssetId))];
    const assets = await db.mediaAsset.findMany({ where: { id: { in: assetIds } } });
    wordsByAsset = Object.fromEntries(assets.map((a) => [a.id, parseTranscriptWords(a.transcriptWords)]));
    // The free splice audit (gate G1, docs/PREMIUM_EDITOR_PLAN.md round 2): every cut checked
    // against the take's voice — a gap, a clipped word, a level step — with the cut index and
    // delta, so a fix can retime it. MAJOR (recorded, not blocking) until the baseline on the
    // golden set shows the splice engine meets the bar; then BLOCKING (DECISIONS 2026-10-21).
    for (const assetId of assetIds) {
      const words = wordsByAsset[assetId];
      if (!words?.length) continue;
      const analysis = await storedSpliceAnalysisFor(db, contentItemId, assetId);
      const refined = analysis ? refineWordEdges(words, analysis) : words;
      for (const f of auditSplices(timeline, assetId, refined, analysis)) {
        collisionIssues.push({
          category: `SPLICE_${f.kind}`,
          description: `Cut ${f.index + 1} at ${f.atS}s: ${f.detail}.`,
          severity: "MAJOR",
          timestampSeconds: f.atS,
          recommendedRepair: f.kind === "GAP" ? "Tighten the cut (move the cut-out earlier or the cut-in later)." : f.kind === "CLIPPED_WORD" ? "Move the cut off the voice." : "Level the two sides of the cut.",
          source: "SPLICE_AUDIT",
        });
      }
    }
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

  return {
    render: { id: render.id, storageKey: render.storageKey },
    plan,
    timeline,
    technicalBase,
    collisionIssues,
    factualStatus,
    factualBlockReason,
    claimsGateBlocked: claimsGateResult?.result === "BLOCK",
    ungroundedVisuals,
    allowedNumbers: groundedNumbers(research, gatedScript),
    wordsByAsset,
    brand: { status: brandStatus, brandScore, voiceScore, originalityScore, creativeStatus, onRecord: !!brandGuardianReport },
  };
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
 *
 * `options.lateCheck` ("Run the AI check now" on a video the owner already sent to the
 * calendar without it): same checks, recorded as a QCReport for that render WITHOUT a state
 * transition (recordLateQualityCheck) — a later BLOCK then supersedes the override in preflight.
 */
export async function runQualityGateForContentItem(
  db: PrismaClient,
  storage: StorageAdapter,
  modelProvider: ModelProvider,
  contentItemId: string,
  actor: { actorId: string },
  options: { maxFrames?: number; lateCheck?: boolean } = {},
): Promise<QualityGateJobResult> {
  const d = await runDeterministicChecks(db, contentItemId);
  const { render, plan, timeline, technicalBase, collisionIssues, factualStatus, factualBlockReason } = d;
  const { brandScore, voiceScore, originalityScore } = d.brand;
  const brandStatus = d.brand.status;
  const creativeStatus = d.brand.creativeStatus;

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

  const record = options.lateCheck ? recordLateQualityCheck : recordQualityGateResult;
  const qcReport = await record(
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

// ---------------------------------------------------------------------------------------
// Owner override: "skip the AI quality check" (docs/decisions-pending/quality-override.md)
// ---------------------------------------------------------------------------------------

const MAX_LISTED_CLAIMS = 12;

/** Digit-written numbers in a string (spelled-out words like "one" are too common in speech
 * to flag here; graphics are checked separately with the full extractor). */
function digitNumbers(text: string): number[] {
  return /\d/.test(text) ? extractNumbers(text).filter((n) => Number.isFinite(n)) : [];
}

/**
 * PURE: the on-screen numbers/claims Chris must vouch for when the FACTUAL gate can't pass on
 * its own (no fact-check on record, a Claims Gate BLOCK, or ungrounded graphic numbers).
 * Lists ungrounded numbers in graphics, on-screen texts and captions (what's said — captions
 * or not), plus a Claims Gate BLOCK reason. Empty = nothing numeric to confirm.
 */
export function listUnverifiedClaims(input: {
  factualStatus: GateStatus;
  claimsGateBlocked: boolean;
  factualBlockReason: string | null;
  ungroundedVisuals: UngroundedVisualNumbers[];
  texts: Array<{ text: string; start: number }>;
  spoken: Array<{ text: string; start: number }>;
  allowedNumbers: number[];
}): string[] {
  if (input.factualStatus === "PASS") return [];
  const out: string[] = [];
  if (input.claimsGateBlocked && input.factualBlockReason) out.push(`The fact-check flagged: ${input.factualBlockReason.split(" Also: ")[0]!.replace(/\.+$/, "")}`);
  for (const f of input.ungroundedVisuals) {
    const nums = [...new Set(f.numbers.map((n) => n.value.toLocaleString("en-US")))].join(", ");
    out.push(`The ${TEMPLATE_NAMES[f.template] ?? f.template} at ${f.start.toFixed(1)}s shows ${nums}`);
  }
  const ungrounded = (t: string) => digitNumbers(t).some((n) => !numberIsGrounded(n, input.allowedNumbers));
  for (const t of input.texts) if (ungrounded(t.text)) out.push(`On-screen text at ${t.start.toFixed(1)}s: "${t.text.trim()}"`);
  for (const s of input.spoken) if (ungrounded(s.text)) out.push(`You say at ${s.start.toFixed(1)}s: "${s.text.trim()}"`);
  const unique = [...new Set(out)];
  return unique.length > MAX_LISTED_CLAIMS
    ? [...unique.slice(0, MAX_LISTED_CLAIMS), `…and ${unique.length - MAX_LISTED_CLAIMS} more`]
    : unique;
}

export interface SkipAiPrecheck {
  renderId: string;
  technical: { status: GateStatus; reasons: string[]; issues: QCIssueInput[] };
  /** What the override would skip (plain labels, with why for brand/factual). */
  skippedChecks: string[];
  unverifiedClaims: string[];
}

/** The free part of the Quality Gate, for the override: technical gate + what's unverified. */
export async function precheckSkipAiQualityCheck(db: PrismaClient, contentItemId: string): Promise<SkipAiPrecheck> {
  const d = await runDeterministicChecks(db, contentItemId);
  const technicalStatus = technicalGateFromIssues(d.technicalBase, d.collisionIssues);
  const technicalReasons: string[] = [];
  if (d.technicalBase === "BLOCK") technicalReasons.push("The render didn't pass its technical check (file, length, size, codec or loudness).");
  for (const i of d.collisionIssues) if (i.severity === "BLOCKING") technicalReasons.push(i.description);

  const texts = d.timeline
    ? d.timeline.texts.map((t) => ({ text: t.text, start: t.start }))
    : d.plan.textOverlays.map((o) => ({ text: o.text, start: o.startSeconds }));
  const spoken = d.timeline
    ? timelineCaptionChunks({ clips: d.timeline.clips, captions: { ...d.timeline.captions, enabled: true } }, d.wordsByAsset).map((c) => ({ text: c.text, start: c.start }))
    : [];
  const unverifiedClaims = listUnverifiedClaims({
    factualStatus: d.factualStatus,
    claimsGateBlocked: d.claimsGateBlocked,
    factualBlockReason: d.factualBlockReason,
    ungroundedVisuals: d.ungroundedVisuals,
    texts,
    spoken,
    allowedNumbers: d.allowedNumbers,
  });

  const skippedChecks: string[] = [AI_QUALITY_CHECKS.VISUAL_QA];
  if (d.brand.status === "BLOCK") {
    skippedChecks.push(
      d.brand.onRecord
        ? `${AI_QUALITY_CHECKS.BRAND} (scored below the bar: brand ${d.brand.brandScore}, voice ${d.brand.voiceScore})`
        : `${AI_QUALITY_CHECKS.BRAND} (none on record)`,
    );
  }
  if (d.brand.creativeStatus === "BLOCK") {
    skippedChecks.push(
      d.brand.onRecord ? `${AI_QUALITY_CHECKS.CREATIVE} (scored ${d.brand.originalityScore})` : `${AI_QUALITY_CHECKS.CREATIVE} (none on record)`,
    );
  }
  if (d.factualStatus === "BLOCK") skippedChecks.push(`${AI_QUALITY_CHECKS.FACTUAL} (${d.claimsGateBlocked ? "it flagged a claim" : "none on record"})`);

  return {
    renderId: d.render.id,
    technical: { status: technicalStatus, reasons: technicalReasons, issues: d.collisionIssues },
    skippedChecks,
    unverifiedClaims,
  };
}

export type SkipAiQualityCheckResult =
  | { status: "READY"; qualityOverrideId: string; skippedChecks: string[]; unverifiedClaims: string[] }
  | { status: "TECHNICAL_BLOCK"; reasons: string[] }
  | { status: "NEEDS_FACTUAL_CONFIRMATION"; unverifiedClaims: string[]; skippedChecks: string[] };

/**
 * Owner override end to end: free technical gate → (if it passes) the owner's journaled
 * RENDERED -> READY (applyOwnerQualityOverride). A technical BLOCK never becomes READY; on-
 * screen numbers without a source need `factualConfirmed`. Throws
 * QualityOverrideNotAllowedError when the setting is Firm or the video isn't at RENDERED.
 */
export async function skipAiQualityCheckForContentItem(
  db: PrismaClient,
  contentItemId: string,
  actor: { actorId: string },
  input: { trigger: "AI_UNAVAILABLE" | "OWNER_CHOICE"; aiUnavailableReason?: string | null; factualConfirmed: boolean },
): Promise<SkipAiQualityCheckResult> {
  const pre = await precheckSkipAiQualityCheck(db, contentItemId);
  if (pre.technical.status !== "PASS") return { status: "TECHNICAL_BLOCK", reasons: pre.technical.reasons };
  if (pre.unverifiedClaims.length > 0 && !input.factualConfirmed) {
    return { status: "NEEDS_FACTUAL_CONFIRMATION", unverifiedClaims: pre.unverifiedClaims, skippedChecks: pre.skippedChecks };
  }
  try {
    const row = await applyOwnerQualityOverride(db, {
      contentItemId,
      actorId: actor.actorId,
      trigger: input.trigger,
      aiUnavailableReason: input.aiUnavailableReason ?? null,
      technical: {
        status: "PASS",
        renderId: pre.renderId,
        issues: pre.technical.issues.map((i) => ({ category: i.category, description: i.description, severity: i.severity, timestampSeconds: i.timestampSeconds ?? null })),
      },
      skippedChecks: pre.skippedChecks,
      unverifiedClaims: pre.unverifiedClaims,
      factualConfirmed: input.factualConfirmed,
    });
    return { status: "READY", qualityOverrideId: row.id, skippedChecks: pre.skippedChecks, unverifiedClaims: pre.unverifiedClaims };
  } catch (err) {
    if (err instanceof FactualConfirmationRequiredError) {
      return { status: "NEEDS_FACTUAL_CONFIRMATION", unverifiedClaims: err.unverifiedClaims, skippedChecks: pre.skippedChecks };
    }
    throw err;
  }
}
