import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { buildAuthorizationUrl, missingOAuthEnv, parsePlatformParam } from "@chris/platforms";
import { requireSession } from "../../../../../lib/session";
import { OAUTH_STATE_MAX_AGE_SECONDS, connectionsUrl, isSecureBase, stateCookieName } from "../../oauth-shared";

/**
 * Starts the OAuth authorization-code flow for one platform. Auth-gated (requireSession), and
 * CSRF-protected: a random `state` is set in an httpOnly, SameSite=Lax cookie scoped to
 * /api/oauth and must round-trip through the provider unchanged (checked in /callback).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  await requireSession();
  const { platform: raw } = await params;
  const platform = parsePlatformParam(raw);
  if (!platform) {
    return NextResponse.redirect(connectionsUrl(request, { oauthError: `Unknown platform "${raw}".` }));
  }

  const missing = missingOAuthEnv(platform, process.env);
  if (missing.length > 0) {
    return NextResponse.redirect(
      connectionsUrl(request, { oauthError: `${platform} isn't configured — set ${missing.join(", ")}.` }),
    );
  }

  const state = randomBytes(32).toString("base64url");
  const authorizationUrl = buildAuthorizationUrl(platform, { env: process.env, state });

  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set(stateCookieName(platform), state, {
    httpOnly: true,
    secure: isSecureBase(request),
    sameSite: "lax",
    path: "/api/oauth",
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  });
  return response;
}
