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
import { PageShell, PageHeader, Panel, Badge, Button, EmptyState, contentStateTone } from "../components/ui";
import { runAutopilotBatch } from "./actions";
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

        <nav className="mb-4 flex flex-wrap gap-2" aria-label="Stages">
          {CONTENT_STAGES.map((s) => (
            <Link
              key={s.key}
              href={`/content?stage=${s.key}`}
              className={`badge ${s.key === activeKey ? "badge-gold" : "badge-neutral"} !px-3 !py-1.5`}
              aria-current={s.key === activeKey ? "page" : undefined}
            >
              {s.label} <span className="ml-1 opacity-70">{counts[s.key] ?? 0}</span>
            </Link>
          ))}
        </nav>

        {(batch || lastBatch) && (
          <Panel className="mb-4">
            <p className="text-sm">
              <span className="font-medium">Autopilot batch: </span>
              {lastBatch?.status === "RUNNING" || (batch && !lastBatch)
                ? `running on ${batch ?? "the selected"} item(s) in the background — refresh to see progress.`
                : `${lastBatch?.status.toLowerCase()} ${lastBatch?.finishedAt ? `at ${lastBatch.finishedAt.toLocaleString()}` : ""}`}
            </p>
            {batchItems.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1 text-[13px] text-[var(--color-text-muted)]">
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
            <div className="p-6">
              <EmptyState>Nothing in {active.label.toLowerCase()} right now.</EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {items.map((item) => {
                const next = NEXT_STEP[item.currentState];
                return (
                  <li key={item.id} className="flex items-center gap-3 pl-5">
                    {canAutopilot && (
                      <input
                        type="checkbox"
                        name="contentItemId"
                        value={item.id}
                        defaultChecked={next.owner === "SYSTEM"}
                        aria-label={`Include ${item.title} in Autopilot`}
                      />
                    )}
                    <Link
                      href={`/content/${item.id}`}
                      className="flex min-w-0 flex-1 items-center justify-between gap-4 py-3.5 pr-5 transition-colors hover:bg-white/[0.03]"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{item.title}</p>
                        <p className="mt-0.5 text-xs text-[var(--color-text-faint)]">
                          {next.owner === "YOU" && <span className="mr-1.5 font-medium text-[var(--color-gold-400)]">You ·</span>}
                          {next.label}
                          {item.pillar ? ` · ${item.pillar}` : ""}
                        </p>
                      </div>
                      <Badge tone={contentStateTone(item.currentState)}>{item.currentState}</Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        {canAutopilot && items.length > 0 && (
          <div className="mt-3 flex items-center gap-3">
            <Button tone="primary">Run Autopilot on checked</Button>
            <span className="text-[12px] text-[var(--color-text-faint)]">
              Runs in the background, one at a time; each stops when it needs you. Never schedules or publishes.
            </span>
          </div>
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
