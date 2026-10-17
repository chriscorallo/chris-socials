import Link from "next/link";
import {
  prisma,
  listContentItems,
  countContentItems,
  CONTENT_STAGES,
  NEXT_STEP,
  type ContentStageKey,
} from "@chris/domain";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel, Badge, Button, EmptyState, StickyActionBar, contentStateTone, stateLabel } from "../components/ui";
import { runAutopilotBatch } from "./actions";
import { RevealActiveChip } from "../components/RevealActiveChip";
import { AUTOPILOT_JOB_KIND } from "../../lib/content-steps";

const LIMIT = 100;

// Grouped by production stage (Planning / Research & Script / To Film / Editing / Ready /
// Live / Done) so the list doubles as a to-do list at ~30 videos a week: each row shows the
// next step and whether it's waiting on Chris ("You") or can run without him. Capped at LIMIT
// per stage with the real total shown — never an unbounded render.
export default async function ContentListPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string; batch?: string }>;
}) {
  await requireSession();
  const { stage: stageParam, batch } = await searchParams;

  const counts: Record<string, number> = {};
  for (const stage of CONTENT_STAGES) {
    counts[stage.key] = await countContentItems(prisma, { state: [...stage.states] });
  }
  const activeKey: ContentStageKey =
    (CONTENT_STAGES.find((s) => s.key === stageParam)?.key as ContentStageKey | undefined) ??
    (CONTENT_STAGES.find((s) => s.key !== "done" && (counts[s.key] ?? 0) > 0)?.key as ContentStageKey | undefined) ??
    "plan";
  const active = CONTENT_STAGES.find((s) => s.key === activeKey)!;
  const items = await listContentItems(prisma, { state: [...active.states], limit: LIMIT });
  const total = counts[activeKey] ?? 0;
  const lastBatch = await prisma.jobRun.findFirst({ where: { kind: AUTOPILOT_JOB_KIND }, orderBy: { startedAt: "desc" } });
  const batchItems =
    (lastBatch?.summary as { items?: { contentItemId: string; title: string; finalState: string; stoppedBecause: string }[] } | null)?.items ?? [];
  const canAutopilot = activeKey !== "done" && activeKey !== "live";

  return (
    <>
      <NavBar />
      <PageShell>
        <PageHeader eyebrow="Production" title="Content" description="Every video by stage. “You” marks the ones waiting on you." />

        {/* Stage tabs: one swipeable row on phones (no wrapping into a wall of chips). */}
        <nav
          id="stage-tabs"
          className="scroll-row relative mb-4 flex gap-2 py-0.5 sm:flex-wrap"
          aria-label="Stages"
          style={{ marginLeft: "calc(-1 * var(--gutter))", marginRight: "calc(-1 * var(--gutter))", paddingLeft: "var(--gutter)", paddingRight: "var(--gutter)" }}
        >
          {CONTENT_STAGES.map((s) => {
            const on = s.key === activeKey;
            return (
              <Link
                key={s.key}
                href={`/content?stage=${s.key}`}
                className={`flex min-h-[40px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-4 text-[14px] font-medium transition-colors active:opacity-70 sm:min-h-[36px] sm:text-[13px] ${
                  on
                    ? "border-[var(--color-gold-500)]/50 bg-[var(--color-gold-500)]/15 text-[var(--color-gold-400)]"
                    : "border-[var(--color-border)] bg-white/[0.04] text-[var(--color-text-muted)]"
                }`}
                aria-current={on ? "page" : undefined}
              >
                {s.label}
                <span className={`text-[12px] tabular-nums ${on ? "opacity-90" : "opacity-60"}`}>{counts[s.key] ?? 0}</span>
              </Link>
            );
          })}
        </nav>

        <RevealActiveChip containerId="stage-tabs" />

        {(batch || lastBatch) && (
          <Panel className="mb-4">
            <p className="text-[15px] sm:text-sm">
              <span className="font-medium">Autopilot batch: </span>
              {lastBatch?.status === "RUNNING" || (batch && !lastBatch)
                ? `running on ${batch ?? "the selected"} item(s) in the background — refresh to see progress.`
                : `${lastBatch?.status.toLowerCase()} ${lastBatch?.finishedAt ? `at ${lastBatch.finishedAt.toLocaleString()}` : ""}`}
            </p>
            {batchItems.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1.5 text-[14px] text-[var(--color-text-muted)] sm:text-[13px]">
                {batchItems.map((b) => (
                  <li key={b.contentItemId}>
                    <Link href={`/content/${b.contentItemId}`} className="link-quiet underline">{b.title}</Link> → {b.finalState}: {b.stoppedBecause}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        <form action={runAutopilotBatch}>
          <input type="hidden" name="stage" value={activeKey} />
          <Panel padding="p-0">
            {items.length === 0 ? (
              <div className="p-5 sm:p-6">
                <EmptyState>Nothing in {active.label.toLowerCase()} right now.</EmptyState>
              </div>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {items.map((item) => {
                  const next = NEXT_STEP[item.currentState];
                  return (
                    <li key={item.id} className="flex items-stretch">
                      {canAutopilot && (
                        // The whole 48px-wide column is the checkbox's hit area, not just the box.
                        <label className="flex w-12 shrink-0 cursor-pointer items-center justify-center pl-1 sm:w-14">
                          <input
                            type="checkbox"
                            name="contentItemId"
                            value={item.id}
                            defaultChecked={next.owner === "SYSTEM"}
                            aria-label={`Include ${item.title} in Autopilot`}
                          />
                        </label>
                      )}
                      <Link
                        href={`/content/${item.id}`}
                        className={`flex min-h-[64px] min-w-0 flex-1 items-center gap-3 py-3 pr-3 transition-colors hover:bg-white/[0.03] active:bg-white/[0.05] sm:pr-5 ${canAutopilot ? "" : "pl-4 sm:pl-5"}`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 text-[15px] font-medium leading-snug sm:text-sm">{item.title}</p>
                          <p className="mt-1 text-[13px] text-[var(--color-text-faint)] sm:text-xs">
                            {next.owner === "YOU" && <span className="mr-1.5 font-semibold text-[var(--color-gold-400)]">You ·</span>}
                            {next.label}
                            {item.pillar ? ` · ${item.pillar.charAt(0)}${item.pillar.slice(1).toLowerCase()}` : ""}
                          </p>
                          <div className="mt-1.5 sm:hidden">
                            <Badge tone={contentStateTone(item.currentState)}>{stateLabel(item.currentState)}</Badge>
                          </div>
                        </div>
                        <span className="hidden shrink-0 sm:inline-flex">
                          <Badge tone={contentStateTone(item.currentState)}>{stateLabel(item.currentState)}</Badge>
                        </span>
                        <svg width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="shrink-0 text-[var(--color-text-faint)]" aria-hidden>
                          <path d="m1 1 6 6-6 6" />
                        </svg>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
          {canAutopilot && items.length > 0 && (
            <>
              <div className="mt-3 hidden items-center gap-3 lg:flex">
                <Button tone="primary" pendingLabel="Starting…">Run Autopilot on checked</Button>
                <span className="text-[12px] text-[var(--color-text-faint)]">
                  Runs in the background, one at a time; each stops when it needs you. Never schedules or publishes.
                </span>
              </div>
              <p className="mt-3 text-[13px] text-[var(--color-text-faint)] lg:hidden">
                Autopilot runs checked items in the background, one at a time; each stops when it needs you. Never schedules or publishes.
              </p>
              <StickyActionBar eyebrow="Autopilot" label="Run every checked video">
                <Button tone="primary" pendingLabel="Starting…">Run</Button>
              </StickyActionBar>
            </>
          )}
        </form>
        {total > LIMIT && (
          <p className="mt-3 text-[13px] text-[var(--color-text-faint)]">
            Showing the {LIMIT} most recent of {total} in this stage.
          </p>
        )}
      </PageShell>
    </>
  );
}
