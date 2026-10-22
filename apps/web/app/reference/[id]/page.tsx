import { notFound } from "next/navigation";
import {
  prisma,
  getReferenceCreator,
  getReferenceContent,
  listReferenceVideos,
  getReferenceStyleProfile,
  getStyleModel,
  getActiveHeavyJob,
  creatorStyleGroup,
  listReferenceCreators,
  REFERENCE_METRICS_VERSION,
} from "@chris/domain";
import { REFERENCE_LIBRARY_SUBJECT } from "@chris/worker/heavy-job-kinds";
import { requireSession } from "../../../lib/session";
import { NavBar } from "../../components/NavBar";
import { PageShell, PageHeader, Panel, CollapsiblePanel, Button, BackLink, ButtonLink } from "../../components/ui";
import { addContent, analyzeContent } from "./actions";
import { setCreatorStyleGroup } from "../actions";
import { StyleCard, StyleModelCard } from "../StyleCards";
import { MeasureControl } from "../MeasureProgress";
import { VideoCard } from "./VideoCard";
import { getViewerChecksForReferences } from "../../../lib/viewer-check";
import type { ViewerCheckData } from "../../../lib/viewer-check-view";

// Server Actions on this page run model calls synchronously (the optional notes analysis) —
// allow up to the Vercel Fluid Compute ceiling. See /docs/DECISIONS.md.
export const maxDuration = 300;

