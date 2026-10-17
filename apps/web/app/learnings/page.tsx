import {
  prisma,
  listEvidenceEntries,
  countEvidenceEntries,
  listBeliefs,
  countBeliefs,
  listBrandEras,
  countBrandEras,
  listExperiments,
  countExperiments,
  listWeeklyBriefs,
  listTasteFeedback,
  countTasteFeedback,
  listAutonomyLevels,
  isEnabled,
  AUTONOMY_LEVEL_THRESHOLDS,
  AUTONOMY_SHADOW_ONLY_FLAG,
  getMotionTasteProfile,
} from "@chris/domain";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel, SectionHeading, CollapsiblePanel, Badge, Button } from "../components/ui";
import {
  submitManualEvidence,
  runLearningAgentAction,
  approveBeliefAction,
  rejectBeliefAction,
  submitBrandEra,
  submitExperiment,
  runExperimentAgentAction,
  startExperimentAction,
  concludeExperimentAction,
  runWeeklyReviewAction,
  refreshTasteModelAction,
  submitAutonomyCeiling,
  toggleShadowOnly,
  forgetMotionPreferenceAction,
} from "./actions";

// Server Actions on this page run model calls / ffmpeg synchronously — allow up to the
// Vercel Fluid Compute ceiling instead of the platform default. See /docs/DECISIONS.md.
export const maxDuration = 300;

