import Link from "next/link";
import { prisma, listPlannedVideos, addDaysYmd, startOfDayInTz, ymdInTz } from "@chris/domain";
import { plannedVideoStatus } from "@chris/domain/plan-import";
import { requireSession } from "../../../lib/session";
import { storageMode } from "../../../lib/storage";
import { APP_TZ } from "../../../lib/calendar-data";
import { NavBar } from "../../components/NavBar";
import { BackLink, PageHeader, PageShell, Panel } from "../../components/ui";
import { BatchUpload } from "./BatchUpload";

export const maxDuration = 300;

/** Batch clip upload, auto-matched to planned videos. See docs/decisions-pending/plan-import.md. */
export default async function PlanUploadPage() {
  await requireSession();
  const today = ymdInTz(new Date(), APP_TZ);
  // Videos that can still take footage, from two weeks back (catching up) onwards.
  const planned = await listPlannedVideos(prisma, { tz: APP_TZ, from: startOfDayInTz(addDaysYmd(today, -14), APP_TZ) });
  const targets = planned.filter((v) => plannedVideoStatus(v.state).canUpload).map((v) => ({ id: v.id, title: v.title, ymd: v.ymd }));
  return (
    <>
      <NavBar />
      <PageShell maxWidth={680}>
        <BackLink href="/plan">Plan</BackLink>
        <PageHeader eyebrow="Plan" title="Upload clips" description="Pick everything you filmed. Each clip goes to its planned video automatically." />
        {targets.length === 0 ? (
          <Panel padding="p-5">
            <p className="text-[15px] text-[var(--color-text-muted)]">No planned videos are waiting for footage.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href="/plan/import" className="btn btn-primary">
                Import your plan
              </Link>
              <Link href="/upload" className="btn btn-ghost">
                Upload a one-off video
              </Link>
            </div>
          </Panel>
        ) : (
          <BatchUpload targets={targets} tz={APP_TZ} mode={storageMode} />
        )}
      </PageShell>
    </>
  );
}