export default async function ReferenceCreatorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ analysisError?: string; linkError?: string }>;
}) {
  await requireSession();
  const { id } = await params;
  const { analysisError, linkError } = await searchParams;
  const creator = await getReferenceCreator(prisma, id);
  if (!creator) notFound();

  // Sequential, not Promise.all — see /docs/DECISIONS.md.
  const videos = await listReferenceVideos(prisma, id);
  const allCreators = (await listReferenceCreators(prisma, { limit: 200 })).map((c) => ({ id: c.id, name: c.name }));
  const profile = await getReferenceStyleProfile(prisma, { referenceCreatorId: id });
  const model = await getStyleModel(prisma, { referenceCreatorId: id, includeMine: false });
  const active = await getActiveHeavyJob(prisma, REFERENCE_LIBRARY_SUBJECT);
  const videoIds = new Set(videos.map((v) => v.id));
  const notes = [];
  for (const c of creator.content) if (!videoIds.has(c.id)) notes.push(await getReferenceContent(prisma, c.id));
  const pending = videos.filter((v) => v.analysisStatus === "PENDING" && v.mediaStorageKey).length;
  const failed = videos.filter((v) => v.analysisStatus === "FAILED" && v.mediaStorageKey).length;
  const outdated = videos.filter((v) => v.analysisStatus === "DONE" && v.mediaStorageKey && (v.metricsVersion ?? 0) < REFERENCE_METRICS_VERSION).length;
  const back = `/reference/${id}`;
  // "What a viewer thinks" per video (Viewer Panel; AI status read once).
  const viewerChecks = await getViewerChecksForReferences(videos.map((v) => v.id)).catch(() => new Map<string, ViewerCheckData>());

  return (
    <>
      <NavBar />
      <PageShell maxWidth={760}>
        <BackLink href="/reference">Reference</BackLink>
        <PageHeader eyebrow="Reference creator" title={creator.name} description={creator.brandPositioning || undefined} />

        <div className="mb-5">
          <ButtonLink href={`/reference/add?creator=${id}`} tone="primary" className="w-full !min-h-[52px] !text-[16px] sm:w-auto">
            ＋ Add {creator.name}&apos;s videos
          </ButtonLink>
        </div>

        <div className="flex flex-col gap-4">
          <StyleGroupPicker creatorId={id} group={creatorStyleGroup(creator.formats)} />

          {(creator.relevanceToChris || creator.doNotTransfer) && (
            <div className="flex flex-col gap-2">
              {creator.relevanceToChris && (
                <p className="text-[14px] text-[var(--color-text-muted)]">
                  <span className="font-medium text-[var(--color-text)]">Why they matter: </span>
                  {creator.relevanceToChris}
                </p>
              )}
              {creator.doNotTransfer && (
                <p className="text-[14px] text-[var(--color-rose-400)]">
                  <span className="font-medium">Don&apos;t copy: </span>
                  {creator.doNotTransfer}
                </p>
              )}
            </div>
          )}

          {linkError && <p className="text-[14px] text-[var(--color-rose-400)]">{linkError}</p>}

          <MeasureControl activeJobRunId={active?.id ?? null} pending={pending} failed={failed} outdated={outdated} />

          {model.sampleSize > 0 && <StyleModelCard model={model} eyebrow="What they do" title={`${creator.name}, in a paragraph`} />}
          {model.sampleSize > 0 && <StyleModelCard model={model} eyebrow="What they do" title={`${creator.name}, in a paragraph`} />}
          {videos.length > 0 && <StyleCard eyebrow="Style" title={`How ${creator.name} edits`} profile={profile} />}

          {videos.length > 0 && (
            <ul className="flex flex-col gap-3" data-testid="ref-videos">
              {videos.map((v) => (
                <VideoCard key={v.id} v={v} back={back} creators={allCreators} creatorId={id} viewer={viewerChecks.get(v.id) ?? null} />
              ))}
            </ul>
          )}

          <CollapsiblePanel eyebrow="Notes" title="Written notes & AI observations" defaultOpen={videos.length === 0 && notes.length > 0}>
            {analysisError && (
              <p className="mb-3 text-sm text-[var(--color-rose-400)]">
                <span className="font-medium">Analysis error: </span>
                {analysisError}
              </p>
            )}
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
              <Button className="w-full sm:w-auto sm:self-start" pendingLabel="Adding…">
                Add notes
              </Button>
            </form>

            <div className="mt-4 flex flex-col gap-4">
              {notes.map(
                (content) =>
                  content && (
                    <Panel key={content.id}>
                      <h3 className="text-[15px] font-semibold">{content.hook || content.topic || "Notes"}</h3>
                      <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--color-text-muted)]">{content.description}</p>
                      <form action={analyzeContent} className="mt-4">
                        <input type="hidden" name="referenceCreatorId" value={creator.id} />
                        <input type="hidden" name="referenceContentId" value={content.id} />
                        <Button className="w-full sm:w-auto" pendingLabel="Analyzing…">
                          Ask the AI what transfers (uses AI credit)
                        </Button>
                      </form>
                      {content.observations.length > 0 && (
                        <ul className="mt-4 flex flex-col gap-3">
                          {content.observations.map((o) => (
                            <li key={o.id} className="rounded-lg border border-[var(--color-border)] bg-white/[0.03] p-3 text-[13px] leading-relaxed">
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
            </div>
          </CollapsiblePanel>
        </div>
      </PageShell>
    </>
  );
}

const GROUP_OPTIONS = [
  { group: "MAIN", label: "Talking videos", hint: "Counts toward your main style" },
  { group: "FACELESS", label: "No-face motivational", hint: "Its own style — not mixed into yours" },
] as const;

function StyleGroupPicker({ creatorId, group }: { creatorId: string; group: "MAIN" | "FACELESS" }) {
  return (
    <div data-testid="style-group">
      <p className="mb-2 text-[13px] text-[var(--color-text-faint)]">What kind of videos are these?</p>
      <div className="grid grid-cols-2 gap-2">
        {GROUP_OPTIONS.map((o) => {
          const on = o.group === group;
          return (
            <form key={o.group} action={setCreatorStyleGroup}>
              <input type="hidden" name="referenceCreatorId" value={creatorId} />
              <input type="hidden" name="group" value={o.group} />
              <button
                type="submit"
                aria-pressed={on}
                disabled={on}
                className={`flex min-h-[64px] w-full flex-col items-start justify-center rounded-2xl border px-3 py-2 text-left ${on ? "border-[var(--color-gold-400)] bg-[var(--color-surface-raised)]" : "border-[var(--color-border)] active:opacity-70"}`}
              >
                <span className={`text-[15px] font-semibold ${on ? "text-[var(--color-gold-400)]" : ""}`}>{on ? "✓ " : ""}{o.label}</span>
                <span className="mt-0.5 text-[12px] leading-snug text-[var(--color-text-faint)]">{o.hint}</span>
              </button>
            </form>
          );
        })}
      </div>
    </div>
  );
}
