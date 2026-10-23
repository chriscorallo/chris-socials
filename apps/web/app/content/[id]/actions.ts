"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { join } from "node:path";
import {
  prisma,
  applyTransition,
  applyManualTransition,
  createProductionContractAndAdvance,
  createCreatorCardAndAdvance,
  recordTranscript,
  getLatestScriptVersion,
  getLatestResearchPacket,
  createHumanScriptVersion,
  recordScriptRegate,
  getProductionContract,
  setScheduleEntry,
  scheduleContentItemForPublishing,
  listSnapshotsForContentItem,
  recordPerformanceEvaluation,
  recordTasteFeedback,
  recordAdversarialCritique,
  deleteVideo,
  type ContentState,
  creativeBriefTextFor,
  acquireHeavyJobLease,
  updateHeavyJobProgress,
  finishHeavyJob,
} from "@chris/domain";
import {
  regateEditedScript,
  researchPacketFromRow,
  draftAndIssueProductionContract,
  draftAndIssueCreatorCard,
  runAnalyticsAgent,
  runAdversarialEvaluatorAgent,
  getBrandContextText,
  type PackagingPlatform,
} from "@chris/agents";
import { publishContentItem } from "@chris/worker/publish-job";
import { captureDueSnapshots } from "@chris/worker/snapshot-job";
import { ingestCommentsForContentItem } from "@chris/worker/comment-ingestion-job";
import { tryAutonomousPublish } from "@chris/worker/autonomous-publish-job";
import { requireSession } from "../../../lib/session";
import { storage, downloadToFile, safeFilename, getPublicVideoUrl } from "../../../lib/storage";
import {
  registerUploadedRawTake,
  withTempDir,
  parseUploadKind,
  uploadKeyPrefix,
  uploadMimeAllowed,
  parseSegmentMeta,
  registeredSegmentAsset,
  type UploadKind,
} from "../../../lib/ingest-upload";
import { getModelProvider } from "../../../lib/model-provider";
import {
  runPipelineStep,
  runTakeSelectionStep,
  runEditPlanStep,
  runPackagingStep,
  runAutopilot,
} from "../../../lib/content-steps";
import { getPlatformAdapters } from "../../../lib/platform-adapters";
import { isAutoTranscriptionEnabled } from "../../../lib/render-config";
import { runHeavyJob, jobParam, type RunHeavyJobResult } from "../../../lib/heavy-jobs";
import { plainJobError } from "../../../lib/heavy-job-text";

/**
 * Where a heavy action lands: in the cloud (Vercel) it has only STARTED — the page opens with
 * `?job=<id>` and its progress card follows it; in-process it's finished and a failure becomes
 * the page's error line.
 */
function heavyJobRedirect(contentItemId: string, r: RunHeavyJobResult, failedPrefix?: (outcome: Extract<RunHeavyJobResult, { status: "done" }>["outcome"]) => string | null): never {
  const base = `/content/${contentItemId}`;
  if (r.status === "started") redirect(`${base}?${jobParam(r)}`);
  if (r.status === "busy") redirect(`${base}?${jobParam(r)}&pipelineError=${encodeURIComponent(r.message)}`);
  if (r.status === "refused") redirect(`${base}?pipelineError=${encodeURIComponent(r.message)}`);
  const notice = failedPrefix ? failedPrefix(r.outcome) : r.outcome.ok ? null : plainJobError(r.outcome.error, (r.outcome.result as { errorName?: string } | null)?.errorName);
  if (notice) redirect(`${base}?pipelineError=${encodeURIComponent(notice)}`);
  redirect(base);
}

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
 * Production (blob-mode) upload completion: the browser has already uploaded the raw take
 * directly to the private Blob store (app/api/blob-upload issued the token); this records
 * the MediaAsset and runs deterministic ffprobe analysis against a streamed local copy.
 * Local mode uses the streaming PUT /api/upload route instead. See /docs/DECISIONS.md
 * ("Uploads: streaming locally, browser-direct to Blob in production").
 */
