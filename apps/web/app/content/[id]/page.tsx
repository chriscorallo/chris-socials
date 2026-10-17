import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { prisma, getContentItem, listManualTransitions, isScriptVersionFilmable, NEXT_STEP, FINISHING_EDIT_STATES } from "@chris/domain";
import { requireSession } from "../../../lib/session";
import { storageMode } from "../../../lib/storage";
import { RawTakeUploader } from "./RawTakeUploader";
import { NavBar } from "../../components/NavBar";
import { PageShell, Panel, SectionHeading, Badge, Button, ButtonLink, BackLink, CollapsiblePanel, StickyActionBar, contentStateTone, stateLabel, platformLabel } from "../../components/ui";
import {
  selectForWeek,
  advanceManual,
  cancelItem,
  submitContract,
  submitCreatorCard,
  submitSchedule,
  runPipeline,
  runTakeSelector,
  runEditPlanner,
  runRender,
  runQualityGate,
  runPlatformPackaging,
  submitPublishSchedule,
  runPublish,
  runCaptureSnapshots,
  runIngestComments,
  runAnalytics,
  submitTasteFeedback,
  runAdversarialEvaluator,
  tryAutonomousPublishAction,
  runTranscribe,
  submitManualTranscript,
  runAutoRepair,
  draftContractAction,
  draftCreatorCardAction,
  editScriptAction,
  runAutopilotAction,
} from "./actions";

// Server Actions on this page run model calls / ffmpeg synchronously — allow up to the
// Vercel Fluid Compute ceiling instead of the platform default. See /docs/DECISIONS.md.
export const maxDuration = 300;

