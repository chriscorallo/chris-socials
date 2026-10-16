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
import { PageShell, PageHeader, Panel, Badge, EmptyState, contentStateTone } from "../components/ui";

const LIMIT = 100;

// Grouped by production stage (Planning / Research & Script / To Film / Editing / Ready /
// Live / Done) so the list doubles as a to-do list at ~30 videos a week: each row shows the
// next step and whether it's waiting on Chris ("You") or can run without him. Capped at LIMIT
// per stage with the real total shown — never an unbounded render.
export default async function ContentListPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string }>;
}) {
  await requireSession();
  const { stage: stageParam } = await searchParams;

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
                  <li key={item.id}>
                    <Link
                      href={`/content/${item.id}`}
                      className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-white/[0.03]"
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
        {total > LIMIT && (
          <p className="mt-3 text-[13px] text-[var(--color-text-faint)]">
            Showing the {LIMIT} most recent of {total} in this stage.
          </p>
        )}
      </PageShell>
    </>
  );
}