export async function registerBlobUpload(input: {
  contentItemId: string;
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  /** "MUSIC" registers a music bed (audio only, key under music/<item>/); default a raw take. */
  kind?: UploadKind;
  /** A segment of a teleprompter recording draft (same fields as the local route's query). */
  segment?: Record<string, string | number | null | undefined>;
}): Promise<{ mediaAssetId: string } | { error: string }> {
  const session = await requireSession();
  try {
    const kind = parseUploadKind(input.kind);
    const segment = kind === "RAW_TAKE" && input.segment ? parseSegmentMeta((k) => (input.segment![k] == null ? null : String(input.segment![k]))) : null;
    if (segment) {
      const existing = await registeredSegmentAsset(segment);
      if (existing) return { mediaAssetId: existing.id };
    }
    if (!input.storageKey.startsWith(uploadKeyPrefix(kind, input.contentItemId))) {
      throw new Error("Storage key does not belong to this content item.");
    }
    if (!uploadMimeAllowed(kind, input.mimeType)) {
      throw new Error(kind === "MUSIC" ? "Music must be an audio file." : `Unsupported file type: ${input.mimeType}`);
    }
    const asset = await withTempDir(async (dir) => {
      const localPath = join(dir, safeFilename(input.originalFilename));
      await downloadToFile(input.storageKey, localPath);
      return registerUploadedRawTake({ ...input, kind, localPath, actorId: session.user!.id!, segment });
    });
    return { mediaAssetId: asset.id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Upload registration failed" };
  }
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
  let notice: string | null = null;

  try {
    const pipelineResult = await runPipelineStep(contentItemId, { actorId: session.user!.id! });
    if (pipelineResult.status === "SCRIPT_BLOCKED") {
      notice = `Claims Gate blocked the script: ${pipelineResult.blockReason ?? "see the script's gate result below"}`;
    } else if (pipelineResult.status === "READY" && pipelineResult.brandNeedsHumanReview) {
      notice = "Script is fact-checked, but Brand Guardian still has concerns — review it below before filming.";
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown pipeline error";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(message)}`);
  }

  if (notice) redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(notice)}`);
  redirect(`/content/${contentItemId}`);
}

/** Runs the Take Selector agent against every uploaded raw take, then records the selection
 * (MEDIA_INGESTED -> TAKE_SELECTED). Requires ANTHROPIC_API_KEY. */
export async function runTakeSelector(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");

  try {
    await runTakeSelectionStep(contentItemId, { actorId: session.user!.id! });
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
    await runEditPlanStep(contentItemId, { actorId: session.user!.id! });
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

  // Heavy (motion layer needs headless Chrome; mattes need ONNX): in-process locally, a cloud
  // worker on Vercel (lib/heavy-jobs.ts). A render that fails its technical QC is recorded on the
  // Render row and shown on the page, as before — only a thrown error becomes the error line.
  const r = await runHeavyJob("render", { contentItemId }, { actorId: session.user!.id! });
  heavyJobRedirect(contentItemId, r, (o) => {
    const render = (o.result as { render?: unknown } | null)?.render;
    return o.ok || render ? null : plainJobError(o.error);
  });
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

  // Samples frames of the render (ffmpeg) + the Visual QA model call: a heavy job (cloud on Vercel).
  const r = await runHeavyJob("quality-gate", { contentItemId }, { actorId: session.user!.id! });
  heavyJobRedirect(contentItemId, r, (o) => (o.ok ? null : o.error ?? "Unknown quality-gate error"));
}

/**
 * "Run the AI check now" on a video Chris sent to the calendar without it (owner override,
 * docs/decisions-pending/quality-override.md): the full Quality Gate, recorded for that render
 * with NO state change. A PASS clears the "Scheduled without AI quality check" mark; a BLOCK is
 * shown and stops it posting until it's fixed (a real hard-gate finding still blocks).
 */
export async function runLateAiCheck(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  const r = await runHeavyJob("quality-gate", { contentItemId, lateCheck: true }, { actorId: session.user!.id! });
  heavyJobRedirect(contentItemId, r, (o) => (o.ok ? null : plainJobError(o.error)));
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
    await runPackagingStep(contentItemId, platform, { actorId: session.user!.id! });
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
  const actor = { actorId: session.user!.id! };

  // Posting runs AFTER the response (2026-10-23: "I don't want to be locked in there"): the page
  // comes back at once with the job's banner, the publish continues on the server whether or
  // not the page stays open, and its outcome lands on the JobRun the banner polls. The platform
  // credentials never leave this function. One job per video (the heavy-job lease).
  const lease = await acquireHeavyJobLease(prisma, { contentItemId, jobKind: "publish", args: { contentItemId }, mode: "inline", actorId: actor.actorId });
  if (!lease.acquired) {
    const message = lease.reason === "BUSY" ? "Something else is running for this video right now — try again when it finishes." : "Couldn't start posting right now — try again in a minute.";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(message)}`);
  }
  const jobRunId = lease.jobRunId;
  after(async () => {
    try {
      await updateHeavyJobProgress(prisma, jobRunId, { pct: 10, message: "Checking the render and the packaging…", stage: "preflight" });
      const result = await publishContentItem(prisma, storage, getPlatformAdapters(), contentItemId, actor, { getPublicVideoUrl, platformVariants: true });
      const problems = [
        ...result.failedPlatforms.map((p) => `${p} failed (see Publications below)`),
        ...result.skippedPlatforms.map((p) => `${p.platform} skipped: ${p.reason}`),
      ];
      const ok = result.succeededPlatforms.length > 0 || problems.length === 0;
      await finishHeavyJob(prisma, jobRunId, {
        status: ok ? "SUCCEEDED" : "FAILED",
        result: { succeeded: result.succeededPlatforms, failed: result.failedPlatforms, skipped: result.skippedPlatforms },
        error: ok ? null : problems.join("; "),
        message: ok ? (problems.length ? `Posted to ${result.succeededPlatforms.join(", ")}; ${problems.join("; ")}` : `Posted to ${result.succeededPlatforms.join(", ") || "every scheduled platform"}.`) : "Posting didn't go through.",
      });
    } catch (err) {
      await finishHeavyJob(prisma, jobRunId, { status: "FAILED", error: err instanceof Error ? err.message : "Unknown publish error", message: "Posting didn't go through." }).catch(() => undefined);
    }
  });
  redirect(`/content/${contentItemId}?job=${encodeURIComponent(jobRunId)}`);
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
  let notice: string | null = null;

  try {
    const result = await captureDueSnapshots(prisma, getPlatformAdapters(), contentItemId, {
      actorId: session.user!.id!,
    });
    const parts: string[] = [];
    if (result.errors.length > 0) {
      parts.push(`Couldn't read: ${result.errors.map((e) => `${e.platform} (${e.message})`).join("; ")}`);
    }
    if (result.missed.length > 0) {
      parts.push(`Missed windows (left empty, not backfilled): ${result.missed.map((m) => `${m.platform} ${m.offset}`).join(", ")}`);
    }
    if (parts.length > 0) notice = parts.join(" · ");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown snapshot error";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(message)}`);
  }

  if (notice) redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(notice)}`);
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
        followsGained: s.followsGained,
        profileVisits: s.profileVisits,
      })),
      creativeBrief: await creativeBriefTextFor(prisma, contentItemId),
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
      { publish: { getPublicVideoUrl, platformVariants: true } },
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

/** Transcribes raw takes with local Whisper (word-level timings), or one take when
 * `mediaAssetId` is given. Never overwrites a manually typed transcript unless `force`. */
export async function runTranscribe(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  const mediaAssetId = str(formData, "mediaAssetId");
  if (!isAutoTranscriptionEnabled()) {
    const notice =
      "Automatic transcription is off in this deployment (local Whisper is too heavy for a " +
      "serverless function and no cloud worker is set up) — paste the transcript instead, or run the app locally.";
    redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(notice)}`);
  }
  // Whisper runs in-process locally, in the cloud worker on Vercel (lib/heavy-jobs.ts).
  const r = await runHeavyJob(
    "transcribe",
    { contentItemId, mediaAssetId: mediaAssetId || undefined, force: formData.get("force") === "1" },
    { actorId: session.user!.id! },
  );
  heavyJobRedirect(contentItemId, r, (o) => (o.ok ? null : o.error ?? "Unknown transcription error"));
}

