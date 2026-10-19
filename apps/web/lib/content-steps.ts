import {
  prisma,
  applyManualTransition,
  applyPipelineResult,
  getLatestScriptVersion,
  getLatestTakeSelection,
  getProductionContract,
  listMediaAssetsForContentItem,
  assertNoOpenRecordingDraft,
  parseTranscriptWords,
  recordEditPlan,
  recordReplannedEditPlan,
  recordPlatformPackage,
  recordTakeSelection,
  isScriptVersionFilmable,
  getPlanContextForAgent,
  type ContentState,
} from "@chris/domain";
import {
  draftAndIssueCreatorCard,
  draftAndIssueProductionContract,
  getBrandContextText,
  runEditPlannerAgent,
  runPlatformPackagingAgent,
  runResearchToScriptPipeline,
  runTakeSelectorAgent,
  toPipelineResultInput,
  type PackagingPlatform,
} from "@chris/agents";
import { EditTimelineSchema, timelineCaptionWords } from "@chris/media/timeline";
import { getModelProvider } from "./model-provider";
import { isAutoTranscriptionEnabled } from "./render-config";
import { runHeavyJob, type RunHeavyJobResult } from "./heavy-jobs";

/**
 * The per-state production steps, shared by the individual buttons on the content page and by
 * Autopilot — one implementation, so a button and Autopilot can never drift apart. Each step
 * persists through the domain layer (state machine, audit log) exactly as before.
 */
type Actor = { actorId: string };

export async function runPipelineStep(contentItemId: string, actor: Actor) {
  const contract = await getProductionContract(prisma, contentItemId);
  if (!contract) throw new Error("No Production Contract found for this item — issue one first.");
  const brandContext = await getBrandContextText(prisma);
  // Chris's ChatGPT planning conversation (optional, ~1.5K tokens) — intent, never facts.
  const planContext = await getPlanContextForAgent(prisma, "SCRIPT");
  const result = await runResearchToScriptPipeline(getModelProvider(), { contract, brandContext, planContext }, { contentItemId });
  await applyPipelineResult(prisma, contentItemId, toPipelineResultInput(result), actor);
  return result;
}

export async function runTakeSelectionStep(contentItemId: string, actor: Actor) {
  // A recording still being filmed in parts isn't the video yet.
  await assertNoOpenRecordingDraft(prisma, contentItemId);
  const assets = await listMediaAssetsForContentItem(prisma, contentItemId);
  if (assets.length === 0) throw new Error("No raw takes uploaded yet.");
  const brandContext = await getBrandContextText(prisma);
  const result = await runTakeSelectorAgent(getModelProvider(), {
    takes: assets.map((a) => ({
      mediaAssetId: a.id,
      transcript: a.transcript,
      durationSeconds: a.durationSeconds,
      words: parseTranscriptWords(a.transcriptWords),
    })),
    brandContext,
  });
  return recordTakeSelection(
    prisma,
    {
      contentItemId,
      selectedMediaAssetId: result.selectedMediaAssetId,
      backupMediaAssetId: result.backupMediaAssetId,
      confidence: result.confidence,
      reason: result.reason,
      materialDefects: result.materialDefects,
    },
    actor,
  );
}

export async function runEditPlanStep(contentItemId: string, actor: Actor) {
  const contract = await getProductionContract(prisma, contentItemId);
  if (!contract) throw new Error("No Production Contract found for this item.");
  const takeSelection = await getLatestTakeSelection(prisma, contentItemId);
  if (!takeSelection) throw new Error("No take has been selected yet.");
  const selectedAsset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: takeSelection.selectedMediaAssetId } });
  const script = await getLatestScriptVersion(prisma, contentItemId);
  const brandContext = await getBrandContextText(prisma);

  const plan = await runEditPlannerAgent(getModelProvider(), {
    contract,
    scriptText: script?.spokenScript ?? contract.primaryIdea,
    takeTranscript: selectedAsset.transcript,
    takeWords: parseTranscriptWords(selectedAsset.transcriptWords),
    sourceDurationSeconds: selectedAsset.durationSeconds,
    brandContext,
  });
  const planFields = {
    contentItemId,
    takeSelectionId: takeSelection.id,
    productionTier: plan.productionTier,
    targetDurationSeconds: plan.targetDurationSeconds,
    doNothingElse: plan.doNothingElse,
    plan,
  };
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (item.currentState === "EDIT_PLANNED") {
    // Re-plan before rendering (e.g. after the QC_BLOCKED rollback): a fresh repair chain with
    // a fresh budget — see packages/domain/src/edit-plan.ts.
    return recordReplannedEditPlan(prisma, { ...planFields, revisionOfEditPlanId: null, revisionReason: "Re-planned by Chris" }, actor);
  }
  return recordEditPlan(prisma, planFields, actor);
}

