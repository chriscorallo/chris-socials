"use server";

import { redirect } from "next/navigation";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prisma,
  applyTransition,
  applyManualTransition,
  createProductionContractAndAdvance,
  createCreatorCardAndAdvance,
  createMediaAsset,
  analyzeMediaAsset,
  listMediaAssetsForContentItem,
  recordTakeSelection,
  getLatestTakeSelection,
  recordEditPlan,
  getLatestScriptVersion,
  getProductionContract,
  setScheduleEntry,
  applyPipelineResult,
  recordPlatformPackage,
  scheduleContentItemForPublishing,
  listSnapshotsForContentItem,
  recordPerformanceEvaluation,
  recordTasteFeedback,
  recordAdversarialCritique,
  type ContentState,
} from "@chris/domain";
import {
  runResearchToScriptPipeline,
  runTakeSelectorAgent,
  runEditPlannerAgent,
  runPlatformPackagingAgent,
  runAnalyticsAgent,
  runAdversarialEvaluatorAgent,
  getBrandContextText,
  type PackagingPlatform,
} from "@chris/agents";
import { probeMedia } from "@chris/media";
import { renderContentItem } from "@chris/worker";
import { runQualityGateForContentItem } from "@chris/worker/quality-gate-job";
import { publishContentItem } from "@chris/worker/publish-job";
import { captureDueSnapshots } from "@chris/worker/snapshot-job";
import { ingestCommentsForContentItem } from "@chris/worker/comment-ingestion-job";
import { tryAutonomousPublish } from "@chris/worker/autonomous-publish-job";
import { requireSession } from "../../../lib/session";
import { storage } from "../../../lib/storage";
import { getModelProvider } from "../../../lib/model-provider";
import { getPlatformAdapters } from "../../../lib/platform-adapters";
import { getRenderFontPath } from "../../../lib/render-config";

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function lines(formData: FormData, key: string): string[] {
  return str(formData, key)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function selectForWeek(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  await applyTransition(prisma, {
    contentItemId,
    to: "SELECTED",
    actorType: "HUMAN",
    actorId: session.user!.id!,
    reason: "Selected for this week's portfolio",
  });
  redirect(`/content/${contentItemId}`);
}

/** The bare "advance" button — restricted to MANUAL_TRANSITIONS (facts only Chris can attest
 * to, plus explicit rollbacks). Every gated transition goes through its own action; see
 * packages/domain/src/manual-transition.ts and /docs/DECISIONS.md. */
export async function advanceManual(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  const to = str(formData, "to") as ContentState;
  let error: string | null = null;
  try {
    await applyManualTransition(prisma, { contentItemId, to, actorId: session.user!.id! });
  } catch (err) {
    error = err instanceof Error ? err.message : "Unknown transition error";
  }
  if (error) redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(error)}`);
  redirect(`/content/${contentItemId}`);
}

export async function cancelItem(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  const reason = str(formData, "reason");
  await applyTransition(prisma, {
    contentItemId,
    to: "CANCELLED",
    actorType: "HUMAN",
    actorId: session.user!.id!,
    reason,
  });
  redirect(`/content/${contentItemId}`);
}

export async function submitContract(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");

  await createProductionContractAndAdvance(
    prisma,
    {
      contentItemId,
      purpose: str(formData, "purpose"),
      primaryIdea: str(formData, "primaryIdea"),
      audiencePromise: str(formData, "audiencePromise"),
      topic: str(formData, "topic"),
      format: str(formData, "format"),
      productionTier: str(formData, "productionTier") as never,
      targetLengthMinSeconds: Number(str(formData, "targetLengthMinSeconds") || 0),
      targetLengthMaxSeconds: Number(str(formData, "targetLengthMaxSeconds") || 0),
      researchDepth: str(formData, "researchDepth") as never,
      factualRisk: str(formData, "factualRisk") as never,
      experiment: str(formData, "experiment") || undefined,
      platformOpportunities: lines(formData, "platformOpportunities"),
      humanEditingBudgetMinutes: str(formData, "humanEditingBudgetMinutes")
        ? Number(str(formData, "humanEditingBudgetMinutes"))
        : undefined,
      requiredAssets: lines(formData, "requiredAssets"),
      scope: str(formData, "scope"),
      doNotExpandInto: str(formData, "doNotExpandInto"),
    },
    { actorId: session.user!.id! },
  );

  redirect(`/content/${contentItemId}`);
}

export async function submitCreatorCard(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");

  await createCreatorCardAndAdvance(
    prisma,
    {
      contentItemId,
      hook: str(formData, "hook"),
      talkingPoints: lines(formData, "talkingPoints"),
      setup: str(formData, "setup") as never,
      estimatedMinutes: str(formData, "estimatedMinutes")
        ? Number(str(formData, "estimatedMinutes"))
        : undefined,
      notes: str(formData, "notes") || undefined,
    },
    { actorId: session.user!.id! },
  );

  redirect(`/content/${contentItemId}`);
}

/**
 * Uploads a raw take and immediately runs deterministic technical analysis (ffprobe — no
 * LLM, no cost) against it — see /docs/DECISIONS.md. Analyzing the first take for an item
 * still in FILMED is the canonical trigger for FILMED -> MEDIA_INGESTED.
 */
export async function uploadMedia(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    throw new Error("A file is required.");
  }

  const storageKey = `raw/${contentItemId}/${Date.now()}-${file.name}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  await storage.put(storageKey, bytes);

  const asset = await createMediaAsset(
    prisma,
    {
      contentItemId,
      kind: "RAW_TAKE",
      storageKey,
      originalFilename: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: bytes.byteLength,
    },
    { actorId: session.user!.id! },
  );

  // ffprobe needs a real file path — write the just-uploaded bytes to a scratch temp file.
  const workDir = await mkdtemp(join(tmpdir(), "chris-analyze-"));
  try {
    const tempPath = join(workDir, file.name);
    await writeFile(tempPath, bytes);
    const probed = await probeMedia(tempPath);
    await analyzeMediaAsset(
      prisma,
      asset.id,
      {
        durationSeconds: probed.durationSeconds,
        width: probed.width,
        height: probed.height,
        frameRate: probed.frameRate,
        hasAudio: probed.hasAudio,
        videoCodec: probed.videoCodec,
        audioCodec: probed.audioCodec,
      },
      { actorId: session.user!.id! },
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  redirect(`/content/${contentItemId}`);
}

export async function submitSchedule(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  const scheduledDate = new Date(str(formData, "scheduledDate"));

  await setScheduleEntry(
    prisma,
    { contentItemId, scheduledDate },
    { actorId: session.user!.id! },
  );

  redirect(`/content/${contentItemId}`);
}

/**
 * Runs the real Research -> Claims Gate -> Script -> Brand Guardian pipeline
 * (packages/agents) against this item's Production Contract, then persists the result and
 * advances the state machine accordingly (packages/domain's applyPipelineResult). Requires
 * ANTHROPIC_API_KEY to be configured — see /docs/DECISIONS.md. Only valid from RESEARCHING.
 */
export async function runPipeline(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");

  try {
    const contract = await getProductionContract(prisma, contentItemId);
    if (!contract) {
      throw new Error("No Production Contract found for this item — issue one first.");
    }

    const brandContext = await getBrandContextText(prisma);
    const pipelineResult = await runResearchToScriptPipeline(getModelProvider(), {
      contract,
      brandContext,
    });

    await applyPipelineResult(
      prisma,
      contentItemId,
      {
        status: pipelineResult.status,
        research: pipelineResult.research,
        claimsGateResult:
          "claimsGateResult" in pipelineResult ? pipelineResult.claimsGateResult : undefined,
        script: "script" in pipelineResult ? pipelineResult.script : undefined,
        brandGuardianReport:
          "brandGuardianReport" in pipelineResult ? pipelineResult.brandGuardianReport : undefined,
      },
      { actorId: session.user!.id! },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown pipeline error";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(message)}`);
  }

  redirect(`/content/${contentItemId}`);
}

/** Runs the Take Selector agent against every uploaded raw take, then records the selection
 * (MEDIA_INGESTED -> TAKE_SELECTED). Requires ANTHROPIC_API_KEY. */
export async function runTakeSelector(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");

  try {
    const assets = await listMediaAssetsForContentItem(prisma, contentItemId);
    if (assets.length === 0) {
      throw new Error("No raw takes uploaded yet.");
    }
    const brandContext = await getBrandContextText(prisma);
    const result = await runTakeSelectorAgent(getModelProvider(), {
      takes: assets.map((a) => ({
        mediaAssetId: a.id,
        transcript: a.transcript,
        durationSeconds: a.durationSeconds,
      })),
      brandContext,
    });

    await recordTakeSelection(
      prisma,
      {
        contentItemId,
        selectedMediaAssetId: result.selectedMediaAssetId,
        backupMediaAssetId: result.backupMediaAssetId,
        confidence: result.confidence,
        reason: result.reason,
        materialDefects: result.materialDefects,
      },
      { actorId: session.user!.id! },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown take-selection error";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(message)}`);
  }

  redirect(`/content/${contentItemId}`);
}

/** Runs the Edit Planner agent against the selected take, then records the plan
 * (TAKE_SELECTED -> EDIT_PLANNED). Requires ANTHROPIC_API_KEY. */
export async function runEditPlanner(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");

  try {
    const contract = await getProductionContract(prisma, contentItemId);
    if (!contract) throw new Error("No Production Contract found for this item.");

    const takeSelection = await getLatestTakeSelection(prisma, contentItemId);
    if (!takeSelection) throw new Error("No take has been selected yet.");

    const selectedAsset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: takeSelection.selectedMediaAssetId },
    });
    const script = await getLatestScriptVersion(prisma, contentItemId);
    const brandContext = await getBrandContextText(prisma);

    const plan = await runEditPlannerAgent(getModelProvider(), {
      contract,
      scriptText: script?.spokenScript ?? contract.primaryIdea,
      takeTranscript: selectedAsset.transcript,
      sourceDurationSeconds: selectedAsset.durationSeconds,
      brandContext,
    });

    await recordEditPlan(
      prisma,
      {
        contentItemId,
        takeSelectionId: takeSelection.id,
        productionTier: plan.productionTier,
        targetDurationSeconds: plan.targetDurationSeconds,
        doNothingElse: plan.doNothingElse,
        plan,
      },
      { actorId: session.user!.id! },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown edit-plan error";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(message)}`);
  }

  redirect(`/content/${contentItemId}`);
}

/** Runs the real deterministic renderer (packages/media, via @chris/worker's orchestration)
 * against the latest EditPlan. No API key needed — this step is pure ffmpeg, not an LLM
 * call. See /docs/DECISIONS.md for exactly what the renderer does and doesn't implement yet. */
export async function runRender(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");

  try {
    await renderContentItem(
      prisma,
      storage,
      contentItemId,
      { fontPath: getRenderFontPath() },
      { actorId: session.user!.id! },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown render error";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(message)}`);
  }

  redirect(`/content/${contentItemId}`);
}

/**
 * Phase 4 — evaluates all four spec §9-step-16 hard gates (FACTUAL/TECHNICAL/BRAND/CREATIVE)
 * against the latest successful Render and drives RENDERED -> READY (all PASS) or RENDERED ->
 * QC_REPAIR (any BLOCK). The only model call here is Visual QA (vision, against real sampled
 * frames); everything else is either deterministic code or a persisted result from an earlier
 * phase — see @chris/worker's quality-gate-job.ts and /docs/DECISIONS.md. Requires
 * ANTHROPIC_API_KEY.
 */
export async function runQualityGate(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");

  try {
    await runQualityGateForContentItem(
      prisma,
      storage,
      getModelProvider(),
      contentItemId,
      { actorId: session.user!.id! },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown quality-gate error";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(message)}`);
  }

  redirect(`/content/${contentItemId}`);
}

/**
 * Phase 5 — packages the finished video for one platform (spec §9 step 20). Uses the selected
 * take's transcript as the "final transcript" input (the render trims/captions that audio but
 * doesn't re-transcribe it — see /docs/DECISIONS.md's no-real-transcription-provider
 * limitation, carried forward from Phase 3). Requires ANTHROPIC_API_KEY.
 */
export async function runPlatformPackaging(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  const platform = str(formData, "platform") as PackagingPlatform;

  try {
    const takeSelection = await getLatestTakeSelection(prisma, contentItemId);
    const selectedAsset = takeSelection
      ? await prisma.mediaAsset.findUnique({ where: { id: takeSelection.selectedMediaAssetId } })
      : null;
    const finalTranscript = selectedAsset?.transcript ?? "(no transcript available)";
    const brandContext = await getBrandContextText(prisma);

    const pkg = await runPlatformPackagingAgent(getModelProvider(), { platform, finalTranscript, brandContext });

    await recordPlatformPackage(
      prisma,
      {
        contentItemId,
        platform,
        caption: pkg.caption,
        title: pkg.title,
        hashtags: pkg.hashtags,
        coverFrameSeconds: pkg.coverFrameSeconds,
        metadata: pkg.metadata as Record<string, unknown> | null,
      },
      { actorId: session.user!.id! },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown packaging error";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(message)}`);
  }

  redirect(`/content/${contentItemId}`);
}

/**
 * Phase 5 — the real, gated schedule step (spec §9 step 19): drives READY -> SCHEDULED and
 * records which platforms to target. Distinct from the Phase 1 `submitSchedule` action above
 * (still used for plain ungated calendar placement) — this is the one that actually queues a
 * publish. No API key needed; pure deterministic persistence.
 */
export async function submitPublishSchedule(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  const scheduledDate = new Date(str(formData, "scheduledDate"));
  const targetPlatforms = formData.getAll("targetPlatforms").map(String) as PackagingPlatform[];

  try {
    if (targetPlatforms.length === 0) {
      throw new Error("Select at least one target platform.");
    }
    await scheduleContentItemForPublishing(
      prisma,
      { contentItemId, scheduledDate, targetPlatforms },
      { actorId: session.user!.id! },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown scheduling error";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(message)}`);
  }

  redirect(`/content/${contentItemId}`);
}

/**
 * Phase 5 — Preflight + Publish + Verify (spec §9 steps 21-22) across every scheduled target
 * platform. Real adapters (packages/platforms), built from env credentials — see
 * lib/platform-adapters.ts. One platform failing never blocks the others (graceful failure,
 * spec §21); idempotent to retry (see @chris/worker's publish-job.ts).
 */
export async function runPublish(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");

  try {
    await publishContentItem(
      prisma,
      storage,
      getPlatformAdapters(),
      contentItemId,
      { actorId: session.user!.id! },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown publish error";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(message)}`);
  }

  redirect(`/content/${contentItemId}`);
}

/**
 * Phase 6 — spec §9 step 23. Captures every due metric snapshot (T+1h…T+30d) per scheduled
 * platform via the real adapter (packages/platforms) — no API key needed for this step, but
 * real platform credentials are. Drives PUBLISHED -> MEASURING on the first capture and
 * MEASURING -> ARCHIVED once every published platform's T+30d window has closed.
 */
export async function runCaptureSnapshots(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");

  try {
    await captureDueSnapshots(prisma, getPlatformAdapters(), contentItemId, { actorId: session.user!.id! });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown snapshot error";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(message)}`);
  }

  redirect(`/content/${contentItemId}`);
}

/** Phase 6 — spec §9 step 24's raw material. Real comments pulled per published platform;
 * TikTok has no accessible comment endpoint at this app's tier and simply yields none (see
 * /docs/DECISIONS.md), not an error. */
export async function runIngestComments(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");

  try {
    await ingestCommentsForContentItem(prisma, getPlatformAdapters(), contentItemId, {
      actorId: session.user!.id!,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown comment-ingestion error";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(message)}`);
  }

  redirect(`/content/${contentItemId}`);
}

/**
 * Phase 6 — spec §9 step 25. Evaluates this video's real captured snapshots across all eight
 * performance categories, with real production-cost context for PRODUCTION_ROI. Requires
 * ANTHROPIC_API_KEY.
 */
export async function runAnalytics(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");

  try {
    const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
    const snapshots = await listSnapshotsForContentItem(prisma, contentItemId);
    if (snapshots.length === 0) {
      throw new Error("No performance snapshots captured yet — capture at least one first.");
    }
    const contract = await getProductionContract(prisma, contentItemId);
    const creatorCard = await prisma.creatorCard.findUnique({ where: { contentItemId } });
    const brandContext = await getBrandContextText(prisma);

    const evaluation = await runAnalyticsAgent(getModelProvider(), {
      title: item.title,
      snapshots: snapshots.map((s) => ({
        platform: s.platform,
        offset: s.offset,
        viewCount: s.viewCount,
        likeCount: s.likeCount,
        commentCount: s.commentCount,
        shareCount: s.shareCount,
        saveCount: s.saveCount,
        reach: s.reach,
        avgWatchTimeSeconds: s.avgWatchTimeSeconds,
      })),
      productionCost: {
        estimatedFilmingMinutes: creatorCard?.estimatedMinutes ?? null,
        humanEditingBudgetMinutes: contract?.humanEditingBudgetMinutes ?? null,
      },
      brandContext,
    });

    await recordPerformanceEvaluation(
      prisma,
      {
        contentItemId,
        overallSummary: evaluation.overallSummary,
        strategicallyValuableDespiteLowerViews: evaluation.strategicallyValuableDespiteLowerViews,
        categories: evaluation.categories,
      },
      { actorId: session.user!.id! },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown analytics error";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(message)}`);
  }

  redirect(`/content/${contentItemId}`);
}

/** Phase 7 — records Chris's real, raw feedback on an artifact of this item (spec §7's Human
 * Taste Model). No API key needed; the Taste Learner agent reads accumulated feedback like
 * this later, from /learnings. */
export async function submitTasteFeedback(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");

  await recordTasteFeedback(
    prisma,
    {
      contentItemId,
      artifactType: str(formData, "artifactType"),
      rawFeedback: str(formData, "rawFeedback"),
      normalizedTag: str(formData, "normalizedTag"),
    },
    { actorId: session.user!.id! },
  );

  redirect(`/content/${contentItemId}`);
}

/**
 * Phase 7 — an independent second opinion on this item's latest script (the most broadly
 * applicable real artifact to critique at any point past SCRIPTED). Advisory only — never
 * blocks anything; the Creative Director/Chris weighs it. Requires ANTHROPIC_API_KEY.
 */
export async function runAdversarialEvaluator(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");

  try {
    const script = await getLatestScriptVersion(prisma, contentItemId);
    if (!script) {
      throw new Error("No script exists yet for this item to critique.");
    }
    const brandContext = await getBrandContextText(prisma);

    const critique = await runAdversarialEvaluatorAgent(getModelProvider(), {
      artifactType: "SCRIPT",
      artifactSummary: script.spokenScript,
      brandContext,
    });

    await recordAdversarialCritique(
      prisma,
      {
        artifactType: "SCRIPT",
        artifactId: script.id,
        contentItemId,
        concerns: critique.concerns,
        noMaterialWeaknessesFound: critique.noMaterialWeaknessesFound,
      },
      { actorId: session.user!.id! },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown adversarial-evaluator error";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(message)}`);
  }

  redirect(`/content/${contentItemId}`);
}

/**
 * Phase 8 — spec §23 Level 3: "approved content classes may auto-schedule/publish." A no-op,
 * never a crash, if this item's production tier hasn't genuinely earned PUBLISHING autonomy
 * yet (or the global shadow_only kill switch is on) — the reason is always shown, never
 * hidden, so it's clear why nothing happened and manual Schedule/Publish is still available.
 */
export async function tryAutonomousPublishAction(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");

  // `redirect()` works by throwing internally — it must never be called from inside this
  // try block, or it would be caught by the catch below instead of actually navigating (a
  // real gotcha this codebase avoids consistently elsewhere). Capture the outcome first,
  // redirect once, after the try/catch is fully done.
  let notAttemptedReason: string | null = null;
  try {
    const result = await tryAutonomousPublish(
      prisma,
      storage,
      getPlatformAdapters(),
      contentItemId,
      { actorId: session.user!.id! },
    );
    if (!result.attempted) {
      notAttemptedReason = result.reason;
    }
  } catch (err) {
    notAttemptedReason = err instanceof Error ? err.message : "Unknown autonomous-publish error";
  }

  if (notAttemptedReason) {
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(`Not autonomous yet: ${notAttemptedReason}`)}`);
  }
  redirect(`/content/${contentItemId}`);
}
