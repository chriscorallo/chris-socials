import Link from "next/link";
import { prisma, listContentItems, countContentItems } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel, SectionHeading, Badge, EmptyState, Button } from "../components/ui";
import { createIdea } from "./actions";

const LIMIT = 40;

// IDEAS nav — ContentItems in state IDEA. There is no separate ContentIdea table; see
// /docs/DECISIONS.md ("Phase 1: no separate ContentIdea table"). Capped like Content/Calendar
// — see /docs/DECISIONS.md's list-page bounding entry.
export default async function IdeasPage() {
  await requireSession();
  const ideas = await listContentItems(prisma, { state: "IDEA", limit: LIMIT });
  const total = await countContentItems(prisma, { state: "IDEA" });

  return (
    <>
      <NavBar />
      <PageShell maxWidth={720}>
        <PageHeader
          eyebrow="Intelligence"
          title="Ideas"
          description={total > LIMIT ? `Showing the ${LIMIT} most recent of ${total} total.` : undefined}
        />

        <Panel className="mb-5">
          <SectionHeading eyebrow="New" title="Add an idea" />
          <form action={createIdea} className="flex flex-col gap-4">
            <label className="block">
              <span className="field-label">Title</span>
              <input name="title" required autoComplete="off" enterKeyHint="next" className="field-input" placeholder="What's the video?" />
            </label>
            <label className="block">
              <span className="field-label">Description</span>
              <textarea name="description" rows={2} className="field-input" />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="field-label">Pillar</span>
                <select name="pillar" defaultValue="" className="field-input">
                  <option value="">(none yet)</option>
                  <option value="SKILL">Skill</option>
                  <option value="MINDSET">Mindset</option>
                  <option value="LIFESTYLE">Lifestyle</option>
                  <option value="PASSIONS">Passions</option>
                </select>
              </label>
              <label className="block">
                <span className="field-label">Format</span>
                <input name="format" autoComplete="off" className="field-input" placeholder="e.g. Talking head" />
              </label>
            </div>
            <Button tone="primary" className="w-full sm:w-auto sm:self-start" pendingLabel="Adding…">Add idea</Button>
          </form>
        </Panel>

        <Panel padding="p-0">
          {ideas.length === 0 ? (
            <div className="p-6">
              <EmptyState>No ideas yet.</EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {ideas.map((idea) => (
                <li key={idea.id}>
                  <Link
                    href={`/content/${idea.id}`}
                    className="flex min-h-[56px] items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03] active:bg-white/[0.05] sm:px-5"
                  >
                    <span className="min-w-0 text-[15px] font-medium leading-snug sm:text-sm">{idea.title}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {idea.pillar && <Badge tone="violet">{idea.pillar}</Badge>}
                      <svg width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="text-[var(--color-text-faint)]" aria-hidden>
                        <path d="m1 1 6 6-6 6" />
                      </svg>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </PageShell>
    </>
  );
}