/**
 * What's actually SAID in the finished video: the words of the latest successful render's
 * timeline (a condensed Full edit drops most of a long take — captions must describe the cut,
 * not the fluff). Falls back to the selected take's transcript, then any kept take's.
 */
export async function finalTranscriptFor(contentItemId: string): Promise<string> {
  const render = await prisma.render.findFirst({ where: { contentItemId, status: "SUCCESS" }, orderBy: { createdAt: "desc" }, select: { editPlanId: true } });
  const plan = render ? await prisma.editPlan.findUnique({ where: { id: render.editPlanId }, select: { plan: true } }) : null;
  const parsed = EditTimelineSchema.safeParse((plan?.plan as Record<string, unknown> | null)?.timeline);
  if (parsed.success) {
    const timeline = parsed.data;
    const assets = await prisma.mediaAsset.findMany({ where: { id: { in: [...new Set(timeline.clips.map((c) => c.mediaAssetId))] } }, select: { id: true, transcriptWords: true } });
    const wordsByAsset = Object.fromEntries(assets.map((a) => [a.id, parseTranscriptWords(a.transcriptWords)]));
    const text = timelineCaptionWords({ clips: timeline.clips, captions: { ...timeline.captions, uppercase: false } }, wordsByAsset)
      .map((w) => w.word.trim())
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }
  const takeSelection = await getLatestTakeSelection(prisma, contentItemId);
  const selectedAsset = takeSelection ? await prisma.mediaAsset.findUnique({ where: { id: takeSelection.selectedMediaAssetId } }) : null;
  if (selectedAsset?.transcript) return selectedAsset.transcript;
  const anyTake = await prisma.mediaAsset.findFirst({ where: { contentItemId, removedAt: null, transcript: { not: null } }, orderBy: { createdAt: "desc" }, select: { transcript: true } });
  return anyTake?.transcript ?? "(no transcript available)";
}

export async function runPackagingStep(contentItemId: string, platform: PackagingPlatform, actor: Actor) {
  const finalTranscript = await finalTranscriptFor(contentItemId);
  const brandContext = await getBrandContextText(prisma);
  const pkg = await runPlatformPackagingAgent(getModelProvider(), { platform, finalTranscript, brandContext });
  return recordPlatformPackage(
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
    actor,
  );
}

export const AUTOPILOT_JOB_KIND = "autopilot.batch";
const ALL_PLATFORMS: PackagingPlatform[] = ["INSTAGRAM", "TIKTOK", "YOUTUBE"];
const MAX_AUTOPILOT_STEPS = 16;

export interface AutopilotResult {
  steps: string[];
  finalState: ContentState;
  /** Why Autopilot stopped — always set: either "needs you" or an error. */
  stoppedBecause: string;
  /** A heavy step handed to the cloud worker (Vercel): the page follows this job's progress. */
  jobRunId?: string;
}

/**
 * A heavy step that didn't finish in-process: it either started in the cloud (Autopilot stops
 * and says so — press it again when the job is done) or couldn't start. null = it ran here.
 */
function cloudStop(r: RunHeavyJobResult, what: string): { reason: string; jobRunId?: string } | null {
  if (r.status === "done") return null;
  if (r.status === "started") return { reason: `${what} in the cloud — this page shows its progress. Press Autopilot again when it's done to continue.`, jobRunId: r.jobRunId };
  if (r.status === "busy") return { reason: r.message, jobRunId: r.jobRunId };
  return { reason: r.message };
}

/**
 * Autopilot — runs every step the system can take for one item, in order, until the item needs
 * Chris (a creative call, a shoot, an upload, a blocked gate) or is ready to schedule. A
 * human click starts it, so it acts with Chris's authority for the steps he'd otherwise click
 * one by one; it never skips a gate (every step goes through the same domain functions and
 * hard gates as the buttons) and never schedules or publishes — those stay explicit.
 */
