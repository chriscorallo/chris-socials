"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { prisma, runRecordedJob } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { runAutopilot, AUTOPILOT_JOB_KIND } from "../../lib/content-steps";



/**
 * Autopilot over a selection of items, in the background (after the response — a batch can
 * take many minutes). Sequential, one item at a time, each isolated: one item's failure is
 * recorded and the rest continue. The whole batch is one JobRun row whose summary lists, per
 * item, what Autopilot did and why it stopped — shown on the Content page.
 */
export async function runAutopilotBatch(formData: FormData) {
  const session = await requireSession();
  const ids = formData.getAll("contentItemId").map(String).filter(Boolean).slice(0, 40);
  const stage = String(formData.get("stage") ?? "");
  if (ids.length === 0) redirect(`/content?stage=${stage}`);

  const actor = { actorId: session.user!.id! };
  after(async () => {
    await runRecordedJob(prisma, AUTOPILOT_JOB_KIND, async () => {
      const items: { contentItemId: string; title: string; finalState: string; stoppedBecause: string; steps: number }[] = [];
      for (const contentItemId of ids) {
        const item = await prisma.contentItem.findUnique({ where: { id: contentItemId }, select: { title: true } });
        try {
          const r = await runAutopilot(contentItemId, actor);
          items.push({ contentItemId, title: item?.title ?? contentItemId, finalState: r.finalState, stoppedBecause: r.stoppedBecause, steps: r.steps.length });
        } catch (err) {
          items.push({ contentItemId, title: item?.title ?? contentItemId, finalState: "ERROR", stoppedBecause: err instanceof Error ? err.message : String(err), steps: 0 });
        }
      }
      return { items };
    });
  });
  redirect(`/content?stage=${stage}&batch=${ids.length}`);
}
