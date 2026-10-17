import { Suspense, type ReactNode } from "react";
import { prisma, getActiveHeavyJob } from "@chris/domain";
import { HeavyJobBanner } from "./HeavyJobBanner";

/**
 * Wraps a video's pages only to add the floating heavy-job progress card (render /
 * transcription / … running in the cloud). Layout of the pages themselves is untouched.
 */
export default async function ContentItemLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const active = await getActiveHeavyJob(prisma, id).catch(() => null);
  return (
    <>
      {children}
      <Suspense fallback={null}>
        <HeavyJobBanner activeJobRunId={active?.id ?? null} />
      </Suspense>
    </>
  );
}
