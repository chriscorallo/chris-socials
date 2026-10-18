"use server";

import { requireSession } from "../../lib/session";
import { runHeavyJob } from "../../lib/heavy-jobs";

/**
 * "Watch it like a new viewer" — starts the `viewer-review` heavy job (in-process locally, a
 * cloud worker on Vercel) and returns its JobRun id for the card to follow. One tap, one
 * advisory review; nothing about the video changes. Never throws to the client.
 */
export async function startViewerReview(input: {
  contentItemId?: string;
  referenceContentId?: string;
  platform?: "TIKTOK" | "INSTAGRAM" | "YOUTUBE";
  persona?: "COLD" | "FOLLOWER";
}): Promise<{ jobRunId: string } | { error: string }> {
  const session = await requireSession();
  try {
    const args = input.contentItemId
      ? { contentItemId: input.contentItemId, platform: input.platform, persona: input.persona }
      : { referenceContentId: input.referenceContentId, platform: input.platform, persona: input.persona };
    const r = await runHeavyJob("viewer-review", args, { actorId: session.user!.id!, background: true });
    if (r.status === "refused") return { error: r.message };
    if (r.status === "busy") {
      // Something else (a render, an upload's analysis) holds this video; follow it if it's ours.
      if (r.jobKind === "viewer-review") return { jobRunId: r.jobRunId };
      return { error: r.message };
    }
    return { jobRunId: r.jobRunId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't start the viewer check." };
  }
}
