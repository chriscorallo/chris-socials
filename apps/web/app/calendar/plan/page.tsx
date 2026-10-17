import { prisma, getActivePostingPlan, listPostingPlanVersions, ownerStarterPostingPlanData, ymdInTz, mondayOfYmd } from "@chris/domain";
import { requireSession } from "../../../lib/session";
import { NavBar } from "../../components/NavBar";
import { PageShell, BackLink } from "../../components/ui";
import { APP_TZ } from "../../../lib/calendar-data";
import { PlanEditor } from "./PlanEditor";

// Posting plan settings — how often Chris posts on each platform, which days, what times, and
// how far ahead a video should be filmed / ready. Saving writes a new PostingPlan version
// (append-only). The calendar's open slots and every Stay-on-course nudge come from this.

export default async function PostingPlanPage() {
  await requireSession();
  const today = ymdInTz(new Date(), APP_TZ);
  const active = await getActivePostingPlan(prisma);
  const versions = await listPostingPlanVersions(prisma);
  const initial = active ?? ownerStarterPostingPlanData(mondayOfYmd(today), APP_TZ);

  return (
    <>
      <NavBar />
      <PageShell maxWidth={760}>
        <BackLink href="/calendar">Calendar</BackLink>
        <header className="mb-5">
          <p className="eyebrow mb-1">Stay on course</p>
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-2xl">Posting plan</h1>
          <p className="mt-2 text-[15px] leading-snug text-[var(--color-text-muted)] sm:text-sm">
            Pick how often you post and when. The calendar shows each planned slot, and you&apos;ll get nudged — film by, finish
            by, schedule this — before you fall behind.
          </p>
          <p className="mt-2 text-[12.5px] text-[var(--color-text-faint)]">
            {active
              ? `Version ${active.version} · ${versions.length} saved version${versions.length === 1 ? "" : "s"} (older ones are kept) · times in ${APP_TZ.replace("_", " ")}`
              : `No plan saved yet — this is a suggested starting point. Times in ${APP_TZ.replace("_", " ")}.`}
          </p>
        </header>
        <PlanEditor initial={initial} today={today} hasPlan={Boolean(active)} />
      </PageShell>
    </>
  );
}
