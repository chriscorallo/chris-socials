import { prisma, getActivePostingPlan, getPlanContextMessageTexts, listExistingPlanned, ymdInTz } from "@chris/domain";
import { enabledPlatformsOf } from "@chris/domain/plan-import";
import { requireSession } from "../../../lib/session";
import { APP_TZ } from "../../../lib/calendar-data";
import { NavBar } from "../../components/NavBar";
import { BackLink, PageHeader, PageShell } from "../../components/ui";
import { ImportClient } from "./ImportClient";

export const maxDuration = 120;

/** Import a video plan (a day, a week, a month or a year): paste / file / Google Sheet →
 * preview → Create. See docs/decisions-pending/plan-import.md. */
export default async function ImportPlanPage({ searchParams }: { searchParams: Promise<{ context?: string; m?: string }> }) {
  await requireSession();
  const sp = await searchParams;
  const plan = await getActivePostingPlan(prisma);
  const existing = await listExistingPlanned(prisma, APP_TZ);
  // "Update my plan from this conversation" (/plan/context/[id]): the chosen messages.
  const fromConversation = sp.context
    ? await getPlanContextMessageTexts(prisma, sp.context, (sp.m ?? "").split(",").filter(Boolean).map(Number))
    : null;
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
          fromConversation={fromConversation}
        />
      </PageShell>
    </>
  );
}
