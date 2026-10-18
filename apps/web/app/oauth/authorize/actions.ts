"use server";

import { redirect } from "next/navigation";
import { prisma, approveAuthorization, validateAuthorizeRequest, denyAuthorizationRedirect, type AuthorizeParams } from "@chris/domain";
import { requireSession } from "../../../lib/session";
import { connectorConfig, connectorEnabled } from "../../../lib/chatgpt-mcp/config";
import { requestOrigin } from "../../../lib/chatgpt-mcp/origin";

const FIELDS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;

function paramsOf(formData: FormData): AuthorizeParams {
  const p: AuthorizeParams = {};
  for (const f of FIELDS) {
    const v = formData.get(f);
    p[f] = typeof v === "string" && v ? v : null;
  }
  return p;
}

/** "Allow" — re-validates everything (never trusts the hidden fields), then hands ChatGPT a one-time code. */
export async function allowChatGpt(formData: FormData) {
  const session = await requireSession();
  if (!connectorEnabled()) redirect("/settings/chatgpt");
  const cfg = connectorConfig(await requestOrigin());
  const url = await approveAuthorization(prisma, paramsOf(formData), session.user!.id!, cfg);
  redirect(url);
}

export async function denyChatGpt(formData: FormData) {
  await requireSession();
  const cfg = connectorConfig(await requestOrigin());
  const p = paramsOf(formData);
  const v = await validateAuthorizeRequest(prisma, p, cfg);
  if (v.ok) redirect(denyAuthorizationRedirect(v.request.redirectUri, v.request.state, cfg));
  redirect("/settings/chatgpt");
}
