import { prisma, getActivePostingPlan, listExistingPlanned, ymdInTz } from "@chris/domain";
import { enabledPlatformsOf } from "@chris/domain/plan-import";
import { requireSession } from "../../../lib/session";
import { APP_TZ } from "../../../lib/calendar-data";
import { NavBar } from "../../components/NavBar";
import { BackLink, PageHeader, PageShell } from "../../components/ui";
import { ImportClient } from "./ImportClient";

export const maxDuration = 120;

/** Import a video plan (a day, a week, a month or a year): paste / file / Google Sheet →
 * preview → Create. See docs/decisions-pending/plan-import.md. */
export default async function ImportPlanPage() {
  await requireSession();
  const plan = await getActivePostingPlan(prisma);
  const existing = await listExistingPlanned(prisma, APP_TZ);
  return (
    <>
      <NavBar />
      <PageShell maxWidth={680}>
        <BackLink href="/plan">Plan</BackLink>
        <PageHeader eyebrow="Plan" title="Import your plan" />
        <ImportClient
          today={ymdInTz(new Date(), APP_TZ)}
          existing={existing.map((e) => ({ title: e.title, ymd: e.ymd, contentItemId: e.contentItemId }))}
          enabledPlatforms={enabledPlatformsOf(plan)}
          cadences={plan?.cadences ?? null}
        />
      </PageShell>
    </>
  );
}
