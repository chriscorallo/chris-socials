import { getLatestCreativeBrief, readStoredFullEdit, recordCreativeBrief, type PrismaClient } from "@chris/domain";
import { getBrandContextText, runFootageBriefAgent, scopeProvider, type ModelProvider } from "@chris/agents";
import type { StorageAdapter } from "@chris/media";
import { applyStyleCutChoice } from "./style-cut-job";
import { designMotionForContentItem } from "./motion-design-job";

/**
 * The AI edit as ONE background job (2026-10-23, Chris: "I don't want to be locked in there").
 * The editor's panel used to drive these steps from the browser, so leaving the page stopped
 * the edit after the current step. Now the job runs them in the worker and the panel (or the
 * video page's banner) only follows progress:
 *   1. the Creative Brief — recovered from the take when the video has none (FOOTAGE_BRIEF);
 *   2. the Editor's cut (write → critique → revise; the orchestrator places the screen) saved
 *      as a new version;
 *   3. the Visual Strategist + Motion Designer on top of the free edit's graphics.
 * Every step saves its own version, so a failure late in the chain still leaves the earlier
 * work on the video. Idempotent per step (a brief on record is reused; the cut is always
 * fresh — a stale plan may predate the cutter).
 */
export interface AiEditJobResult {
  briefCreated: boolean;
  editPlanId: string | null;
  hook: string | null;
  rationale: string | null;
  beats: number;
  graphics: number;
  added: number;
  rejected: Array<{ template: string; start: number; reason: string }>;
  warnings: string[];
  state: string;
}

export interface AiEditJobOptions {
  onProgress?: (pct: number, message: string) => void;
  /** Skip the visuals pass (tests, or a cut-only re-run). */
  skipVisuals?: boolean;
  skipTracking?: boolean;
}

export async function aiEditContentItem(
  db: PrismaClient,
  storage: StorageAdapter,
  getModel: () => ModelProvider,
  contentItemId: string,
  actor: { actorId: string },
  options: AiEditJobOptions = {},
): Promise<AiEditJobResult> {
  const progress = options.onProgress ?? (() => undefined);
  const warnings: string[] = [];

  // 1. The plan.
  let briefCreated = false;
  progress(3, "Reading the footage and the plan…");
  const existing = await getLatestCreativeBrief(db, contentItemId);
  if (!existing) {
    const item = await db.contentItem.findUnique({ where: { id: contentItemId }, select: { title: true } });
    const takes = await db.mediaAsset.findMany({ where: { contentItemId, removedAt: null, transcript: { not: null } }, orderBy: { createdAt: "asc" }, select: { transcript: true, durationSeconds: true } });
    const transcript = takes.map((t) => t.transcript).join("\n\n").slice(0, 40_000);
    if (!transcript.trim()) throw new Error("This video has no transcript yet — captions appear once your words are transcribed.");
    progress(6, "AI is reading the footage and writing this video's plan…");
    const brief = await runFootageBriefAgent(scopeProvider(getModel(), { contentItemId }), {
      transcript,
      title: item?.title ?? null,
      durationS: takes.reduce((a, t) => a + (t.durationSeconds ?? 0), 0) || null,
      brandContext: await getBrandContextText(db),
    });
    await recordCreativeBrief(db, { contentItemId, source: "FOOTAGE", brief }, { actorId: actor.actorId, actorType: "SYSTEM" });
    briefCreated = true;
  }

  // 2. The Editor's cut.
  progress(15, "The Editor is writing the cut from your take…");
  const cut = await applyStyleCutChoice(db, storage, contentItemId, "FULL", actor.actorId, { useEditor: true }, { provider: getModel });
  if (!cut.ok) throw new Error(cut.error);
  const report = cut.fullEdit ?? null;
  const hook = report?.hook.text ?? null;
  const rationale = report?.editor?.rationale ?? null;
  const beats = report?.editor?.beats.length ?? 0;
  progress(55, report?.editor ? `The Editor's cut is saved: ${beats} beats, hook “${(hook ?? "").slice(0, 40)}”.` : "The cut is saved.");

  // 3. The visuals.
  let graphics = cut.timeline.visuals.length;
  let added = 0;
  let rejected: AiEditJobResult["rejected"] = [];
  let editPlanId: string | null = cut.editPlanId;
  if (!options.skipVisuals) {
    progress(60, "AI is understanding the video and planning what the viewer needs to see…");
    const vis = await designMotionForContentItem(db, storage, getModel(), contentItemId, actor, { trigger: "HUMAN", replaceExisting: false, strategize: true, skipTracking: options.skipTracking });
    if (vis.status === "SUCCESS") {
      editPlanId = vis.editPlanId ?? editPlanId;
      graphics = vis.visuals?.length ?? graphics;
      added = vis.added?.length ?? 0;
      rejected = (vis.rejectedVisuals ?? []).map((r) => ({ template: r.template, start: r.start, reason: r.reason }));
      warnings.push(...(vis.warnings ?? []));
      progress(95, `${added} graphic${added === 1 ? "" : "s"} added.`);
    } else {
      // The cut stands; the graphics step is reported, never fatal (graceful failure).
      warnings.push(`The graphics step didn't run: ${vis.errorMessage ?? "unknown"}`);
    }
  }
  const state = (await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId }, select: { currentState: true } })).currentState;
  void readStoredFullEdit;
  return { briefCreated, editPlanId, hook, rationale, beats, graphics, added, rejected, warnings, state };
}