export default async function LearningsPage({
  searchParams,
}: {
  searchParams: Promise<{ learningError?: string; tasteRefreshed?: string }>;
}) {
  await requireSession();
  const { learningError, tasteRefreshed } = await searchParams;

  // Every list below is capped at the query level (not fetched-then-sliced) — found by
  // actually loading this page against the dev DB, where uncapped lists made it genuinely
  // 17,772px tall. See /docs/DECISIONS.md's list-page bounding entry.
  const evidence = await listEvidenceEntries(prisma, { limit: 15 });
  const evidenceTotal = await countEvidenceEntries(prisma);
  // Capped tighter than the other lists on this page (10, not 15) — this specific list is a
  // review queue, not a reference list, so the "do not create approval fatigue" principle
  // (spec §20, already load-bearing for Home's NEEDS YOU queue) applies here too.
  const proposedBeliefs = await listBeliefs(prisma, { status: "PROPOSED", limit: 10 });
  const proposedBeliefsTotal = await countBeliefs(prisma, { status: "PROPOSED" });
  const acceptedBeliefs = await listBeliefs(prisma, { status: "ACCEPTED", limit: 15 });
  const acceptedBeliefsTotal = await countBeliefs(prisma, { status: "ACCEPTED" });
  const eras = await listBrandEras(prisma, { limit: 15 });
  const erasTotal = await countBrandEras(prisma);
  const experiments = await listExperiments(prisma, { limit: 15 });
  const experimentsTotal = await countExperiments(prisma);
  const briefs = await listWeeklyBriefs(prisma);
  const tasteFeedback = await listTasteFeedback(prisma, { limit: 15 });
  const tasteFeedbackTotal = await countTasteFeedback(prisma);
  const motionTaste = await getMotionTasteProfile(prisma).catch(() => null);
  const autonomyLevels = await listAutonomyLevels(prisma);
  const shadowOnly = await isEnabled(prisma, AUTONOMY_SHADOW_ONLY_FLAG);
  const SUBSYSTEMS = ["TAKE_SELECTION", "EDIT_PLANNING", "QUALITY_GATE", "SCHEDULING", "PUBLISHING"] as const;
  const TIERS = ["RAW", "FAST", "MEDIUM", "HERO"] as const;

  return (
    <>
      <NavBar />
      <PageShell maxWidth={800}>
        <PageHeader
          eyebrow="Adaptive Intelligence"
          title="Learnings"
          description="What the system has learned — evidence, beliefs, experiments, your taste, and how much autonomy each part has earned. Nothing is believed until you accept it."
        />

        {learningError && (
          <Panel className="mb-5 !border-[var(--color-rose-500)]/40">
            <p className="text-sm text-[var(--color-rose-400)]">{learningError}</p>
          </Panel>
        )}

        <div className="flex flex-col gap-4 sm:gap-5">
          {/* Evidence Ledger */}
          <CollapsiblePanel eyebrow="Evidence Ledger" title={evidenceTotal > 15 ? `${evidenceTotal} entries (showing 15)` : `${evidenceTotal} entries`} className="order-2">
            <ul className="mb-4 text-[14px] sm:max-h-48 sm:overflow-y-auto sm:text-[13px]">
              {evidence.map((e) => (
                <li key={e.id} className="border-b border-[var(--color-border)] py-2 last:border-0">
                  <Badge tone="neutral">{e.sourceType}</Badge>{" "}
                  <span className="text-[var(--color-text-faint)]">(confidence {e.confidence.toFixed(2)})</span>{" "}
                  {e.statement}
                </li>
              ))}
            </ul>
            <form action={submitManualEvidence} className="flex flex-col gap-3">
              <label className="block">
                <span className="field-label">Statement</span>
                <input type="text" name="statement" required autoComplete="off" className="field-input" />
              </label>
              <label className="block">
                <span className="field-label">Confidence (0-1)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  name="confidence"
                  min="0"
                  max="1"
                  step="0.05"
                  defaultValue="0.5"
                  className="field-input"
                />
              </label>
              <Button className="w-full sm:w-auto sm:self-start">Record manual evidence</Button>
            </form>
          </CollapsiblePanel>

          {/* Beliefs — the review queue, so it leads on every screen size. */}
          <Panel className="order-1">
            <SectionHeading eyebrow="Belief System" title="Beliefs" />
            <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
              Requires ANTHROPIC_API_KEY. A proposal is never auto-accepted — review and approve
              or reject each one below.
            </p>
            <form action={runLearningAgentAction}>
              <Button className="w-full sm:w-auto" pendingLabel="Proposing…">Run Learning Agent (propose from Evidence Ledger)</Button>
            </form>

            {proposedBeliefs.length > 0 && (
              <div className="mt-5">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-rose-400)]">
                  Needs your review ({proposedBeliefsTotal})
                </p>
                <div className="flex flex-col gap-3">
                  {proposedBeliefs.map((b) => (
                    <div key={b.id} className="rounded-xl border border-[var(--color-border)] bg-white/[0.03] p-4 text-[14px] sm:text-[13px]">
                      <p className="text-[15px] font-medium sm:text-[13px]">{b.statement}</p>
                      {b.causalClaim && (
                        <p className="mt-1 text-[var(--color-text-muted)]">Interpretation: {b.causalClaim}</p>
                      )}
                      <p className="mt-1 text-[var(--color-text-faint)]">
                        Confidence {b.confidence.toFixed(2)} · sample size {b.sampleSize} ·{" "}
                        {b.isExperimentalEvidence ? "experimental" : "retrospective/correlational"}
                      </p>
                      {(b.confounders as string[]).length > 0 && (
                        <p className="mt-1 text-[var(--color-text-faint)]">
                          Confounders: {(b.confounders as string[]).join("; ")}
                        </p>
                      )}
                      <div className="mt-3 grid grid-cols-2 gap-2 sm:flex">
                        <form action={approveBeliefAction}>
                          <input type="hidden" name="beliefId" value={b.id} />
                          <Button tone="primary" className="w-full">Accept</Button>
                        </form>
                        <form action={rejectBeliefAction}>
                          <input type="hidden" name="beliefId" value={b.id} />
                          <Button tone="danger" className="w-full">Reject</Button>
                        </form>
                      </div>
                    </div>
                  ))}
                </div>
                {proposedBeliefsTotal > proposedBeliefs.length && (
                  <p className="mt-3 text-xs text-[var(--color-text-faint)]">
                    +{proposedBeliefsTotal - proposedBeliefs.length} more proposed beliefs awaiting review,
                    not shown here.
                  </p>
                )}
              </div>
            )}

            {acceptedBeliefs.length > 0 && (
              <div className="mt-5">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-emerald-400)]">
                  Accepted ({acceptedBeliefsTotal})
                </p>
                <ul className="flex flex-col gap-1.5 text-[13px]">
                  {acceptedBeliefs.map((b) => (
                    <li key={b.id}>{b.statement}</li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>

          {/* Experiments */}
          <CollapsiblePanel
            eyebrow="Experiment Engine"
            title={experimentsTotal > 15 ? `Experiments (showing 15 of ${experimentsTotal})` : "Experiments"}
            className="order-3"
            defaultOpen={experiments.some((e) => e.status === "RUNNING" || e.status === "PROPOSED")}
          >
            <form action={runExperimentAgentAction}>
              <Button className="w-full sm:w-auto" pendingLabel="Proposing…">Run Experiment Agent (propose from current slate)</Button>
            </form>

            <details className="mt-4">
              <summary className="flex min-h-[44px] cursor-pointer items-center text-[14px] text-[var(--color-text-muted)] sm:text-[13px]">Create manually ›</summary>
              <form action={submitExperiment} className="mt-3 flex flex-col gap-3">
                <label className="block">
                  <span className="field-label">Hypothesis</span>
                  <input type="text" name="hypothesis" required className="field-input" />
                </label>
                <label className="block">
                  <span className="field-label">Confounders (one per line)</span>
                  <textarea name="confounders" rows={2} className="field-input" />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="field-label">Min sample size</span>
                    <input type="number" inputMode="numeric" name="minSampleSize" defaultValue="10" className="field-input" />
                  </label>
                  <label className="block">
                    <span className="field-label">Min duration (days)</span>
                    <input type="number" inputMode="numeric" name="minDurationDays" defaultValue="7" className="field-input" />
                  </label>
                </div>
                <label className="block">
                  <span className="field-label">Portfolio mapping</span>
                  <input
                    type="text"
                    name="portfolioMapping"
                    placeholder="exploit / adjacent / exploration"
                    className="field-input"
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="field-label">Variant A label</span>
                    <input type="text" name="variantALabel" className="field-input" />
                  </label>
                  <label className="block">
                    <span className="field-label">Variant A description</span>
                    <input type="text" name="variantADescription" className="field-input" />
                  </label>
                  <label className="block">
                    <span className="field-label">Variant B label</span>
                    <input type="text" name="variantBLabel" className="field-input" />
                  </label>
                  <label className="block">
                    <span className="field-label">Variant B description</span>
                    <input type="text" name="variantBDescription" className="field-input" />
                  </label>
                </div>
                <Button tone="primary" className="w-full sm:w-auto sm:self-start">Create experiment</Button>
              </form>
            </details>

            {experiments.length > 0 && (
              <div className="mt-5 flex flex-col gap-3">
                {experiments.map((e) => (
                  <div key={e.id} className="border-t border-[var(--color-border)] pt-3 text-[14px] sm:text-[13px]">
                    <p className="mb-1">
                      <Badge tone={e.status === "RUNNING" ? "gold" : e.status === "PROPOSED" ? "neutral" : "emerald"}>
                        {e.status}
                      </Badge>{" "}
                      <span className="font-medium">{e.hypothesis}</span>
                    </p>
                    {e.variants.length > 0 && (
                      <ul className="mb-1 list-disc pl-5 text-[var(--color-text-muted)]">
                        {e.variants.map((v) => (
                          <li key={v.id}>
                            {v.label}: {v.description}
                          </li>
                        ))}
                      </ul>
                    )}
                    {e.conclusion && <p className="mb-1 text-[var(--color-text-muted)]">{e.conclusion}</p>}
                    {e.status === "PROPOSED" && (
                      <form action={startExperimentAction}>
                        <input type="hidden" name="experimentId" value={e.id} />
                        <Button>Start</Button>
                      </form>
                    )}
                    {e.status === "RUNNING" && (
                      <form action={concludeExperimentAction} className="flex flex-col gap-2">
                        <input type="hidden" name="experimentId" value={e.id} />
                        <input type="text" name="conclusion" placeholder="Conclusion" required className="field-input" />
                        <div className="grid grid-cols-2 gap-2 text-[14px] sm:flex sm:gap-4 sm:text-[13px]">
                          <label className="flex min-h-[44px] items-center gap-2">
                            <input type="radio" name="status" value="CONCLUDED" defaultChecked /> Concluded
                          </label>
                          <label className="flex min-h-[44px] items-center gap-2">
                            <input type="radio" name="status" value="INCONCLUSIVE" /> Inconclusive
                          </label>
                        </div>
                        <Button className="w-full sm:w-auto sm:self-start">Submit</Button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CollapsiblePanel>

          {/* Brand Timeline */}
          <CollapsiblePanel
            eyebrow="Truth Layer"
            title={erasTotal > 15 ? `Brand Timeline (most recent 15 of ${erasTotal})` : "Brand Timeline"}
            className="order-5"
          >
            <ul className="mb-4 flex flex-col gap-2 text-[13px]">
              {eras.map((era) => (
                <li key={era.id}>
                  <span className="font-medium">{era.name}</span>{" "}
                  <span className="text-[var(--color-text-faint)]">
                    ({era.startDate.toISOString().slice(0, 10)}
                    {era.endDate ? ` – ${era.endDate.toISOString().slice(0, 10)}` : " – present"})
                  </span>
                  : <span className="text-[var(--color-text-muted)]">{era.description}</span>
                </li>
              ))}
            </ul>
            <form action={submitBrandEra} className="flex flex-col gap-3">
              <label className="block">
                <span className="field-label">Name</span>
                <input type="text" name="name" required className="field-input" />
              </label>
              <label className="block">
                <span className="field-label">Start date</span>
                <input type="date" name="startDate" required className="field-input" />
              </label>
              <label className="block">
                <span className="field-label">Description</span>
                <input type="text" name="description" required className="field-input" />
              </label>
              <Button className="w-full sm:w-auto sm:self-start">Add era</Button>
            </form>
          </CollapsiblePanel>

          {/* Weekly Brief */}
          <CollapsiblePanel eyebrow="Learning Council" title="Weekly Brief" className="order-4" defaultOpen={!!briefs[0]}>
            <form action={runWeeklyReviewAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="block sm:flex-1">
                <span className="field-label">Week start date</span>
                <input type="date" name="weekStartDate" required className="field-input" />
              </label>
              <Button tone="primary" className="w-full sm:w-auto" pendingLabel="Reviewing…">Run Weekly Review</Button>
            </form>
            {briefs[0] && (
              <div className="mt-4 text-[13px]">
                <p>
                  <span className="font-medium">{briefs[0].weekStartDate.toISOString().slice(0, 10)}</span>:{" "}
                  {briefs[0].whatHappened}
                </p>
                <p className="mt-1 text-[var(--color-text-muted)]">{briefs[0].whatItMeans}</p>
              </div>
            )}
          </CollapsiblePanel>

          {/* Taste Model */}
          <CollapsiblePanel eyebrow="Human Taste Model" title={tasteFeedbackTotal > 15 ? `${tasteFeedbackTotal} feedback instances (showing 15)` : `${tasteFeedbackTotal} feedback instances`} className="order-6">
            <ul className="text-[14px] sm:max-h-40 sm:overflow-y-auto sm:text-[13px]">
              {tasteFeedback.map((f) => (
                <li key={f.id} className="border-b border-[var(--color-border)] py-1.5 last:border-0">
                  <Badge tone="violet">{f.normalizedTag}</Badge>{" "}
                  <span className="text-[var(--color-text-muted)]">&quot;{f.rawFeedback}&quot;</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-[var(--color-text-faint)]">
              Recorded per artifact from each content item&apos;s own detail page.
            </p>
            <form action={refreshTasteModelAction} className="mt-3 flex flex-wrap items-center gap-3">
              <Button className="w-full sm:w-auto" pendingLabel="Refreshing…">Refresh taste model</Button>
              {tasteRefreshed && <span className="text-[13px] text-[var(--color-text-muted)]">{tasteRefreshed}</span>}
            </form>
          </CollapsiblePanel>

          {/* Your motion style — learned from editor saves (packages/domain motion-taste.ts). */}
          <CollapsiblePanel
            id="motion-style"
            eyebrow="Motion graphics"
            title="Your motion style"
            meta={motionTaste && motionTaste.preferences.length ? <Badge tone="violet">{motionTaste.preferences.length} learned</Badge> : undefined}
            className="order-6"
          >
            <p className="mb-3 text-[13px] text-[var(--color-text-muted)]">
              Learned from what you keep, edit and delete in the finishing editor. A preference is{" "}
              <strong>strong</strong> only after 3+ consistent edits across 2+ videos; anything less is a{" "}
              <strong>hint</strong> the Motion Designer won&apos;t treat as a rule. Recent edits count more.
            </p>
            {!motionTaste || motionTaste.preferences.length === 0 ? (
              <p className="text-[13px] text-[var(--color-text-faint)]">Nothing learned yet — edit a few AI-designed videos and it will show up here.</p>
            ) : (
              <ul className="text-[14px] sm:text-[13px]">
                {motionTaste.preferences.slice(0, 12).map((p) => (
                  <li key={p.key} className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] py-2 last:border-0">
                    <Badge tone={p.strength === "STRONG" ? "gold" : "neutral"}>{p.strength === "STRONG" ? "Strong" : "Hint"}</Badge>
                    <span className="min-w-0 flex-1">
                      {p.label}
                      {p.scope !== "ALL" ? <span className="text-[var(--color-text-faint)]"> · {p.scope.toLowerCase()} videos</span> : null}
                      <span className="block text-xs text-[var(--color-text-faint)]">
                        {p.evidenceCount} edit{p.evidenceCount === 1 ? "" : "s"} · {p.videoCount} video{p.videoCount === 1 ? "" : "s"} · confidence {Math.round(p.confidence * 100)}%
                      </span>
                    </span>
                    <form action={forgetMotionPreferenceAction}>
                      <input type="hidden" name="key" value={p.key} />
                      <input type="hidden" name="label" value={p.label} />
                      <Button className="min-h-[44px]" pendingLabel="Forgetting…">Forget this</Button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </CollapsiblePanel>

          {/* Autonomy */}
          <CollapsiblePanel
            eyebrow="Autonomy"
            title="Reliability & Trust"
            className="order-7"
            meta={<Badge tone={shadowOnly ? "rose" : "emerald"}>{shadowOnly ? "Shadow only" : "On where earned"}</Badge>}
          >
            <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
              Spec §23 — a subsystem only reaches a higher level after enough real,
              human-approved outcomes for that specific (subsystem, production tier) pair,
              never globally. Thresholds: L1={AUTONOMY_LEVEL_THRESHOLDS[1]}, L2=
              {AUTONOMY_LEVEL_THRESHOLDS[2]}, L3={AUTONOMY_LEVEL_THRESHOLDS[3]}, L4=
              {AUTONOMY_LEVEL_THRESHOLDS[4]} approved outcomes.
            </p>

            <form action={toggleShadowOnly} className="mb-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <input type="hidden" name="enabled" value={shadowOnly ? "false" : "true"} />
              <Badge tone={shadowOnly ? "rose" : "emerald"}>
                {shadowOnly ? "Shadow only — all autonomy disabled" : "Autonomy enabled where earned"}
              </Badge>
              <Button tone={shadowOnly ? "primary" : "danger"} className="w-full sm:w-auto">
                {shadowOnly ? "Turn autonomy on" : "Emergency stop: force shadow-only"}
              </Button>
            </form>

            {/* Phones: one card per subsystem, a row per tier — not a 6-column, 20-row table. */}
            <div className="flex flex-col gap-3 md:hidden">
              {SUBSYSTEMS.map((subsystem) => (
                <div key={subsystem} className="rounded-xl border border-[var(--color-border)] bg-white/[0.03]">
                  <p className="border-b border-[var(--color-border)] px-3 py-2.5 text-[13px] font-semibold">
                    {subsystem.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())}
                  </p>
                  <ul className="divide-y divide-[var(--color-border)]">
                    {TIERS.map((tier) => {
                      const row = autonomyLevels.find((a) => a.subsystem === subsystem && a.productionTier === tier);
                      return (
                        <li key={tier} className="flex items-center gap-3 px-3 py-2">
                          <div className="min-w-0 flex-1 text-[13px]">
                            <p className="font-medium">{tier.charAt(0) + tier.slice(1).toLowerCase()}</p>
                            <p className="text-[12px] text-[var(--color-text-faint)]">
                              Level {row?.level ?? 0} · {row?.approvedOutcomeCount ?? 0} approved
                            </p>
                          </div>
                          <form action={submitAutonomyCeiling} className="flex shrink-0 items-center gap-1.5">
                            <input type="hidden" name="subsystem" value={subsystem} />
                            <input type="hidden" name="productionTier" value={tier} />
                            <label className="sr-only" htmlFor={`ceil-m-${subsystem}-${tier}`}>Ceiling</label>
                            <select
                              id={`ceil-m-${subsystem}-${tier}`}
                              name="ceilingLevel"
                              defaultValue={String(row?.ceilingLevel ?? 4)}
                              className="field-input !w-[4.5rem] !py-1.5"
                              aria-label={`Ceiling for ${subsystem} ${tier}`}
                            >
                              {[0, 1, 2, 3, 4].map((n) => (
                                <option key={n} value={n}>
                                  L{n}
                                </option>
                              ))}
                            </select>
                            <Button className="!px-3.5 !text-[13px]" pendingLabel="…">Set</Button>
                          </form>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
            <div className="hidden overflow-x-auto rounded-lg border border-[var(--color-border)] md:block">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-faint)]">
                    <th className="px-3 py-2 font-medium">Subsystem</th>
                    <th className="px-3 py-2 font-medium">Tier</th>
                    <th className="px-3 py-2 font-medium">Level</th>
                    <th className="px-3 py-2 font-medium">Approved outcomes</th>
                    <th className="px-3 py-2 font-medium">Ceiling</th>
                    <th className="px-3 py-2 font-medium">Set ceiling</th>
                  </tr>
                </thead>
                <tbody>
                  {SUBSYSTEMS.flatMap((subsystem) =>
                    TIERS.map((tier) => {
                      const row = autonomyLevels.find((a) => a.subsystem === subsystem && a.productionTier === tier);
                      return (
                        <tr key={`${subsystem}-${tier}`} className="border-b border-[var(--color-border)] last:border-0">
                          <td className="px-3 py-2">{subsystem}</td>
                          <td className="px-3 py-2">{tier}</td>
                          <td className="px-3 py-2">{row?.level ?? 0}</td>
                          <td className="px-3 py-2">{row?.approvedOutcomeCount ?? 0}</td>
                          <td className="px-3 py-2">{row?.ceilingLevel ?? 4}</td>
                          <td className="px-3 py-2">
                            <form action={submitAutonomyCeiling} className="flex items-center gap-1.5">
                              <input type="hidden" name="subsystem" value={subsystem} />
                              <input type="hidden" name="productionTier" value={tier} />
                              <input
                                type="number"
                                name="ceilingLevel"
                                min="0"
                                max="4"
                                defaultValue={row?.ceilingLevel ?? 4}
                                className="field-input w-14 !px-2 !py-1"
                              />
                              <button type="submit" className="btn btn-ghost !px-2.5 !py-1 text-xs">
                                Set
                              </button>
                            </form>
                          </td>
                        </tr>
                      );
                    }),
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-[var(--color-text-faint)]">
              HERO&apos;s ceiling stays low by default policy — set it to 0 or 1 to require
              permanent human review regardless of how many outcomes accumulate.
            </p>
          </CollapsiblePanel>
        </div>
      </PageShell>
    </>
  );
}
