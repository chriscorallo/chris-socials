import { notFound } from "next/navigation";
import { prisma, getContentItem, listValidNextStates } from "@chris/domain";
import { requireSession } from "../../../lib/session";
import { NavBar } from "../../components/NavBar";
import { PageShell, Panel, SectionHeading, Badge, Button, contentStateTone } from "../../components/ui";
import {
  selectForWeek,
  advanceStub,
  cancelItem,
  submitContract,
  submitCreatorCard,
  uploadMedia,
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
} from "./actions";

export default async function ContentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pipelineError?: string }>;
}) {
  await requireSession();
  const { id } = await params;
  const { pipelineError } = await searchParams;
  const item = await getContentItem(prisma, id);
  if (!item) notFound();

  const isTerminal = item.currentState === "ARCHIVED" || item.currentState === "CANCELLED";
  const nextStates = listValidNextStates(item.currentState).filter((s) => s !== "CANCELLED");
  // States with a dedicated form below instead of a bare "advance" button.
  const hasSpecialForm =
    item.currentState === "IDEA" ||
    item.currentState === "SELECTED" ||
    item.currentState === "SCRIPTED";
  const latestResearch = item.researchPackets[0];
  const latestScript = item.scriptVersions[0];
  const latestTakeSelection = item.takeSelections[0];
  const latestEditPlan = item.editPlans[0];
  const latestRender = item.renders[0];
  const latestQCReport = item.qcReports[0];
  const ALL_PLATFORMS = ["INSTAGRAM", "TIKTOK", "YOUTUBE"] as const;
  const packagedPlatforms = new Set(item.platformPackages.map((p) => p.platform));

  return (
    <>
      <NavBar />
      <PageShell maxWidth={760}>
        <header className="mb-6">
          <p className="eyebrow mb-1">Content Item</p>
          <h1 className="text-2xl font-semibold tracking-tight">{item.title}</h1>
          {item.description && <p className="mt-2 text-sm text-[var(--color-text-muted)]">{item.description}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
            <Badge tone={contentStateTone(item.currentState)}>{item.currentState}</Badge>
            {item.pillar && <span>{item.pillar}</span>}
            {item.format && <span>· {item.format}</span>}
          </div>
        </header>

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
                <span className="text-[13px] text-[var(--color-text-faint)]">
                  or advance manually in the Advance section below (stub)
                </span>
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

          {item.currentState === "TAKE_SELECTED" && (
            <Panel className="panel-action">
              <SectionHeading eyebrow="Next Step" title="Edit Planner" />
              <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
                Produces a deterministic EditPlan (cuts, framing, text overlays) for the
                selected take. Requires ANTHROPIC_API_KEY.
              </p>
              <form action={runEditPlanner}>
                <input type="hidden" name="contentItemId" value={item.id} />
                <Button tone="primary">Run Edit Planner</Button>
              </form>
            </Panel>
          )}

          {(item.currentState === "EDIT_PLANNED" ||
            item.currentState === "EDITING" ||
            item.currentState === "QC_REPAIR") && (
            <Panel className="panel-action">
              <SectionHeading eyebrow="Next Step" title="Render" />
              <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
                Real deterministic ffmpeg render + technical QC — no API key needed, this step
                isn&apos;t an LLM call. A QC failure automatically loops back for another
                attempt, up to a repair-iteration limit.
              </p>
              <form action={runRender}>
                <input type="hidden" name="contentItemId" value={item.id} />
                <Button tone="primary">{item.currentState === "EDIT_PLANNED" ? "Start render" : "Render again"}</Button>
              </form>
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
              <div className="flex flex-wrap gap-2">
                {ALL_PLATFORMS.map((platform) => (
                  <form action={runPlatformPackaging} key={platform}>
                    <input type="hidden" name="contentItemId" value={item.id} />
                    <input type="hidden" name="platform" value={platform} />
                    <Button>
                      {packagedPlatforms.has(platform) ? "Re-package" : "Package"} {platform}
                    </Button>
                  </form>
                ))}
              </div>
            </Panel>
          )}

          {item.currentState === "READY" && (
            <Panel className="panel-action">
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
                <div className="mt-3 flex flex-wrap gap-4 text-[13px]">
                  {ALL_PLATFORMS.map((platform) => (
                    <label key={platform} className="flex items-center gap-1.5">
                      <input type="checkbox" name="targetPlatforms" value={platform} /> {platform}
                    </label>
                  ))}
                </div>
                <Button tone="primary">Schedule</Button>
                <span className="ml-3" />
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
              <div className="flex flex-wrap gap-2">
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
              <form action={submitContract} className="flex flex-col gap-4">
                <SectionHeading eyebrow="Next Step" title="Production Contract" />
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
                <Button tone="primary">Issue contract &amp; move to CONTRACTED</Button>
              </form>
            </Panel>
          )}

          {item.currentState === "SCRIPTED" && (
            <Panel className="panel-action">
              <form action={submitCreatorCard} className="flex flex-col gap-4">
                <SectionHeading eyebrow="Next Step" title="Creator Card" />
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
                <Button tone="primary">Issue Creator Card &amp; move to READY_TO_FILM</Button>
              </form>
            </Panel>
          )}

          {!hasSpecialForm && !isTerminal && nextStates.length > 0 && (
            <Panel className="panel-action">
              <SectionHeading eyebrow="Next Step" title="Advance" />
              <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
                Manual stub — a later phase automates this transition.
              </p>
              <div className="flex flex-wrap gap-2">
                {nextStates.map((s) => (
                  <form key={s} action={advanceStub}>
                    <input type="hidden" name="contentItemId" value={item.id} />
                    <input type="hidden" name="to" value={s} />
                    <Button>→ {s}</Button>
                  </form>
                ))}
              </div>
            </Panel>
          )}

          {item.productionContract && (
            <Panel>
              <SectionHeading eyebrow="Contracted" title="Production Contract" />
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
            </Panel>
          )}

          {latestResearch && (
            <Panel>
              <SectionHeading eyebrow="Research" title="Research Packet" />
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
            </Panel>
          )}

          {latestScript && (
            <Panel>
              <SectionHeading eyebrow="Script" title="Latest Draft" />
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{latestScript.spokenScript}</p>
              <p className="mt-2 text-[13px] text-[var(--color-text-muted)]">
                Target: {latestScript.targetRuntimeSeconds}s · Estimated speaking:{" "}
                {latestScript.estimatedSpeakingRuntimeSeconds}s
              </p>
              {latestScript.brandGuardianReport != null && (
                <p className="mt-1.5 text-[13px]">
                  <span className="font-medium">Brand Guardian score: </span>
                  {(latestScript.brandGuardianReport as { brandScore?: number }).brandScore ?? "n/a"}/100
                </p>
              )}
            </Panel>
          )}

          {latestTakeSelection && (
            <Panel>
              <SectionHeading eyebrow="Production" title="Take Selection" />
              <p className="mb-2 text-[13px] text-[var(--color-text-muted)]">
                Confidence: {latestTakeSelection.confidence}
              </p>
              <p className="text-sm">{latestTakeSelection.reason}</p>
            </Panel>
          )}

          {latestEditPlan && (
            <Panel>
              <SectionHeading eyebrow="Production" title="Edit Plan" />
              <p className="mb-2 text-[13px] text-[var(--color-text-muted)]">
                Tier: {latestEditPlan.productionTier} · Target: {latestEditPlan.targetDurationSeconds}s
                {latestEditPlan.doNothingElse ? " · restraint: DO NOTHING ELSE" : ""}
              </p>
              <p className="text-sm">{(latestEditPlan.plan as { rationale?: string }).rationale}</p>
            </Panel>
          )}

          {latestRender && (
            <Panel>
              <SectionHeading eyebrow="Production" title={`Render (attempt ${latestRender.attempt})`} />
              <p className="mb-2 text-[13px] text-[var(--color-text-muted)]">
                Status: <Badge tone={latestRender.status === "SUCCESS" ? "emerald" : latestRender.status === "FAILED" ? "rose" : "neutral"}>{latestRender.status}</Badge>
                {latestRender.width && latestRender.height ? ` · ${latestRender.width}x${latestRender.height}` : ""}
                {latestRender.durationSeconds ? ` · ${latestRender.durationSeconds.toFixed(1)}s` : ""}
              </p>
              {latestRender.technicalQCReport != null && (
                <p className="text-[13px]">
                  <span className="font-medium">Technical QC: </span>
                  {(latestRender.technicalQCReport as { overall?: string }).overall ?? "unknown"}
                </p>
              )}
              {latestRender.storageKey && (
                <p className="mt-1.5 text-[13px]">
                  <a href={`/api/media/${latestRender.storageKey}`} className="link-quiet underline">
                    View rendered output
                  </a>
                </p>
              )}
              {latestRender.errorMessage && (
                <p className="mt-1.5 text-[13px] text-[var(--color-rose-400)]">{latestRender.errorMessage}</p>
              )}
            </Panel>
          )}

          {latestQCReport && (
            <Panel>
              <SectionHeading eyebrow="Quality" title="Quality Gate" />
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
            </Panel>
          )}

          {item.platformPackages.length > 0 && (
            <Panel>
              <SectionHeading eyebrow="Distribution" title="Platform Packages" />
              <div className="flex flex-col gap-3">
                {ALL_PLATFORMS.filter((p) => packagedPlatforms.has(p)).map((platform) => {
                  const pkg = item.platformPackages.find((p) => p.platform === platform)!;
                  return (
                    <div key={platform} className="border-t border-[var(--color-border)] pt-3 first:border-0 first:pt-0">
                      <p className="text-[13px]">
                        <span className="font-medium">{platform}</span>
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
            </Panel>
          )}

          {item.publications.length > 0 && (
            <Panel>
              <SectionHeading eyebrow="Distribution" title="Publications" />
              <div className="flex flex-col gap-2">
                {ALL_PLATFORMS.filter((p) => item.publications.some((pub) => pub.platform === p)).map((platform) => {
                  const latest = item.publications.find((p) => p.platform === platform)!;
                  return (
                    <p key={platform} className="text-[13px]">
                      <span className="font-medium">{platform}</span> (attempt {latest.attempt}):{" "}
                      <Badge tone={latest.status === "SUCCESS" ? "emerald" : latest.status === "DRAFT" ? "gold" : "rose"}>
                        {latest.status}
                      </Badge>
                      {latest.url && (
                        <>
                          {" — "}
                          <a href={latest.url} className="link-quiet underline">
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
            </Panel>
          )}

          {item.performanceSnapshots.length > 0 && (
            <Panel>
              <SectionHeading eyebrow="Learning" title="Performance Snapshots" />
              <p className="mb-3 text-[13px] text-[var(--color-text-muted)]">
                Absent metrics mean the platform genuinely doesn&apos;t return them — never
                fabricated.
              </p>
              <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
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
            </Panel>
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
                <Panel>
                  <SectionHeading eyebrow="Learning" title="Performance Evaluation" />
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
                </Panel>
              );
            })()}

          {item.comments.length > 0 && (
            <Panel>
              <SectionHeading eyebrow="Audience" title={`Comments (${item.comments.length})`} />
              <ul className="flex flex-col gap-1.5 text-[13px]">
                {item.comments.slice(0, 20).map((c) => (
                  <li key={c.id}>
                    <Badge tone="neutral">{c.platform}</Badge>
                    {c.authorHandle ? ` ${c.authorHandle}` : ""}:{" "}
                    <span className="text-[var(--color-text-muted)]">{c.text}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {item.creatorCard && (
            <Panel>
              <SectionHeading eyebrow="Production" title="Creator Card" />
              <p className="text-sm font-medium">{item.creatorCard.hook}</p>
              <ul className="mt-2 list-disc pl-5 text-[13px] text-[var(--color-text-muted)]">
                {(item.creatorCard.talkingPoints as string[]).map((point, i) => (
                  <li key={i}>{point}</li>
                ))}
              </ul>
              <p className="mt-2 text-[13px] text-[var(--color-text-faint)]">Setup: {item.creatorCard.setup}</p>
            </Panel>
          )}

          <Panel>
            <SectionHeading eyebrow="Assets" title="Media" />
            <form action={uploadMedia} encType="multipart/form-data" className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="contentItemId" value={item.id} />
              <input
                type="file"
                name="file"
                required
                className="text-[13px] text-[var(--color-text-muted)] file:mr-3 file:rounded-full file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-[13px] file:text-[var(--color-text)]"
              />
              <Button>Upload raw take</Button>
            </form>
            <ul className="mt-3 flex flex-col gap-1.5 text-[13px]">
              {item.mediaAssets.map((asset) => (
                <li key={asset.id}>
                  <a href={`/api/media/${asset.storageKey}`} className="link-quiet underline">
                    {asset.originalFilename}
                  </a>{" "}
                  <span className="text-[var(--color-text-faint)]">({(asset.sizeBytes / 1024).toFixed(1)} KB)</span>
                </li>
              ))}
              {item.mediaAssets.length === 0 && <li className="text-[var(--color-text-faint)]">No media uploaded yet.</li>}
            </ul>
          </Panel>

          <Panel>
            <SectionHeading eyebrow="Distribution" title="Schedule" />
            <form action={submitSchedule} className="flex items-center gap-3">
              <input type="hidden" name="contentItemId" value={item.id} />
              <input
                type="date"
                name="scheduledDate"
                defaultValue={item.scheduleEntry ? item.scheduleEntry.scheduledDate.toISOString().slice(0, 10) : ""}
                className="field-input w-auto"
              />
              <Button>{item.scheduleEntry ? "Update date" : "Add to calendar"}</Button>
            </form>
          </Panel>

          {!isTerminal && (
            <Panel>
              <SectionHeading eyebrow="Feedback" title="Taste Feedback & Second Opinion" />
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
            </Panel>
          )}

          {!isTerminal && (
            <Panel>
              <form action={cancelItem} className="flex items-center gap-3">
                <input type="hidden" name="contentItemId" value={item.id} />
                <input
                  type="text"
                  name="reason"
                  placeholder="Reason for cancelling"
                  required
                  className="field-input flex-1"
                />
                <Button tone="danger">Cancel this item</Button>
              </form>
            </Panel>
          )}

          <Panel>
            <SectionHeading eyebrow="Audit Trail" title="History" />
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
          </Panel>
        </div>
      </PageShell>
    </>
  );
}
