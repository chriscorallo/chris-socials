"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma, deletePlanContext, setPlanContextUseForAi } from "@chris/domain";
import { canonicalShareUrl, chatGptShareId, extractConversationFromShareHtml, shareServerError, type ParsedConversation } from "@chris/domain/plan-context";
import { requireSession } from "../../../lib/session";

const SHARE_MAX_BYTES = 15 * 1024 * 1024;

/**
 * ChatGPT share link → the conversation, when ChatGPT's public page carries it. One
 * reasonable attempt (only chatgpt.com/share URLs, 15 s, no retries); anything else returns a
 * plain message pointing to the export or paste. See docs/decisions-pending/plan-context.md.
 */
export async function readShareLink(link: string): Promise<{ conversation: ParsedConversation; url: string } | { error: string }> {
  await requireSession();
  const id = chatGptShareId(link);
  if (!id) return { error: "That doesn't look like a ChatGPT share link. It should look like https://chatgpt.com/share/…" };
  const url = canonicalShareUrl(id);
  const fallback = "ChatGPT didn't let the app read that link. Use the export file or paste the chat instead — both work.";
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!res.ok) return { error: res.status === 404 ? "That share link doesn't exist anymore (ChatGPT says not found)." : fallback };
    const html = await res.text();
    if (html.length > SHARE_MAX_BYTES) return { error: fallback };
    const conversation = extractConversationFromShareHtml(html);
    if (conversation) return { conversation, url };
    const said = shareServerError(html);
    return { error: said ? `ChatGPT says: “${said}” Use the export file or paste the chat instead.` : fallback };
  } catch {
    return { error: "Couldn't reach ChatGPT just now. Use the export file or paste the chat instead." };
  }
}

export async function setUseForAiAction(formData: FormData) {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  const on = String(formData.get("on") ?? "") === "1";
  await setPlanContextUseForAi(prisma, id, on, { actorId: session.user!.id! });
  revalidatePath(`/plan/context/${id}`);
  revalidatePath("/plan/context");
}

export async function deletePlanContextAction(formData: FormData) {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  const r = await deletePlanContext(prisma, id, { actorId: session.user!.id! });
  revalidatePath("/plan/context");
  redirect(`/plan/context?notice=${encodeURIComponent(r.deleted ? "Deleted. The conversation's text is gone from the app." : "That conversation was already deleted.")}`);
}
