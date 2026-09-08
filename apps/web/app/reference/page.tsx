import Link from "next/link";
import { prisma, listReferenceCreators, countReferenceCreators } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel, SectionHeading, EmptyState, Button } from "../components/ui";
import { createCreator } from "./actions";

const LIMIT = 30;

// Reference Creator Intelligence — spec §8. "Principles transfer. Identity does not." See
// /prompts/agents/REFERENCE_INTELLIGENCE.md and /docs/ARCHITECTURE.md. Capped like every
// other list page — see /docs/DECISIONS.md's list-page bounding entry.
export default async function ReferencePage() {
  await requireSession();
  const creators = await listReferenceCreators(prisma, { limit: LIMIT });
  const total = await countReferenceCreators(prisma);

  return (
    <>
      <NavBar />
      <PageShell maxWidth={720}>
        <PageHeader
          eyebrow="Intelligence"
          title="Reference Creators"
          description={
            (total > LIMIT ? `Showing ${LIMIT} of ${total} total. ` : "") +
            "Supplemental evidence, never brand authority — see the evidence hierarchy in /docs/ARCHITECTURE.md."
          }
        />

        <Panel className="mb-5">
          <SectionHeading eyebrow="New" title="Add a creator" />
          <form action={createCreator} className="flex flex-col gap-4">
            <label className="block">
              <span className="field-label">Name</span>
              <input name="name" required className="field-input" />
            </label>
            <label className="block">
              <span className="field-label">Brand positioning</span>
              <input name="brandPositioning" required className="field-input" />
            </label>
            <label className="block">
              <span className="field-label">Platforms (one per line)</span>
              <textarea name="platforms" rows={2} className="field-input" />
            </label>
            <label className="block">
              <span className="field-label">Formats (one per line)</span>
              <textarea name="formats" rows={2} className="field-input" />
            </label>
            <label className="block">
              <span className="field-label">Hook archetypes (one per line)</span>
              <textarea name="hookArchetypes" rows={2} className="field-input" />
            </label>
            <label className="block">
              <span className="field-label">Relevance to Chris</span>
              <textarea name="relevanceToChris" rows={2} className="field-input" />
            </label>
            <label className="block">
              <span className="field-label">Do NOT transfer</span>
              <textarea name="doNotTransfer" rows={2} className="field-input" />
            </label>
            <label className="block">
              <span className="field-label">Source provenance</span>
              <input name="sourceProvenance" className="field-input" />
            </label>
            <Button tone="primary">Add creator</Button>
          </form>
        </Panel>

        <Panel padding="p-0">
          {creators.length === 0 ? (
            <div className="p-6">
              <EmptyState>No reference creators yet.</EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {creators.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/reference/${c.id}`}
                    className="flex flex-col gap-0.5 px-5 py-3.5 transition-colors hover:bg-white/[0.03]"
                  >
                    <span className="text-sm font-medium">{c.name}</span>
                    <span className="text-xs text-[var(--color-text-muted)]">{c.brandPositioning}</span>
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
