"use server";

import { redirect } from "next/navigation";
import { prisma, disconnectConnector } from "@chris/domain";
import { requireSession } from "../../../lib/session";

/** "Disconnect ChatGPT": revokes every live grant (all access + refresh tokens die). Audit-logged. */
export async function disconnectChatGpt() {
  const session = await requireSession();
  const n = await disconnectConnector(prisma, session.user!.id!);
  redirect(`/settings/chatgpt?disconnected=${n}`);
}