/** Manual transcript (no word timings) — for when Whisper isn't available or got it wrong. */
export async function submitManualTranscript(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  const mediaAssetId = str(formData, "mediaAssetId");
  const text = str(formData, "transcript");
  if (text) {
    await recordTranscript(
      prisma,
      { mediaAssetId, text, words: null, source: "MANUAL" },
      { actorId: session.user!.id! },
    );
  }
  redirect(`/content/${contentItemId}`);
}

/**
 * Spec §9 step 15 — the automated EDIT -> RENDER -> INSPECT -> FIX loop (worker
 * auto-repair-job): revises the edit plan against the blocking QC issues, re-renders, re-runs
 * the Quality Gate, within the shared repair budget. Stops early (with the reason shown) on a
 * factual/brand/creative block, which no re-edit can fix.
 */
export async function runAutoRepair(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  // Re-renders: a heavy job (cloud on Vercel).
  const r = await runHeavyJob("auto-repair", { contentItemId }, { actorId: session.user!.id! });
  heavyJobRedirect(contentItemId, r, (o) => {
    const result = o.result as { stoppedBecause?: string | null; finalState?: string } | null;
    if (result?.stoppedBecause) return `Auto-repair stopped at ${result.finalState}: ${result.stoppedBecause}`;
    return o.ok || result?.finalState ? null : o.error ?? "Unknown auto-repair error";
  });
}

