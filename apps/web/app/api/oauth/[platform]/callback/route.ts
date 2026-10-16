import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@chris/domain";
import { exchangeAuthorizationCode, parsePlatformParam, saveOAuthTokenSet } from "@chris/platforms";
import { requireSession } from "../../../../../lib/session";
import { connectionsUrl, stateCookieName } from "../../oauth-shared";

function sameState(a: string | undefined, b: string | null): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * OAuth redirect target: verifies `state` against the cookie set by /start (CSRF), exchanges
 * the code for tokens (Instagram: short-lived -> 60-day long-lived), and stores them encrypted
 * in PlatformCredential (audit-logged, no token material in the log). Every outcome lands back
 * on Settings → Connections with a one-line status.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const session = await requireSession();
  const { platform: raw } = await params;
  const platform = parsePlatformParam(raw);
  if (!platform) {
    return NextResponse.redirect(connectionsUrl(request, { oauthError: `Unknown platform "${raw}".` }));
  }

  const url = new URL(request.url);
  const cookieName = stateCookieName(platform);
  const expectedState = request.cookies.get(cookieName)?.value;

  const finish = (params: Record<string, string>) => {
    const response = NextResponse.redirect(connectionsUrl(request, params));
    response.cookies.set(cookieName, "", { path: "/api/oauth", maxAge: 0 });
    return response;
  };

  const providerError = url.searchParams.get("error");
  if (providerError) {
    const description = url.searchParams.get("error_description") ?? url.searchParams.get("error_reason") ?? providerError;
    return finish({ oauthError: `${platform} authorization was not completed: ${description}` });
  }
  if (!sameState(expectedState, url.searchParams.get("state"))) {
    return finish({ oauthError: `${platform} sign-in expired or didn't match (state check failed) — please try Connect again.` });
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return finish({ oauthError: `${platform} returned no authorization code.` });
  }

  try {
    const tokens = await exchangeAuthorizationCode(platform, { code, env: process.env });
    await saveOAuthTokenSet(prisma, platform, tokens, { actorId: session.user!.id!, actorType: "HUMAN" });
    return finish({ connected: platform });
  } catch (err) {
    return finish({ oauthError: err instanceof Error ? err.message : `Connecting ${platform} failed.` });
  }
}