export default async function ContentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pipelineError?: string; autopilot?: string }>;
}) {
  await requireSession();
  const { id } = await params;
  const { pipelineError, autopilot } = await searchParams;
  const item = await getContentItem(prisma, id);
  if (!item) notFound();

  const isTerminal = item.currentState === "ARCHIVED" || item.currentState === "CANCELLED";
  const manualTransitions = listManualTransitions(item.currentState);
  const latestResearch = item.researchPackets[0];
  const latestScript = item.scriptVersions[0];
  const latestTakeSelection = item.takeSelections[0];
  const latestEditPlan = item.editPlans[0];
  const latestRender = item.renders[0];
  const latestQCReport = item.qcReports[0];
  const ALL_PLATFORMS = ["INSTAGRAM", "TIKTOK", "YOUTUBE"] as const;
  const packagedPlatforms = new Set(item.platformPackages.map((p) => p.platform));

  // The one obvious next action, pinned in the thumb zone on phones (StickyActionBar hides at
  // lg+, where the gold "Next Step" panels below are all visible). Same server actions as the
  // panels — this is a second entry point, never a different behavior. Steps that need input
  // (scheduling, uploads) jump to their panel instead of acting blind.
  const oneTap = (action: (fd: FormData) => Promise<void>, label: string, pending = "Working…") => (
    <form action={action}>
      <input type="hidden" name="contentItemId" value={item.id} />
      <Button tone="primary" className="!px-5" pendingLabel={pending}>{label}</Button>
    </form>
  );
  const jump = (href: string, label: string) => (
    <a href={href} className="btn btn-primary !px-5">{label}</a>
  );
  const scriptFilmable = latestScript ? isScriptVersionFilmable(latestScript).ok : false;
  let sticky: { label: string; node: ReactNode } | null = null;
  switch (item.currentState) {
    case "IDEA": sticky = { label: "Select for this week", node: oneTap(selectForWeek, "Select") }; break;
    case "SELECTED": sticky = { label: "Draft the production contract", node: oneTap(draftContractAction, "Draft", "Drafting…") }; break;
    case "RESEARCHING": sticky = { label: "Research → script pipeline", node: oneTap(runPipeline, "Run", "Running…") }; break;
    case "SCRIPTED": if (scriptFilmable) sticky = { label: "Draft the Creator Card", node: oneTap(draftCreatorCardAction, "Draft", "Drafting…") }; break;
    case "FILMED": sticky = { label: "Upload your raw takes", node: jump("#media", "Upload") }; break;
    case "MEDIA_INGESTED": sticky = { label: "Pick the best take", node: oneTap(runTakeSelector, "Run", "Picking…") }; break;
    case "TAKE_SELECTED": sticky = { label: "Plan the edit", node: oneTap(runEditPlanner, "Plan", "Planning…") }; break;
    case "EDIT_PLANNED": sticky = { label: "Render the video", node: oneTap(runRender, "Render", "Rendering…") }; break;
    case "EDITING": sticky = { label: "Render again", node: oneTap(runRender, "Render", "Rendering…") }; break;
    case "QC_REPAIR": sticky = { label: "Auto-repair and re-check", node: oneTap(runAutoRepair, "Repair", "Repairing…") }; break;
    case "RENDERED": sticky = { label: "Run the Quality Gate", node: oneTap(runQualityGate, "Run", "Checking…") }; break;
    case "READY": sticky = { label: "Pick a date and schedule", node: jump("#schedule", "Schedule") }; break;
    case "SCHEDULED": sticky = { label: "Publish now", node: oneTap(runPublish, "Publish", "Publishing…") }; break;
    case "PUBLISHING": sticky = { label: "Retry publishing", node: oneTap(runPublish, "Retry", "Publishing…") }; break;
    case "PUBLISHED":
    case "MEASURING": sticky = { label: "Capture due snapshots", node: oneTap(runCaptureSnapshots, "Capture", "Capturing…") }; break;
  }
  if (!sticky && !isTerminal && manualTransitions.length > 0) {
    const t = manualTransitions[0]!;
    sticky = {
      label: t.label,
      node: (
        <form action={advanceManual}>
          <input type="hidden" name="contentItemId" value={item.id} />
          <input type="hidden" name="to" value={t.to} />
          <Button tone="primary" className="!px-5">Go</Button>
        </form>
      ),
    };
  }

  return (
    <>
      <NavBar />
      <PageShell maxWidth={760}>
        <BackLink href="/content">Content</BackLink>
        <header className="mb-5 sm:mb-6">
          <p className="eyebrow mb-1">Content Item</p>
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-2xl">{item.title}</h1>
          {item.description && <p className="mt-2 text-[15px] text-[var(--color-text-muted)] sm:text-sm">{item.description}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
            <Badge tone={contentStateTone(item.currentState)}>{stateLabel(item.currentState)}</Badge>
            {item.pillar && <span>{item.pillar}</span>}
            {item.format && <span>· {item.format}</span>}
          </div>
        </header>

        {autopilot && (
          <Panel className="mb-5">
            <p className="text-sm"><span className="font-medium">Autopilot: </span>{autopilot}</p>
          </Panel>
        )}

        {!isTerminal && NEXT_STEP[item.currentState].owner === "SYSTEM" && item.currentState !== "SCHEDULED" && item.currentState !== "PUBLISHED" && item.currentState !== "MEASURING" && (
          <Panel className="mb-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="eyebrow">Autopilot</p>
                <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">
                  Runs every step the system can do from here — through every hard gate — and
                  stops the moment it needs you (filming, uploads, a blocked gate, a script concern)
                  or once it&apos;s ready to schedule. Never schedules or publishes on its own.
                </p>
              </div>
              <form action={runAutopilotAction}>
                <input type="hidden" name="contentItemId" value={item.id} />
                <Button tone="primary" className="w-full sm:w-auto" pendingLabel="Autopilot running…">Run Autopilot</Button>
              </form>
            </div>
          </Panel>
        )}

        {pipelineError && (
          <Panel className="mb-5 !border-[var(--color-rose-500)]/40">
            <p className="text-sm text-[var(--color-rose-400)]">
              <span className="font-medium">Pipeline error: </span>
              {pipelineError}
            </p>
            {pipelineError.toLowerCase().includes("api key") && (
              <p className="mt-1.5 text-[13px] text-[var(--color-text-muted)]">
                Set ANTHROPIC_API_KEY in your environment to enable real AI pipeline runs — see
                /docs/DECISIONS.md.
              </p>
            )}
          </Panel>
        )}

        <div className="flex flex-col gap-5">
          {/* Finishing editor entry point (app/content/[id]/edit) — once there's an edit plan and
              until it publishes, Chris can open the in-house editor to finish the video. */}
          {latestEditPlan && FINISHING_EDIT_STATES.has(item.currentState) && (
            <Panel className="panel-action">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="eyebrow">Editor</p>
                  <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">
                    Trim clips, fix captions, change text, color and framing — then finish and put it on the calendar.
                  </p>
                </div>
                <ButtonLink href={`/content/${item.id}/edit`} tone="primary" className="w-full sm:w-auto">
                  Open editor
                </ButtonLink>
              </div>
            </Panel>
          )}

          {item.currentState === "RESEARCHING" && (
            <Panel className="panel-action">
              <SectionHeading eyebrow="Next Step" title="AI Pipeline" />
              <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
                Runs Research → Claims Gate → Script → Brand Guardian against this item&apos;s
                Production Contract. A Claims Gate BLOCK stops before any script is drafted.
                Requires ANTHROPIC_API_KEY.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <form action={runPipeline}>
                  <input type="hidden" name="contentItemId" value={item.id} />
                  <Button tone="primary">Run AI Research → Script pipeline</Button>
                </form>
              </div>
            </Panel>
          )}

          {item.currentState === "MEDIA_INGESTED" && (
            <Panel className="panel-action">
              <SectionHeading eyebrow="Next Step" title="Take Selector" />
              <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
                Evaluates every uploaded raw take and picks the strongest one. Requires
                ANTHROPIC_API_KEY.
              </p>
              <form action={runTakeSelector}>
                <input type="hidden" name="contentItemId" value={item.id} />
                <Button tone="primary">Run Take Selector</Button>
              </form>
            </Panel>
          )}

          {(item.currentState === "TAKE_SELECTED" || item.currentState === "EDIT_PLANNED") && (
            <Panel className={item.currentState === "TAKE_SELECTED" ? "panel-action" : ""}>
              <SectionHeading eyebrow={item.currentState === "TAKE_SELECTED" ? "Next Step" : "Optional"} title="Edit Planner" />
              <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
                Plans cuts (snapped to real word boundaries when the take is transcribed), word
                captions, punch-ins and text overlays for the selected take.
                {item.currentState === "EDIT_PLANNED" && " Re-planning replaces the current plan (kept in history) with a fresh repair budget."}
              </p>
              <form action={runEditPlanner}>
                <input type="hidden" name="contentItemId" value={item.id} />
                <Button tone={item.currentState === "TAKE_SELECTED" ? "primary" : "ghost"}>
                  {item.currentState === "TAKE_SELECTED" ? "Run Edit Planner" : "Re-plan the edit"}
                </Button>
              </form>
            </Panel>
          )}

          {(item.currentState === "EDIT_PLANNED" ||
            item.currentState === "EDITING" ||
            item.currentState === "QC_REPAIR") && (
            <Panel className="panel-action">
              <SectionHeading eyebrow="Next Step" title="Render" />
              <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
                {item.currentState === "QC_REPAIR"
                  ? "Auto-repair revises the edit plan against the blocking QC issues, re-renders and re-runs the Quality Gate — repeating within the repair budget. Stops early on factual/brand/creative blocks, which a re-edit can't fix."
                  : "Deterministic ffmpeg render + technical QC (loudness, black/frozen frames, format). No AI call."}
              </p>
              <div className="btn-stack">
                {item.currentState === "QC_REPAIR" && (
                  <form action={runAutoRepair}>
                    <input type="hidden" name="contentItemId" value={item.id} />
                    <Button tone="primary">Auto-repair</Button>
                  </form>
                )}
                <form action={runRender}>
                  <input type="hidden" name="contentItemId" value={item.id} />
                  <Button tone={item.currentState === "QC_REPAIR" ? "ghost" : "primary"}>
                    {item.currentState === "EDIT_PLANNED" ? "Start render" : "Render again (same plan)"}
                  </Button>
                </form>
              </div>
            </Panel>
          )}

          {item.currentState === "RENDERED" && (
            <Panel className="panel-action">
              <SectionHeading eyebrow="Next Step" title="Quality Gate" />
              <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
                Evaluates all four hard gates — FACTUAL, TECHNICAL, BRAND, CREATIVE (spec §9
                step 16) — against this render. A single BLOCK on any gate sends this back to
                QC_REPAIR; all four must PASS to reach READY. Runs a real Visual QA vision call
                against sampled frames — requires ANTHROPIC_API_KEY.
              </p>
              <form action={runQualityGate}>
                <input type="hidden" name="contentItemId" value={item.id} />
                <Button tone="primary">Run Quality Gate</Button>
              </form>
            </Panel>
          )}

          {(item.currentState === "READY" || item.currentState === "SCHEDULED") && (
            <Panel className="panel-action">
              <SectionHeading eyebrow="Next Step" title="Platform Packaging" />
              <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
                Packages the final video per platform (spec §9 step 20) — required before
                publishing. Requires ANTHROPIC_API_KEY.
              </p>
              <div className="btn-stack">
                {ALL_PLATFORMS.map((platform) => (
                  <form action={runPlatformPackaging} key={platform}>
                    <input type="hidden" name="contentItemId" value={item.id} />
                    <input type="hidden" name="platform" value={platform} />
                    <Button>
                      {packagedPlatforms.has(platform) ? "Re-package" : "Package"} {platformLabel(platform)}
                    </Button>
                  </form>
                ))}
              </div>
            </Panel>
          )}

          {item.currentState === "READY" && (
            <Panel className="panel-action" id="schedule">
              <form action={submitPublishSchedule}>
                <SectionHeading eyebrow="Next Step" title="Schedule for Publishing" />
                <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
                  Drives READY → SCHEDULED (spec §9 step 19). Pick every platform this item was
                  packaged for above.
                </p>
                <input type="hidden" name="contentItemId" value={item.id} />
                <label className="block">
                  <span className="field-label">Scheduled date/time</span>
                  <input type="datetime-local" name="scheduledDate" required className="field-input" />
                </label>
                <div className="mt-3 mb-4 grid grid-cols-3 gap-2 text-[13px]">
                  {ALL_PLATFORMS.map((platform) => (
                    <label
                      key={platform}
                      className="flex min-h-[44px] cursor-pointer items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-white/[0.03] px-2 has-[:checked]:border-[var(--color-gold-500)]/60 has-[:checked]:bg-[var(--color-gold-500)]/10"
                    >
                      <input type="checkbox" name="targetPlatforms" value={platform} /> {platformLabel(platform)}
                    </label>
                  ))}
                </div>
                <Button tone="primary" className="w-full sm:w-auto" pendingLabel="Scheduling…">Schedule</Button>
              </form>
            </Panel>
          )}

          {item.currentState === "READY" && (
            <Panel>
              <SectionHeading eyebrow="Optional" title="Try Autonomous Publish" />
              <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
                Spec §23 Level 3 — schedules and publishes without a manual click, but only if
                this item&apos;s production tier has genuinely earned PUBLISHING autonomy (see
                Learnings). A no-op with a clear reason if not — Schedule/Publish above still
                works either way.
              </p>
              <form action={tryAutonomousPublishAction}>
                <input type="hidden" name="contentItemId" value={item.id} />
                <Button>Try autonomous publish</Button>
              </form>
            </Panel>
          )}

          {item.currentState === "SCHEDULED" && (
            <Panel className="panel-action">
              <SectionHeading eyebrow="Next Step" title="Publish" />
              <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
                Runs Preflight + Publish + Verify (spec §9 steps 21-22) against every scheduled
                target platform. One platform failing never blocks the others; safe to retry —
                an already-succeeded platform is never re-published.
              </p>
              <form action={runPublish}>
                <input type="hidden" name="contentItemId" value={item.id} />
                <Button tone="primary">Publish now</Button>
              </form>
            </Panel>
          )}

          {item.currentState === "PUBLISHING" && (
            <Panel className="panel-action">
              <SectionHeading eyebrow="Next Step" title="Publish" />
              <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
                Still in progress, or a previous attempt didn&apos;t fully succeed — safe to
                retry below (idempotent per platform).
              </p>
              <form action={runPublish}>
                <input type="hidden" name="contentItemId" value={item.id} />
                <Button tone="primary">Retry publish</Button>
              </form>
            </Panel>
          )}

          {(item.currentState === "PUBLISHED" || item.currentState === "MEASURING") && (
            <Panel className="panel-action">
              <SectionHeading eyebrow="Next Step" title="Analytics" />
              <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
                Spec §9 steps 23-25: metric snapshots (T+1h…T+30d, real platform data only —
                absent metrics stay absent, never fabricated), comment ingestion, and a
                performance evaluation across all eight categories.
              </p>
              <div className="btn-stack">
                <form action={runCaptureSnapshots}>
                  <input type="hidden" name="contentItemId" value={item.id} />
                  <Button tone="primary">Capture due snapshots</Button>
                </form>
                <form action={runIngestComments}>
                  <input type="hidden" name="contentItemId" value={item.id} />
                  <Button>Ingest comments</Button>
                </form>
                <form action={runAnalytics}>
                  <input type="hidden" name="contentItemId" value={item.id} />
                  <Button>Run performance evaluation</Button>
                </form>
              </div>
            </Panel>
          )}

          {item.currentState === "IDEA" && (
            <Panel className="panel-action">
              <form action={selectForWeek}>
                <input type="hidden" name="contentItemId" value={item.id} />
                <Button tone="primary">Select for this week</Button>
              </form>
            </Panel>
          )}

          {item.currentState === "SELECTED" && (
            <Panel className="panel-action">
              <SectionHeading eyebrow="Next Step" title="Production Contract" />
              <p className="mb-3 text-[13px] text-[var(--color-text-muted)]">
                The Production Director drafts the whole contract (tier, length, research depth,
                factual risk, scope, what not to expand into) from the idea and this week&apos;s thesis.
              </p>
              <form action={draftContractAction}>
                <input type="hidden" name="contentItemId" value={item.id} />
                <Button tone="primary">Draft &amp; issue contract</Button>
              </form>
              <details className="mt-4">
                <summary className="flex min-h-[44px] cursor-pointer items-center text-[14px] text-[var(--color-text-muted)] sm:text-[13px]">Or fill it in by hand</summary>
              <form action={submitContract} className="mt-3 flex flex-col gap-4">
                <input type="hidden" name="contentItemId" value={item.id} />
                <label className="block">
                  <span className="field-label">Purpose</span>
                  <input name="purpose" required className="field-input" />
                </label>
                <label className="block">
                  <span className="field-label">Primary idea</span>
                  <input name="primaryIdea" required className="field-input" />
                </label>
                <label className="block">
                  <span className="field-label">Audience promise</span>
                  <input name="audiencePromise" required className="field-input" />
                </label>
                <label className="block">
                  <span className="field-label">Topic</span>
                  <input name="topic" required className="field-input" />
                </label>
                <label className="block">
                  <span className="field-label">Format</span>
                  <input name="format" required defaultValue={item.format ?? ""} className="field-input" />
                </label>
                <div className="grid grid-cols-2 gap-4">
                  <label className="block">
                    <span className="field-label">Production tier</span>
                    <select name="productionTier" defaultValue="FAST" className="field-input">
                      <option value="RAW">Raw</option>
                      <option value="FAST">Fast</option>
                      <option value="MEDIUM">Medium</option>
                      <option value="HERO">Hero</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="field-label">Research depth</span>
                    <select name="researchDepth" defaultValue="LIGHT" className="field-input">
                      <option value="NONE">None</option>
                      <option value="LIGHT">Light</option>
                      <option value="STANDARD">Standard</option>
                      <option value="DEEP">Deep</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="field-label">Target length — min seconds</span>
                    <input name="targetLengthMinSeconds" type="number" required defaultValue={30} className="field-input" />
                  </label>
                  <label className="block">
                    <span className="field-label">Target length — max seconds</span>
                    <input name="targetLengthMaxSeconds" type="number" required defaultValue={60} className="field-input" />
                  </label>
                  <label className="block">
                    <span className="field-label">Factual risk</span>
                    <select name="factualRisk" defaultValue="LOW" className="field-input">
                      <option value="LOW">Low</option>
                      <option value="MEDIUM">Medium</option>
                      <option value="HIGH">High</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="field-label">Human editing budget (minutes, optional)</span>
                    <input name="humanEditingBudgetMinutes" type="number" className="field-input" />
                  </label>
                </div>
                <label className="block">
                  <span className="field-label">Experiment (optional)</span>
                  <input name="experiment" className="field-input" />
                </label>
                <label className="block">
                  <span className="field-label">Platform opportunities (one per line)</span>
                  <textarea name="platformOpportunities" rows={2} className="field-input" />
                </label>
                <label className="block">
                  <span className="field-label">Required assets (one per line)</span>
                  <textarea name="requiredAssets" rows={2} className="field-input" />
                </label>
                <label className="block">
                  <span className="field-label">Scope</span>
                  <textarea name="scope" required rows={2} className="field-input" />
                </label>
                <label className="block">
                  <span className="field-label">DO NOT expand into</span>
                  <textarea name="doNotExpandInto" required rows={2} className="field-input" />
                </label>
                <Button>Issue contract &amp; move to CONTRACTED</Button>
              </form>
              </details>
            </Panel>
          )}

          {item.currentState === "SCRIPTED" && (
            <Panel className="panel-action">
              <SectionHeading eyebrow="Next Step" title="Creator Card" />
              {latestScript && !isScriptVersionFilmable(latestScript).ok ? (
                <p className="mb-3 text-[13px] text-[var(--color-rose-400)]">
                  {(isScriptVersionFilmable(latestScript) as { reason: string }).reason}
                </p>
              ) : (
                <>
                  <p className="mb-3 text-[13px] text-[var(--color-text-muted)]">
                    Drafts only what you need on set — hook, talking points, setup — from the fact-checked script.
                  </p>
                  <form action={draftCreatorCardAction}>
                    <input type="hidden" name="contentItemId" value={item.id} />
                    <Button tone="primary">Draft &amp; issue Creator Card</Button>
                  </form>
                </>
              )}
              <details className="mt-4">
                <summary className="flex min-h-[44px] cursor-pointer items-center text-[14px] text-[var(--color-text-muted)] sm:text-[13px]">Or write it by hand</summary>
              <form action={submitCreatorCard} className="mt-3 flex flex-col gap-4">
                <input type="hidden" name="contentItemId" value={item.id} />
                <label className="block">
                  <span className="field-label">Hook</span>
                  <input name="hook" required className="field-input" />
                </label>
                <label className="block">
                  <span className="field-label">Talking points (one per line)</span>
                  <textarea name="talkingPoints" required rows={3} className="field-input" />
                </label>
                <div className="grid grid-cols-2 gap-4">
                  <label className="block">
                    <span className="field-label">Setup</span>
                    <select name="setup" defaultValue="DESK" className="field-input">
                      <option value="DESK">Desk</option>
                      <option value="STANDING">Standing</option>
                      <option value="CASUAL">Casual</option>
                      <option value="WALKING">Walking</option>
                      <option value="SKIT">Skit</option>
                      <option value="SPECIAL">Special</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="field-label">Estimated minutes (optional)</span>
                    <input name="estimatedMinutes" type="number" className="field-input" />
                  </label>
                </div>
                <label className="block">
                  <span className="field-label">Notes (optional)</span>
                  <textarea name="notes" rows={2} className="field-input" />
                </label>
                <Button>Issue Creator Card &amp; move to READY_TO_FILM</Button>
              </form>
              </details>
            </Panel>
          )}

          {!isTerminal && manualTransitions.length > 0 && (
            <Panel className="panel-action">
              <SectionHeading eyebrow="Next Step" title="Advance" />
              {manualTransitions.map((t) => (
                <div key={t.to} className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
                  <form action={advanceManual}>
                    <input type="hidden" name="contentItemId" value={item.id} />
                    <input type="hidden" name="to" value={t.to} />
                    <Button tone="primary">{t.label}</Button>
                  </form>
                  <span className="text-[13px] text-[var(--color-text-muted)]">{t.description}</span>
                </div>
              ))}
            </Panel>
          )}

          {item.productionContract && (
            <CollapsiblePanel eyebrow="Contracted" title="Production Contract">
              <p className="text-sm">
                <span className="font-medium">{item.productionContract.purpose}</span> —{" "}
                {item.productionContract.primaryIdea}
              </p>
              <p className="mt-1.5 text-[13px] text-[var(--color-text-muted)]">
                Tier: {item.productionContract.productionTier} · Research:{" "}
                {item.productionContract.researchDepth} · Factual risk:{" "}
                {item.productionContract.factualRisk}
              </p>
              <p className="mt-1.5 text-[13px]">
                <span className="font-medium">DO NOT expand into: </span>
                {item.productionContract.doNotExpandInto}
              </p>
            </CollapsiblePanel>
          )}

          {latestResearch && (
            <CollapsiblePanel eyebrow="Research" title="Research Packet">
              <p className="mb-2 text-[13px] text-[var(--color-text-muted)]">
                Status: <Badge tone="neutral">{latestResearch.status}</Badge> · Confidence:{" "}
                {latestResearch.confidence}
              </p>
              <p className="text-sm">{latestResearch.primaryClaim}</p>
              <p className="mt-2 text-[13px]">
                <span className="font-medium">Content-safe wording: </span>
                {latestResearch.contentSafeWording}
              </p>
              {latestResearch.claimsGateResult != null && (
                <p className="mt-2 text-[13px]">
                  <span className="font-medium">Claims Gate: </span>
                  {(latestResearch.claimsGateResult as { result?: string }).result ?? "unknown"}
                </p>
              )}
            </CollapsiblePanel>
          )}

          {latestScript && (() => {
            const gate = latestScript.scriptClaimsGateResult as
              | { result?: string; blockReason?: string | null; requiredEdits?: string[] }
              | null;
            const brand = latestScript.brandGuardianReport as
              | { brandScore?: number; voiceScore?: number; requiredChanges?: string[] }
              | null;
            const editable = item.currentState === "SCRIPTED" || item.currentState === "RESEARCH_BLOCKED";
            return (
              <CollapsiblePanel
                eyebrow={`Script · v${item.scriptVersions.length}${latestScript.authorType === "HUMAN" ? " · your edit" : ""}`}
                title="Latest Draft"
                defaultOpen={editable || item.currentState === "READY_TO_FILM"}
              >
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{latestScript.spokenScript}</p>
                <p className="mt-2 text-[13px] text-[var(--color-text-muted)]">
                  Target: {latestScript.targetRuntimeSeconds}s · Estimated speaking:{" "}
                  {latestScript.estimatedSpeakingRuntimeSeconds}s
                </p>
                <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-medium">Fact check of this script:</span>
                  {gate?.result ? (
                    <Badge tone={gate.result === "PASS" ? "emerald" : "rose"}>{gate.result}</Badge>
                  ) : (
                    <Badge tone="neutral">not run</Badge>
                  )}
                  {brand && (
                    <span className="text-[var(--color-text-muted)]">
                      · Brand {brand.brandScore ?? "n/a"} / Voice {brand.voiceScore ?? "n/a"}
                    </span>
                  )}
                </p>
                {gate?.result && gate.result !== "PASS" && (
                  <p className="mt-1 text-[13px] text-[var(--color-rose-400)]">
                    {gate.blockReason ?? (gate.requiredEdits ?? []).join("; ")}
                  </p>
                )}
                {(brand?.requiredChanges ?? []).length > 0 && (
                  <p className="mt-1 text-[13px] text-[var(--color-gold-400)]">
                    Brand Guardian: {brand!.requiredChanges!.join("; ")}
                  </p>
                )}
                {editable && (
                  <details className="mt-3">
                    <summary className="flex min-h-[44px] cursor-pointer items-center text-[14px] text-[var(--color-text-muted)] sm:text-[13px]">Edit the script in your own words</summary>
                    <form action={editScriptAction} className="mt-2 flex flex-col gap-2">
                      <input type="hidden" name="contentItemId" value={item.id} />
                      <input type="hidden" name="baseScriptVersionId" value={latestScript.id} />
                      <textarea name="spokenScript" rows={8} defaultValue={latestScript.spokenScript} className="field-input" />
                      <input name="note" placeholder="What you changed (optional)" className="field-input" />
                      <p className="text-[12px] text-[var(--color-text-faint)]">
                        Saved as a new version, then re-checked by the Claims Gate and Brand Guardian before it can be filmed.
                      </p>
                      <div><Button tone="primary">Save &amp; re-check</Button></div>
                    </form>
                  </details>
                )}
                {item.scriptVersions.length > 1 && (
                  <details className="mt-2">
                    <summary className="flex min-h-[44px] cursor-pointer items-center text-[14px] text-[var(--color-text-muted)] sm:text-[13px]">History ({item.scriptVersions.length} versions)</summary>
                    <ol className="mt-2 flex flex-col gap-1 text-[12px] text-[var(--color-text-muted)]">
                      {item.scriptVersions.map((v, i) => (
                        <li key={v.id}>
                          v{item.scriptVersions.length - i} · {v.authorType === "HUMAN" ? "you" : "AI"} ·{" "}
                          {(v.scriptClaimsGateResult as { result?: string } | null)?.result ?? "unchecked"}
                          {v.revisionNote ? ` — ${v.revisionNote}` : ""} ({v.createdAt.toLocaleString()})
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </CollapsiblePanel>
            );
          })()}

          {latestTakeSelection && (
            <CollapsiblePanel eyebrow="Production" title="Take Selection">
              <p className="mb-2 text-[13px] text-[var(--color-text-muted)]">
                Confidence: {latestTakeSelection.confidence}
              </p>
              <p className="text-sm">{latestTakeSelection.reason}</p>
            </CollapsiblePanel>
          )}

          {latestEditPlan && (
            <CollapsiblePanel eyebrow="Production" title="Edit Plan">
              <p className="mb-2 text-[13px] text-[var(--color-text-muted)]">
                Tier: {latestEditPlan.productionTier} · Target: {latestEditPlan.targetDurationSeconds}s
                {latestEditPlan.doNothingElse ? " · restraint: DO NOTHING ELSE" : ""}
              </p>
              <p className="text-sm">{(latestEditPlan.plan as { rationale?: string }).rationale}</p>
              {(() => {
                const plan = latestEditPlan.plan as {
                  segments?: { startSeconds: number; endSeconds: number }[];
                  textOverlays?: { text: string; style: string; startSeconds: number; endSeconds: number }[];
                  captions?: { enabled: boolean; style: string; position: string } | null;
                  punchIns?: { start: number; end: number; zoom: number }[];
                };
                return (
                  <ul className="mt-2 flex flex-col gap-1 text-[13px] text-[var(--color-text-muted)]">
                    <li>Cuts: {(plan.segments ?? []).map((g) => `${g.startSeconds.toFixed(1)}–${g.endSeconds.toFixed(1)}s`).join(", ") || "none"}</li>
                    <li>
                      Captions:{" "}
                      {plan.captions == null
                        ? "default (on, CLEAN, lower — when the take has word timings)"
                        : plan.captions.enabled
                          ? `${plan.captions.style}, ${plan.captions.position.toLowerCase()}`
                          : "off"}
                    </li>
                    {(plan.textOverlays ?? []).length > 0 && (
                      <li>Overlays: {plan.textOverlays!.map((o) => `“${o.text}” (${o.style}, ${o.startSeconds}–${o.endSeconds}s)`).join("; ")}</li>
                    )}
                    {(plan.punchIns ?? []).length > 0 && (
                      <li>Punch-ins: {plan.punchIns!.map((p) => `${p.zoom}× ${p.start}–${p.end}s`).join(", ")}</li>
                    )}
                    {latestEditPlan.revisionReason && <li className="text-[var(--color-text-faint)]">Revision: {latestEditPlan.revisionReason}</li>}
                  </ul>
                );
              })()}
            </CollapsiblePanel>
          )}

          {latestRender && (
            <CollapsiblePanel eyebrow="Production" title={`Render (attempt ${latestRender.attempt})`} defaultOpen={latestRender.status === "SUCCESS"}>
              <p className="mb-2 text-[13px] text-[var(--color-text-muted)]">
                Status: <Badge tone={latestRender.status === "SUCCESS" ? "emerald" : latestRender.status === "FAILED" ? "rose" : "neutral"}>{latestRender.status}</Badge>
                {latestRender.width && latestRender.height ? ` · ${latestRender.width}x${latestRender.height}` : ""}
                {latestRender.durationSeconds ? ` · ${latestRender.durationSeconds.toFixed(1)}s` : ""}
              </p>
              {latestRender.storageKey && latestRender.status === "SUCCESS" && (
                <video
                  src={`/api/media/${latestRender.storageKey}`}
                  controls
                  preload="metadata"
                  playsInline
                  className="mx-auto mb-3 block max-h-[70dvh] w-auto max-w-full rounded-lg border border-[var(--color-border)] bg-black sm:mx-0 sm:max-h-[480px]"
                />
              )}
              {FINISHING_EDIT_STATES.has(item.currentState) && (
                <div className="mb-3">
                  <ButtonLink href={`/content/${item.id}/edit`}>Edit this video</ButtonLink>
                </div>
              )}
              {latestRender.technicalQCReport != null && (() => {
                const qc = latestRender.technicalQCReport as {
                  overall?: string;
                  checks?: { name: string; passed: boolean; detail: string; severity?: string }[];
                  measurements?: { integratedLufs?: number | null; truePeakDbtp?: number | null };
                  unexecutedInstructions?: string[];
                  captions?: { rendered: number; relocatedAroundOverlays: number };
                };
                const problems = (qc.checks ?? []).filter((c) => !c.passed);
                return (
                  <div className="flex flex-col gap-1 text-[13px]">
                    <p>
                      <span className="font-medium">Technical QC: </span>
                      <Badge tone={qc.overall === "PASS" ? "emerald" : "rose"}>{qc.overall ?? "unknown"}</Badge>
                      {qc.measurements?.integratedLufs != null && ` · ${qc.measurements.integratedLufs.toFixed(1)} LUFS`}
                      {qc.measurements?.truePeakDbtp != null && ` · peak ${qc.measurements.truePeakDbtp.toFixed(1)} dBTP`}
                      {qc.captions && ` · ${qc.captions.rendered} caption phrases${qc.captions.relocatedAroundOverlays ? ` (${qc.captions.relocatedAroundOverlays} moved around overlays)` : ""}`}
                    </p>
                    {problems.map((c) => (
                      <p key={c.name} className={c.severity === "WARN" ? "text-[var(--color-gold-400)]" : "text-[var(--color-rose-400)]"}>
                        {c.severity === "WARN" ? "Warning" : "Fail"} · {c.name}: {c.detail}
                      </p>
                    ))}
                    {(qc.unexecutedInstructions ?? []).length > 0 && (
                      <p className="text-[var(--color-text-faint)]">
                        Planned but not executed by the renderer yet: {qc.unexecutedInstructions!.join("; ")}
                      </p>
                    )}
                  </div>
                );
              })()}
              {latestRender.errorMessage && (
                <p className="mt-1.5 text-[13px] text-[var(--color-rose-400)]">{latestRender.errorMessage}</p>
              )}
            </CollapsiblePanel>
          )}

          {latestQCReport && (
            <CollapsiblePanel
              eyebrow="Quality"
              title="Quality Gate"
              defaultOpen={latestQCReport.overallStatus !== "PASS" && (item.currentState === "QC_REPAIR" || item.currentState === "QC_BLOCKED")}
              meta={<Badge tone={latestQCReport.overallStatus === "PASS" ? "emerald" : "rose"}>{latestQCReport.overallStatus}</Badge>}
            >
              <p className="mb-2 text-[13px]">
                Overall: <Badge tone={latestQCReport.overallStatus === "PASS" ? "emerald" : "rose"}>{latestQCReport.overallStatus}</Badge>
              </p>
              <ul className="mb-2 flex flex-wrap gap-2 text-[13px]">
                <li>
                  FACTUAL: <Badge tone="neutral">{latestQCReport.factualStatus}</Badge>
                </li>
                <li>
                  TECHNICAL: <Badge tone="neutral">{latestQCReport.technicalStatus}</Badge>
                </li>
                <li>
                  BRAND: <Badge tone="neutral">{latestQCReport.brandStatus}</Badge>
                </li>
                <li>
                  CREATIVE: <Badge tone="neutral">{latestQCReport.creativeStatus}</Badge>
                </li>
              </ul>
              {Array.isArray(latestQCReport.reasons) && latestQCReport.reasons.length > 0 && (
                <ul className="list-disc pl-5 text-[13px] text-[var(--color-rose-400)]">
                  {(latestQCReport.reasons as string[]).map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              )}
              {latestQCReport.visualQAImpression && (
                <p className="mt-2 text-[13px] italic text-[var(--color-text-muted)]">
                  Visual QA: {latestQCReport.visualQAImpression}
                </p>
              )}
              {item.latestQCIssues.length > 0 && (
                <>
                  <p className="mb-1.5 mt-3 text-[13px] font-medium">Issues ({item.latestQCIssues.length})</p>
                  <ul className="flex flex-col gap-1.5 text-[13px] text-[var(--color-text-muted)]">
                    {item.latestQCIssues.map((issue) => (
                      <li key={issue.id}>
                        <Badge tone={issue.severity === "BLOCKING" ? "rose" : "neutral"}>{issue.severity}</Badge>{" "}
                        {issue.category} — {issue.description}
                        {issue.timestampSeconds != null ? ` (t=${issue.timestampSeconds.toFixed(1)}s)` : ""}
                        {issue.recommendedRepair ? ` — fix: ${issue.recommendedRepair}` : ""}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CollapsiblePanel>
          )}

          {item.platformPackages.length > 0 && (
            <CollapsiblePanel eyebrow="Distribution" title="Platform Packages">
              <div className="flex flex-col gap-3">
                {ALL_PLATFORMS.filter((p) => packagedPlatforms.has(p)).map((platform) => {
                  const pkg = item.platformPackages.find((p) => p.platform === platform)!;
                  return (
                    <div key={platform} className="border-t border-[var(--color-border)] pt-3 first:border-0 first:pt-0">
                      <p className="text-[13px]">
                        <span className="font-medium">{platformLabel(platform)}</span>
                        {pkg.title ? ` — ${pkg.title}` : ""}
                      </p>
                      <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">{pkg.caption}</p>
                      {(pkg.hashtags as string[]).length > 0 && (
                        <p className="mt-1 text-xs text-[var(--color-text-faint)]">
                          {(pkg.hashtags as string[]).join(" ")}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </CollapsiblePanel>
          )}

          {item.publications.length > 0 && (
            <CollapsiblePanel eyebrow="Distribution" title="Publications" defaultOpen={item.currentState === "PUBLISHING"}>
              <div className="flex flex-col gap-2">
                {ALL_PLATFORMS.filter((p) => item.publications.some((pub) => pub.platform === p)).map((platform) => {
                  const latest = item.publications.find((p) => p.platform === platform)!;
                  return (
                    <p key={platform} className="text-[13px]">
                      <span className="font-medium">{platformLabel(platform)}</span> (attempt {latest.attempt}):{" "}
                      <Badge tone={latest.status === "SUCCESS" ? "emerald" : latest.status === "DRAFT" ? "gold" : "rose"}>
                        {latest.status}
                      </Badge>
                      {latest.url && (
                        <>
                          {" — "}
                          <a href={latest.url} className="link-quiet break-all underline">
                            {latest.url}
                          </a>
                        </>
                      )}
                      {latest.errorMessage && (
                        <span className={latest.status === "DRAFT" ? "text-[var(--color-text-muted)]" : "text-[var(--color-rose-400)]"}>
                          {" — "}
                          {latest.errorMessage}
                        </span>
                      )}
                    </p>
                  );
                })}
              </div>
            </CollapsiblePanel>
          )}

          {item.performanceSnapshots.length > 0 && (
            <CollapsiblePanel eyebrow="Learning" title="Performance Snapshots" defaultOpen={item.currentState === "PUBLISHED" || item.currentState === "MEASURING"}>
              <p className="mb-3 text-[13px] text-[var(--color-text-muted)]">
                Absent metrics mean the platform genuinely doesn&apos;t return them — never
                fabricated.
              </p>
              {/* Phones: one card per snapshot (a metric grid) instead of an 8-column table. */}
              <ul className="flex flex-col gap-2 sm:hidden">
                {item.performanceSnapshots.map((s) => (
                  <li key={s.id} className="rounded-xl border border-[var(--color-border)] bg-white/[0.03] p-3">
                    <p className="mb-2 flex items-center justify-between text-[13px]">
                      <span className="font-medium">{platformLabel(s.platform)}</span>
                      <Badge tone="neutral">{s.offset.replace("T_PLUS_", "T+").replace("H", "h").replace("D", "d")}</Badge>
                    </p>
                    <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-[13px]">
                      {([
                        ["Views", s.viewCount],
                        ["Likes", s.likeCount],
                        ["Comments", s.commentCount],
                        ["Shares", s.shareCount],
                        ["Saves", s.saveCount],
                        ["Avg watch", s.avgWatchTimeSeconds != null ? `${s.avgWatchTimeSeconds}s` : null],
                      ] as const).map(([k, v]) => (
                        <div key={k} className="min-w-0">
                          <dt className="text-[11px] text-[var(--color-text-faint)]">{k}</dt>
                          <dd className="font-medium tabular-nums">{v == null ? "—" : typeof v === "number" ? v.toLocaleString() : v}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto rounded-lg border border-[var(--color-border)] sm:block">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-text-faint)]">
                      <th className="px-3 py-2 font-medium">Platform</th>
                      <th className="px-3 py-2 font-medium">Offset</th>
                      <th className="px-3 py-2 font-medium">Views</th>
                      <th className="px-3 py-2 font-medium">Likes</th>
                      <th className="px-3 py-2 font-medium">Comments</th>
                      <th className="px-3 py-2 font-medium">Shares</th>
                      <th className="px-3 py-2 font-medium">Saves</th>
                      <th className="px-3 py-2 font-medium">Avg watch (s)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {item.performanceSnapshots.map((s) => (
                      <tr key={s.id} className="border-b border-[var(--color-border)] last:border-0">
                        <td className="px-3 py-2">{s.platform}</td>
                        <td className="px-3 py-2">{s.offset.replace("T_PLUS_", "T+").replace("H", "h").replace("D", "d")}</td>
                        <td className="px-3 py-2">{s.viewCount ?? "—"}</td>
                        <td className="px-3 py-2">{s.likeCount ?? "—"}</td>
                        <td className="px-3 py-2">{s.commentCount ?? "—"}</td>
                        <td className="px-3 py-2">{s.shareCount ?? "—"}</td>
                        <td className="px-3 py-2">{s.saveCount ?? "—"}</td>
                        <td className="px-3 py-2">{s.avgWatchTimeSeconds ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CollapsiblePanel>
          )}

          {item.performanceEvaluations.length > 0 &&
            (() => {
              const latest = item.performanceEvaluations[0]!;
              const categories = latest.categories as {
                category: string;
                assessment: string;
                confidence: number;
                dataCompleteness: string;
              }[];
              return (
                <CollapsiblePanel eyebrow="Learning" title="Performance Evaluation">
                  <p className="text-sm">{latest.overallSummary}</p>
                  {latest.strategicallyValuableDespiteLowerViews && (
                    <p className="mt-1.5 text-[13px] text-[var(--color-gold-400)]">
                      Strategically valuable despite lower views.
                    </p>
                  )}
                  <ul className="mt-3 flex flex-col gap-2 text-[13px]">
                    {categories.map((c, i) => (
                      <li key={i}>
                        <span className="font-medium">{c.category}</span>{" "}
                        <span className="text-[var(--color-text-faint)]">
                          ({c.dataCompleteness.toLowerCase()}, confidence {c.confidence.toFixed(2)})
                        </span>
                        : <span className="text-[var(--color-text-muted)]">{c.assessment}</span>
                      </li>
                    ))}
                  </ul>
                </CollapsiblePanel>
              );
            })()}

          {item.comments.length > 0 && (
            <CollapsiblePanel eyebrow="Audience" title={`Comments (${item.comments.length})`}>
              <ul className="flex flex-col gap-1.5 text-[13px]">
                {item.comments.slice(0, 20).map((c) => (
                  <li key={c.id}>
                    <Badge tone="neutral">{c.platform}</Badge>
                    {c.authorHandle ? ` ${c.authorHandle}` : ""}:{" "}
                    <span className="text-[var(--color-text-muted)]">{c.text}</span>
                  </li>
                ))}
              </ul>
            </CollapsiblePanel>
          )}

          {item.creatorCard && (
            <CollapsiblePanel eyebrow="Production" title="Creator Card" defaultOpen={item.currentState === "READY_TO_FILM"}>
              <p className="text-sm font-medium">{item.creatorCard.hook}</p>
              <ul className="mt-2 list-disc pl-5 text-[13px] text-[var(--color-text-muted)]">
                {(item.creatorCard.talkingPoints as string[]).map((point, i) => (
                  <li key={i}>{point}</li>
                ))}
              </ul>
              <p className="mt-2 text-[13px] text-[var(--color-text-faint)]">Setup: {item.creatorCard.setup}</p>
            </CollapsiblePanel>
          )}

          <Panel id="media" className={item.currentState === "FILMED" ? "panel-action" : ""}>
            <SectionHeading eyebrow="Assets" title="Media" />
            <RawTakeUploader contentItemId={item.id} mode={storageMode} />
            {item.mediaAssets.length > 0 && !item.mediaAssets.some((a) => a.transcript) && (
              <form action={runTranscribe} className="mt-3">
                <input type="hidden" name="contentItemId" value={item.id} />
                <Button>Transcribe all takes</Button>
              </form>
            )}
            <ul className="mt-3 flex flex-col gap-3 text-[13px]">
              {item.mediaAssets.map((asset) => (
                <li key={asset.id} className="flex flex-col gap-1.5">
                  <div>
                    <a href={`/api/media/${asset.storageKey}`} className="link-quiet break-all underline">
                      {asset.originalFilename}
                    </a>{" "}
                    <span className="text-[var(--color-text-faint)]">
                      ({asset.sizeBytes >= 1024 * 1024 ? `${(asset.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : `${(asset.sizeBytes / 1024).toFixed(1)} KB`}
                      {asset.durationSeconds ? ` · ${asset.durationSeconds.toFixed(1)}s` : ""})
                    </span>{" "}
                    {asset.transcript ? (
                      <Badge tone="emerald">{asset.transcriptSource === "MANUAL" ? "transcript (typed)" : "transcript + word timings"}</Badge>
                    ) : (
                      <Badge tone="neutral">no transcript yet</Badge>
                    )}
                  </div>
                  {asset.transcript && (
                    <p className="line-clamp-3 text-[var(--color-text-muted)]">{asset.transcript}</p>
                  )}
                  <details className="text-[var(--color-text-muted)]">
                    <summary className="flex min-h-[44px] cursor-pointer items-center text-[13px] text-[var(--color-text-muted)] sm:text-[12px]">
                      {asset.transcript ? "Fix transcript / re-transcribe" : "Transcribe or paste transcript"}
                    </summary>
                    <div className="mt-2 flex flex-col gap-2">
                      <form action={runTranscribe}>
                        <input type="hidden" name="contentItemId" value={item.id} />
                        <input type="hidden" name="mediaAssetId" value={asset.id} />
                        <Button>Transcribe this take (local Whisper)</Button>
                      </form>
                      <form action={submitManualTranscript} className="flex flex-col gap-2">
                        <input type="hidden" name="contentItemId" value={item.id} />
                        <input type="hidden" name="mediaAssetId" value={asset.id} />
                        <textarea name="transcript" rows={3} defaultValue={asset.transcript ?? ""} className="field-input" placeholder="Paste or type what's said in this take" />
                        <div><Button>Save typed transcript</Button></div>
                      </form>
                    </div>
                  </details>
                </li>
              ))}
              {item.mediaAssets.length === 0 && <li className="text-[var(--color-text-faint)]">No media uploaded yet.</li>}
            </ul>
          </Panel>

          <Panel>
            <SectionHeading eyebrow="Distribution" title="Schedule" />
            <form action={submitSchedule} className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <input type="hidden" name="contentItemId" value={item.id} />
              <input
                type="date"
                name="scheduledDate"
                defaultValue={item.scheduleEntry ? item.scheduleEntry.scheduledDate.toISOString().slice(0, 10) : ""}
                className="field-input sm:w-auto"
              />
              <Button className="w-full sm:w-auto">{item.scheduleEntry ? "Update date" : "Add to calendar"}</Button>
            </form>
          </Panel>

          {!isTerminal && (
            <CollapsiblePanel eyebrow="Feedback" title="Taste Feedback & Second Opinion">
              <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
                Spec §7&apos;s Human Taste Model — Chris&apos;s real, raw feedback on any
                artifact here, plus an independent Adversarial Evaluator critique of the current
                script (requires ANTHROPIC_API_KEY, advisory only — never blocks anything).
              </p>
              <form action={submitTasteFeedback} className="flex flex-col gap-3">
                <input type="hidden" name="contentItemId" value={item.id} />
                <label className="block">
                  <span className="field-label">Artifact type</span>
                  <select name="artifactType" className="field-input" defaultValue="SCRIPT">
                    <option value="SCRIPT">Script</option>
                    <option value="EDIT_PLAN">Edit Plan</option>
                    <option value="PLATFORM_PACKAGE">Platform Package</option>
                  </select>
                </label>
                <label className="block">
                  <span className="field-label">Your feedback, in your own words</span>
                  <input
                    type="text"
                    name="rawFeedback"
                    placeholder="e.g. this transition is too corny"
                    required
                    className="field-input"
                  />
                </label>
                <label className="block">
                  <span className="field-label">Short tag</span>
                  <input type="text" name="normalizedTag" placeholder="e.g. too_corny" required className="field-input" />
                </label>
                <Button>Record feedback</Button>
              </form>
              <form action={runAdversarialEvaluator} className="mt-4">
                <input type="hidden" name="contentItemId" value={item.id} />
                <Button>Run Adversarial Evaluator on current script</Button>
              </form>
              {item.tasteFeedback.length > 0 && (
                <ul className="mt-4 flex flex-col gap-1.5 text-[13px]">
                  {item.tasteFeedback.map((f) => (
                    <li key={f.id}>
                      <Badge tone="violet">{f.normalizedTag}</Badge> ({f.artifactType}): &quot;{f.rawFeedback}&quot;
                    </li>
                  ))}
                </ul>
              )}
              {item.adversarialCritiques.length > 0 && (
                <div className="mt-4 flex flex-col gap-3">
                  {item.adversarialCritiques.map((c) => (
                    <div key={c.id} className="text-[13px]">
                      <span className="font-medium">{c.artifactType} critique: </span>
                      {c.noMaterialWeaknessesFound ? (
                        <span className="text-[var(--color-emerald-400)]">No material weaknesses found.</span>
                      ) : (
                        <ul className="mt-1.5 list-disc pl-5 text-[var(--color-text-muted)]">
                          {(c.concerns as { description: string; whyItMatters: string }[]).map((concern, i) => (
                            <li key={i}>
                              {concern.description} — {concern.whyItMatters}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CollapsiblePanel>
          )}

          {!isTerminal && (
            <CollapsiblePanel eyebrow="Danger zone" title="Cancel this item">
              <form action={cancelItem} className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <input type="hidden" name="contentItemId" value={item.id} />
                <input
                  type="text"
                  name="reason"
                  placeholder="Reason for cancelling"
                  required
                  className="field-input flex-1"
                />
                <Button tone="danger" pendingLabel="Cancelling…">Cancel this item</Button>
              </form>
            </CollapsiblePanel>
          )}

          <CollapsiblePanel eyebrow="Audit Trail" title="History">
            <ul className="flex flex-col gap-1.5 text-[13px] text-[var(--color-text-muted)]">
              {item.transitions.map((t) => (
                <li key={t.id}>
                  <span className="text-[var(--color-text)]">
                    {t.fromState} → {t.toState}
                  </span>
                  {t.reason ? ` — ${t.reason}` : ""} ({t.createdAt.toLocaleString()})
                </li>
              ))}
              {item.transitions.length === 0 && <li>No transitions yet.</li>}
            </ul>
          </CollapsiblePanel>
        </div>
        {sticky && <StickyActionBar label={sticky.label}>{sticky.node}</StickyActionBar>}
      </PageShell>
    </>
  );
}
