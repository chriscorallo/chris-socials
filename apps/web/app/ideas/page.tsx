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
              <input name="title" required className="field-input" />
            </label>
            <label className="block">
              <span className="field-label">Description</span>
              <textarea name="description" rows={2} className="field-input" />
            </label>
            <div className="grid grid-cols-2 gap-4">
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
                <input name="format" className="field-input" />
              </label>
            </div>
            <Button tone="primary">Add idea</Button>
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
                    className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-white/[0.03]"
                  >
                    <span className="text-sm font-medium">{idea.title}</span>
                    {idea.pillar && <Badge tone="violet">{idea.pillar}</Badge>}
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
