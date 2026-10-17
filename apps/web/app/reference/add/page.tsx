import { prisma, listReferenceCreators } from "@chris/domain";
import { requireSession } from "../../../lib/session";
import { storageMode } from "../../../lib/storage";
import { NavBar } from "../../components/NavBar";
import { BackLink, PageHeader, PageShell } from "../../components/ui";
import { ReferenceUpload } from "./ReferenceUpload";

export const maxDuration = 300;

/** Add reference videos (phone-first batch upload). See docs/decisions-pending/reference-videos.md. */
export default async function AddReferenceVideosPage({ searchParams }: { searchParams: Promise<{ creator?: string }> }) {
  await requireSession();
  const { creator } = await searchParams;
  const creators = await listReferenceCreators(prisma, { limit: 200 });
  const initial = creators.some((c) => c.id === creator) ? creator : undefined;
  return (
    <>
      <NavBar />
      <PageShell maxWidth={680}>
        <BackLink href={initial ? `/reference/${initial}` : "/reference"}>Reference</BackLink>
        <PageHeader eyebrow="Reference" title="Add reference videos" description="Videos from creators whose editing you want yours to feel like. The app measures their cuts, pacing, hooks, endings and sound — no AI, no cost." />
        <ReferenceUpload creators={creators.map((c) => ({ id: c.id, name: c.name }))} mode={storageMode} initialCreatorId={initial} />
      </PageShell>
    </>
  );
}
