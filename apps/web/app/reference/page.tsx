import Link from "next/link";
import {
  prisma,
  listReferenceCreators,
  countReferenceCreators,
  referenceVideoCounts,
  getReferenceStyleProfile,
  creatorStyleGroup,
  getOwnSpeechProfile,
  compareOwnToReference,
  getActiveHeavyJob,
  countOutdatedReferenceVideos,
} from "@chris/domain";
import { REFERENCE_LIBRARY_SUBJECT } from "@chris/worker/heavy-job-kinds";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel, CollapsiblePanel, Button, ButtonLink } from "../components/ui";
import { createCreator } from "./actions";
import { StyleCard, CompareCard } from "./StyleCards";
import { MeasureControl } from "./MeasureProgress";

const LIMIT = 60;

// Reference creators — spec §8, "Principles transfer. Identity does not." Reference videos are
// measured deterministically (cuts, pacing, speech, sound) for a private style fingerprint the
// edit planner can use later. Capped like every other list page — see /docs/DECISIONS.md.
export default async function ReferencePage() {
  await requireSession();
  // Sequential, not Promise.all — see /docs/DECISIONS.md.
  const creators = await listReferenceCreators(prisma, { limit: LIMIT });
  const total = await countReferenceCreators(prisma);
  const counts = await referenceVideoCounts(prisma);
  const profile = await getReferenceStyleProfile(prisma, { group: "MAIN" });
  const facelessProfile = await getReferenceStyleProfile(prisma, { group: "FACELESS" });
  const hasFaceless = creators.some((c) => creatorStyleGroup(c.formats) === "FACELESS");
  const own = await getOwnSpeechProfile(prisma);
  const active = await getActiveHeavyJob(prisma, REFERENCE_LIBRARY_SUBJECT);
  const outdated = await countOutdatedReferenceVideos(prisma);
  const compare = compareOwnToReference(own, profile);
  const pending = [...counts.values()].reduce((s, c) => s + c.pending, 0);
  const failed = [...counts.values()].reduce((s, c) => s + c.failed, 0);
  const videoTotal = [...counts.values()].reduce((s, c) => s + c.total, 0);

  return (
    <>
      <NavBar />
      <PageShell maxWidth={720}>
        <PageHeader
          eyebrow="Reference"
          title="Creators you learn from"
          description="Add their videos and the app measures how they edit — cut timing, pacing, hooks, endings, music level. Private: never posted or used in your videos."
        />

        <div className="mb-5">
          <ButtonLink href="/reference/add" tone="primary" className="w-full !min-h-[52px] !text-[16px] sm:w-auto">
            ＋ Add reference videos
          </ButtonLink>
        </div>

        <div className="flex flex-col gap-4">
          <MeasureControl activeJobRunId={active?.id ?? null} pending={pending} failed={failed} outdated={outdated} />

          {videoTotal > 0 && <StyleCard eyebrow="Target style · talking videos" title={profile.creatorCount > 1 ? `Across ${profile.creatorCount} creators` : "Your references"} profile={profile} />}
          {hasFaceless && <StyleCard eyebrow="No-face motivational style" title={facelessProfile.creatorCount > 1 ? `Across ${facelessProfile.creatorCount} creators` : "Kept separate from your talking style"} profile={facelessProfile} />}
          <CompareCard lines={compare} takes={own.takes} refs={profile.sampleSize} />

          <Panel padding="p-0">
            {creators.length === 0 ? (
              <div className="p-5 text-[15px] text-[var(--color-text-muted)]">No creators yet — add a few of their videos to start.</div>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]" data-testid="creator-list">
                {creators.map((c) => {
                  const n = counts.get(c.id);
                  return (
                    <li key={c.id}>
                      <Link
                        href={`/reference/${c.id}`}
                        className="flex min-h-[64px] items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03] active:bg-white/[0.05] sm:px-5"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[16px] font-medium">{c.name}</span>
                          <span className="block truncate text-[13px] text-[var(--color-text-muted)]">
                            {n ? `${n.total} video${n.total === 1 ? "" : "s"}${n.pending ? ` · ${n.pending} waiting` : ""}` : c.brandPositioning || "No videos yet"}
                          </span>
                        </span>
                        <span className="shrink-0 text-[var(--color-text-faint)]" aria-hidden>
                          ›
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {total > LIMIT && <p className="px-4 pb-3 text-[12px] text-[var(--color-text-faint)]">Showing {LIMIT} of {total}.</p>}
          </Panel>

          <CollapsiblePanel eyebrow="Notes" title="Add a creator with notes (no videos)">
            <form action={createCreator} className="flex flex-col gap-4">
              <label className="block">
                <span className="field-label">Name</span>
                <input name="name" required autoComplete="off" className="field-input" />
              </label>
              <label className="block">
                <span className="field-label">What they&apos;re known for</span>
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
                <span className="field-label">Hook styles (one per line)</span>
                <textarea name="hookArchetypes" rows={2} className="field-input" />
              </label>
              <label className="block">
                <span className="field-label">Why they matter to you</span>
                <textarea name="relevanceToChris" rows={2} className="field-input" />
              </label>
              <label className="block">
                <span className="field-label">Don&apos;t copy</span>
                <textarea name="doNotTransfer" rows={2} className="field-input" />
              </label>
              <label className="block">
                <span className="field-label">Where this came from</span>
                <input name="sourceProvenance" className="field-input" />
              </label>
              <Button tone="primary" className="w-full sm:w-auto sm:self-start" pendingLabel="Adding…">
                Add creator
              </Button>
            </form>
          </CollapsiblePanel>
        </div>
      </PageShell>
    </>
  );
}