export async function runAutopilot(contentItemId: string, actor: Actor): Promise<AutopilotResult> {
  const steps: string[] = [];
  const stateOf = async () => (await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } })).currentState;
  const stop = async (stoppedBecause: string, jobRunId?: string): Promise<AutopilotResult> => ({ steps, finalState: await stateOf(), stoppedBecause, ...(jobRunId ? { jobRunId } : {}) });

  for (let i = 0; i < MAX_AUTOPILOT_STEPS; i++) {
    const state = await stateOf();
    try {
      switch (state) {
        case "IDEA":
          return stop("Waiting on you: select this idea for a week (or approve it on Strategy).");
        case "SELECTED":
          await draftAndIssueProductionContract(prisma, getModelProvider(), { contentItemId, actorId: actor.actorId, triggeredByHuman: true });
          steps.push("Production Director drafted and issued the contract");
          break;
        case "CONTRACTED":
          await applyManualTransition(prisma, { contentItemId, to: "RESEARCHING", actorId: actor.actorId, reason: "Autopilot: start research" });
          steps.push("Started research");
          break;
        case "RESEARCHING": {
          const result = await runPipelineStep(contentItemId, actor);
          steps.push(`Research → Claims Gate → Script: ${result.status}`);
          if (result.status !== "READY") return stop(`Pipeline ended at ${result.status}${"blockReason" in result && result.blockReason ? `: ${result.blockReason}` : ""}`);
          if (result.brandNeedsHumanReview) return stop("Waiting on you: Brand Guardian has concerns about the script — review or edit it.");
          break;
        }
        case "SCRIPTED": {
          const script = await getLatestScriptVersion(prisma, contentItemId);
          const filmable = script ? isScriptVersionFilmable(script) : { ok: false as const, reason: "No script." };
          if (!filmable.ok) return stop(`Waiting on you: ${filmable.reason}`);
          await draftAndIssueCreatorCard(prisma, getModelProvider(), { contentItemId, actorId: actor.actorId, triggeredByHuman: true });
          steps.push("Drafted the Creator Card");
          break;
        }
        case "READY_TO_FILM":
          return stop("Waiting on you: film it (it's on the Film Queue).");
        case "FILMED":
          return stop("Waiting on you: upload the raw takes.");
        case "MEDIA_INGESTED": {
          const assets = await listMediaAssetsForContentItem(prisma, contentItemId);
          if (isAutoTranscriptionEnabled()) {
            for (const a of assets.filter((x) => !x.transcript && x.hasAudio !== false)) {
              const job = await runHeavyJob("transcribe", { contentItemId, mediaAssetId: a.id }, actor);
              const cloud = cloudStop(job, "Transcribing your takes");
              if (cloud) return stop(cloud.reason, cloud.jobRunId);
              if (job.status !== "done") break;
              const r = ((job.outcome.result as { transcribe?: Array<{ status: string; errorMessage?: string | null }> } | null)?.transcribe ?? [])[0];
              const status = r?.status ?? (job.outcome.ok ? "SUCCESS" : "FAILED");
              const err = r?.errorMessage ?? (job.outcome.ok ? null : job.outcome.error);
              steps.push(`Transcribed ${a.originalFilename}: ${status}${err ? ` (${err})` : ""}`);
            }
          }
          await runTakeSelectionStep(contentItemId, actor);
          steps.push("Picked the best take");
          break;
        }
        case "TAKE_SELECTED":
          await runEditPlanStep(contentItemId, actor);
          steps.push("Planned the edit");
          break;
        case "EDIT_PLANNED":
        case "EDITING": {
          const job = await runHeavyJob("render", { contentItemId }, actor);
          const cloud = cloudStop(job, "Rendering your video");
          if (cloud) return stop(cloud.reason, cloud.jobRunId);
          if (job.status !== "done") break;
          const r = (job.outcome.result as { render?: { status: string; errorMessage: string | null } } | null)?.render;
          if (!r) throw new Error(job.outcome.error ?? "render failed");
          steps.push(`Rendered: ${r.status}${r.status === "FAILED" ? ` (${r.errorMessage})` : ""}`);
          if (r.status === "FAILED") return stop(`Render failed: ${r.errorMessage}`);
          break;
        }
        case "RENDERED":
        case "QC_REPAIR": {
          const job = await runHeavyJob("auto-repair", { contentItemId }, actor);
          const cloud = cloudStop(job, "Running the quality check and fixing what it finds");
          if (cloud) return stop(cloud.reason, cloud.jobRunId);
          if (job.status !== "done") break;
          const r = job.outcome.result as { finalState?: string; stoppedBecause?: string | null; steps?: Array<{ action: string; outcome: string }> } | null;
          if (!r?.finalState) throw new Error(job.outcome.error ?? "auto-repair failed");
          steps.push(...(r.steps ?? []).map((s) => `${s.action}: ${s.outcome}`));
          if (r.finalState !== "READY") return stop(r.stoppedBecause ?? `Quality loop ended at ${r.finalState}`);
          break;
        }
        case "READY": {
          const packaged = new Set((await prisma.platformPackage.findMany({ where: { contentItemId }, select: { platform: true } })).map((p) => p.platform));
          const missing = ALL_PLATFORMS.filter((p) => !packaged.has(p));
          for (const platform of missing) {
            await runPackagingStep(contentItemId, platform, actor);
            steps.push(`Packaged for ${platform}`);
          }
          return stop("Ready: passed every gate and packaged — schedule it (or let Calendar's Auto-Fill place it).");
        }
        default:
          return stop(`Nothing for Autopilot to do at ${state}.`);
      }
    } catch (err) {
      return stop(`Stopped at ${state}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return stop("Step limit reached.");
}
