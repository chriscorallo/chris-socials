import { notFound } from "next/navigation";
import { prisma, getReferenceCreator, getReferenceContent } from "@chris/domain";
import { requireSession } from "../../../lib/session";
import { NavBar } from "../../components/NavBar";
import { PageShell, PageHeader, Panel, CollapsiblePanel, EmptyState, Button, BackLink } from "../../components/ui";
import { addContent, analyzeContent } from "./actions";

// Server Actions on this page run model calls / ffmpeg synchronously — allow up to the
// Vercel Fluid Compute ceiling instead of the platform default. See /docs/DECISIONS.md.
export const maxDuration = 300;

export default async function ReferenceCreatorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ analysisError?: string }>;
}) {
  await requireSession();
  const { id } = await params;
  const { analysisError } = await searchParams;
  const creator = await getReferenceCreator(prisma, id);
  if (!creator) notFound();

  // Sequential, not Promise.all — see /docs/DECISIONS.md.
  const contentWithObservations = [];
  for (const c of creator.content) {
    contentWithObservations.push(await getReferenceContent(prisma, c.id));
  }

  return (
    <>
      <NavBar />
      <PageShell maxWidth={760}>
        <BackLink href="/reference">Reference</BackLink>
        <PageHeader eyebrow="Reference Creator" title={creator.name} description={creator.brandPositioning} />

        {(creator.relevanceToChris || creator.doNotTransfer) && (
          <div className="mb-5 flex flex-col gap-2">
            {creator.relevanceToChris && (
              <p className="text-[14px] text-[var(--color-text-muted)] sm:text-[13px]">
                <span className="font-medium text-[var(--color-text)]">Relevance to Chris: </span>
                {creator.relevanceToChris}
              </p>
            )}
            {creator.doNotTransfer && (
              <p className="text-[14px] text-[var(--color-rose-400)] sm:text-[13px]">
                <span className="font-medium">Do NOT transfer: </span>
                {creator.doNotTransfer}
              </p>
            )}
          </div>
        )}

        {analysisError && (
          <Panel className="mb-5 !border-[var(--color-rose-500)]/40">
            <p className="text-sm text-[var(--color-rose-400)]">
              <span className="font-medium">Analysis error: </span>
              {analysisError}
            </p>
          </Panel>
        )}

        <CollapsiblePanel eyebrow="New" title="Add reference content" className="mb-5" defaultOpen={creator.content.length === 0}>
          <form action={addContent} className="flex flex-col gap-4">
            <input type="hidden" name="referenceCreatorId" value={creator.id} />
            <label className="block">
              <span className="field-label">Description / transcript / notes</span>
              <textarea name="description" required rows={4} className="field-input" />
            </label>
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="block">
                <span className="field-label">Platform</span>
                <select name="platform" defaultValue="" className="field-input">
                  <option value="">(unspecified)</option>
                  <option value="INSTAGRAM">Instagram</option>
                  <option value="TIKTOK">TikTok</option>
                  <option value="YOUTUBE">YouTube</option>
                </select>
              </label>
              <label className="block">
                <span className="field-label">Hook</span>
                <input name="hook" className="field-input" />
              </label>
              <label className="block">
                <span className="field-label">Topic</span>
                <input name="topic" className="field-input" />
              </label>
            </div>
            <Button tone="primary" className="w-full sm:w-auto sm:self-start" pendingLabel="Adding…">Add content</Button>
          </form>
        </CollapsiblePanel>

        <div className="flex flex-col gap-4">
          {contentWithObservations.map(
            (content) =>
              content && (
                <Panel key={content.id}>
                  <h2 className="text-[15px] font-semibold">{content.hook || content.topic || "Untitled content"}</h2>
                  <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--color-text-muted)]">
                    {content.description}
                  </p>

                  <form action={analyzeContent} className="mt-4">
                    <input type="hidden" name="referenceCreatorId" value={creator.id} />
                    <input type="hidden" name="referenceContentId" value={content.id} />
                    <Button className="w-full sm:w-auto" pendingLabel="Analyzing…">Run Reference Intelligence analysis</Button>
                  </form>

                  {content.observations.length > 0 && (
                    <ul className="mt-4 flex flex-col gap-3">
                      {content.observations.map((o) => (
                        <li
                          key={o.id}
                          className="rounded-lg border border-[var(--color-border)] bg-white/[0.03] p-3 text-[13px] leading-relaxed"
                        >
                          <p>
                            <span className="font-medium text-[var(--color-text)]">Observed: </span>
                            <span className="text-[var(--color-text-muted)]">{o.observed}</span>
                          </p>
                          <p className="mt-1.5">
                            <span className="font-medium text-[var(--color-text)]">Likely principle: </span>
                            <span className="text-[var(--color-text-muted)]">{o.likelyPrinciple}</span>
                          </p>
                          <p className="mt-1.5">
                            <span className="font-medium text-[var(--color-text)]">Transferability: </span>
                            <span className="text-[var(--color-text-muted)]">{o.transferabilityToChris}</span>
                          </p>
                          <p className="mt-1.5">
                            <span className="font-medium text-[var(--color-text)]">Test required: </span>
                            <span className="text-[var(--color-text-muted)]">{o.testRequired}</span>
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              ),
          )}
          {creator.content.length === 0 && (
            <Panel>
              <EmptyState>No reference content added yet.</EmptyState>
            </Panel>
          )}
        </div>
      </PageShell>
    </>
  );
}