/** One click: the Production Director drafts the full Production Contract from the idea, the
 * week's thesis and its portfolio allocation, and issues it (SELECTED -> CONTRACTED). The
 * manual form stays available for anything Chris wants to set by hand. */
export async function draftContractAction(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  let notice: string | null = null;
  try {
    await draftAndIssueProductionContract(prisma, getModelProvider(), {
      contentItemId,
      actorId: session.user!.id!,
      triggeredByHuman: true,
    });
  } catch (err) {
    notice = err instanceof Error ? err.message : "Unknown Production Director error";
  }
  if (notice) redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(notice)}`);
  redirect(`/content/${contentItemId}`);
}

/** One click: drafts the Creator Card (hook, talking points, setup) from the fact-checked
 * script and issues it (SCRIPTED -> READY_TO_FILM). Refused by the domain if the latest script
 * hasn't cleared the script-level Claims Gate. */
export async function draftCreatorCardAction(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  let notice: string | null = null;
  try {
    await draftAndIssueCreatorCard(prisma, getModelProvider(), {
      contentItemId,
      actorId: session.user!.id!,
      triggeredByHuman: true,
    });
  } catch (err) {
    notice = err instanceof Error ? err.message : "Unknown Production Director error";
  }
  if (notice) redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(notice)}`);
  redirect(`/content/${contentItemId}`);
}

/** Chris edits the script in his own words: saved as a NEW ScriptVersion (history kept), then
 * re-run through the Claims Gate (against the same research) and Brand Guardian — a hand edit
 * can't introduce an unchecked number. A PASS on a RESEARCH_BLOCKED item un-blocks it. */
export async function editScriptAction(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  let notice: string | null = null;
  try {
    const spokenScript = str(formData, "spokenScript");
    if (!spokenScript) throw new Error("The script can't be empty.");
    const version = await createHumanScriptVersion(prisma, {
      contentItemId,
      baseScriptVersionId: str(formData, "baseScriptVersionId"),
      spokenScript,
      note: str(formData, "note") || undefined,
      actorId: session.user!.id!,
    });
    const packet = await getLatestResearchPacket(prisma, contentItemId);
    // No research to check against (e.g. a script imported from ChatGPT): the edit is saved as
    // a new, unchecked version — the FACTUAL gate still blocks posting until it's checked.
    if (!packet) throw new Error("Your edit was saved. It hasn't been fact-checked yet — that's still required before posting.");
    const { scriptClaimsGateResult, brandGuardianReport } = await regateEditedScript(getModelProvider(), {
      research: researchPacketFromRow(packet),
      spokenScript,
      brandContext: await getBrandContextText(prisma),
      contentItemId,
    });
    await recordScriptRegate(prisma, {
      scriptVersionId: version.id,
      scriptClaimsGateResult,
      brandGuardianReport,
      actorId: session.user!.id!,
    });
    if (scriptClaimsGateResult.result !== "PASS") {
      notice = `Your edit was saved, but the Claims Gate says ${scriptClaimsGateResult.result}: ${
        scriptClaimsGateResult.blockReason ?? scriptClaimsGateResult.requiredEdits.join("; ")
      }`;
    }
  } catch (err) {
    notice = err instanceof Error ? err.message : "Unknown script edit error";
  }
  if (notice) redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(notice)}`);
  redirect(`/content/${contentItemId}`);
}

/** Autopilot for this one item — see lib/content-steps.ts runAutopilot. Shows what it did and
 * why it stopped. */
export async function runAutopilotAction(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  const result = await runAutopilot(contentItemId, { actorId: session.user!.id! });
  const summary = `${result.steps.length ? `Autopilot did: ${result.steps.join(" → ")}. ` : ""}${result.stoppedBecause}`;
  redirect(`/content/${contentItemId}?autopilot=${encodeURIComponent(summary)}${result.jobRunId ? `&job=${encodeURIComponent(result.jobRunId)}` : ""}`);
}

/**
 * "Delete video" — removes the video from every list and deletes its media files (takes,
 * proxies, renders, variants…); its history/audit trail is kept (docs/DECISIONS.md "Delete video").
 */
export async function deleteVideoAction(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  const back = str(formData, "back") || "/content";
  const r = await deleteVideo(prisma, { contentItemId }, { actorId: session.user!.id! });
  for (const key of r.storageKeys) {
    await storage.delete(key).catch((err) => console.warn("[delete-video] could not delete", key, err instanceof Error ? err.message : err));
  }
  for (const path of ["/", "/content", "/plan", "/calendar", "/film"]) revalidatePath(path);
  redirect(`${back}${back.includes("?") ? "&" : "?"}notice=${encodeURIComponent("Video deleted from your plan.")}`);
}
