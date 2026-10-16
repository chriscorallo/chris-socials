"use server";

import { redirect } from "next/navigation";
import { prisma, deletePlatformCredentialRow, setFlag } from "@chris/domain";
import { parsePlatformParam } from "@chris/platforms";
import { requireSession } from "../../../lib/session";

const SCHEDULED_PUBLISH_FLAG = "publishing.scheduled_auto";

/** Removes the stored (encrypted) credential. Audit-logged; the platform-side app grant is
 * left for Chris to revoke in that platform's settings if he wants it gone there too. */
export async function disconnectPlatform(formData: FormData) {
  const session = await requireSession();
  const platform = parsePlatformParam(String(formData.get("platform") ?? ""));
  let message: string;
  if (!platform) {
    message = "oauthError=Unknown platform.";
  } else {
    const removed = await deletePlatformCredentialRow(prisma, platform, { actorId: session.user!.id! });
    message = removed ? `disconnected=${platform}` : `oauthError=${encodeURIComponent(`${platform} was not connected.`)}`;
  }
  redirect(`/settings/connections?${message}`);
}

/** Flips the scheduled auto-publish feature flag (default OFF). Audit-logged by setFlag. */
export async function setScheduledAutoPublish(formData: FormData) {
  const session = await requireSession();
  const enabled = formData.get("enabled") === "true";
  await setFlag(prisma, {
    key: SCHEDULED_PUBLISH_FLAG,
    enabled,
    description: "Publish SCHEDULED items automatically at their scheduled time (cron /api/cron/publish-scheduled).",
    actor: session.user!.id!,
    actorType: "HUMAN",
  });
  redirect("/settings/connections");
}
