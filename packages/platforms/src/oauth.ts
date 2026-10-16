import { describePlatformError, type Platform } from "./adapter";
import { request, type FetchLike, type HttpResult } from "./http";
import { DEFAULT_INSTAGRAM_GRAPH_API_VERSION } from "./instagram-adapter";

/**
 * OAuth authorization-code + refresh flows for the three platforms. Endpoints verified against
 * official docs on 2026-10-16 (URLs in docs/decisions-pending/platforms.md):
 *
 * Instagram API with Instagram Login (business-login):
 *   authorize  https://www.instagram.com/oauth/authorize (client_id, redirect_uri,
 *              response_type=code, scope comma-separated, state)
 *   code       POST https://api.instagram.com/oauth/access_token -> short-lived token + user_id
 *              (code valid 1h, single use; strip a trailing "#_")
 *   long-lived GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token (60d)
 *   refresh    GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token
 *              (token must be ≥24h old and unexpired; extends 60d)
 * Google / YouTube:
 *   authorize  https://accounts.google.com/o/oauth2/v2/auth (access_type=offline, prompt=consent
 *              so a refresh_token is always issued)
 *   token      POST https://oauth2.googleapis.com/token (authorization_code | refresh_token)
 * TikTok Login Kit (web):
 *   authorize  https://www.tiktok.com/v2/auth/authorize/ (client_key, scope comma-separated,
 *              response_type=code, redirect_uri, state) — PKCE is documented only for
 *              mobile/desktop apps; the web flow uses client_secret server-side.
 *   token      POST https://open.tiktokapis.com/v2/oauth/token/ (authorization_code |
 *              refresh_token); access 24h, refresh 365d, refresh_token may rotate.
 */

export type OAuthEnv = Record<string, string | undefined>;

export const OAUTH_SCOPES: Record<Platform, string[]> = {
  INSTAGRAM: [
    "instagram_business_basic",
    "instagram_business_content_publish",
    "instagram_business_manage_insights",
    "instagram_business_manage_comments",
  ],
  YOUTUBE: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
  TIKTOK: ["user.info.basic", "video.publish", "video.upload", "video.list"],
};

const CLIENT_ENV: Record<Platform, { id: string; secret: string }> = {
  INSTAGRAM: { id: "INSTAGRAM_APP_ID", secret: "INSTAGRAM_APP_SECRET" },
  YOUTUBE: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
  TIKTOK: { id: "TIKTOK_CLIENT_KEY", secret: "TIKTOK_CLIENT_SECRET" },
};

export class OAuthError extends Error {
  constructor(
    public readonly platform: Platform,
    message: string,
    public readonly body: unknown = null,
  ) {
    super(`${platform} OAuth: ${message}`);
    this.name = "OAuthError";
  }
}

export function parsePlatformParam(value: string): Platform | null {
  const upper = value.toUpperCase();
  return upper === "INSTAGRAM" || upper === "YOUTUBE" || upper === "TIKTOK" ? upper : null;
}

/** Names of env vars a platform's OAuth flow needs that are unset (empty = ready). */
export function missingOAuthEnv(platform: Platform, env: OAuthEnv): string[] {
  const names = [CLIENT_ENV[platform].id, CLIENT_ENV[platform].secret, "APP_BASE_URL", "TOKEN_ENCRYPTION_KEY"];
  return names.filter((n) => !env[n]);
}

function clientConfig(platform: Platform, env: OAuthEnv): { clientId: string; clientSecret: string } {
  const clientId = env[CLIENT_ENV[platform].id];
  const clientSecret = env[CLIENT_ENV[platform].secret];
  if (!clientId || !clientSecret) {
    throw new OAuthError(platform, `missing ${CLIENT_ENV[platform].id}/${CLIENT_ENV[platform].secret}.`);
  }
  return { clientId, clientSecret };
}

export function oauthRedirectUri(platform: Platform, env: OAuthEnv): string {
  const base = env.APP_BASE_URL;
  if (!base) throw new OAuthError(platform, "APP_BASE_URL is not set.");
  return `${base.replace(/\/+$/, "")}/api/oauth/${platform.toLowerCase()}/callback`;
}

export function buildAuthorizationUrl(platform: Platform, input: { env: OAuthEnv; state: string }): string {
  const { clientId } = clientConfig(platform, input.env);
  const redirectUri = oauthRedirectUri(platform, input.env);
  if (platform === "INSTAGRAM") {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: OAUTH_SCOPES.INSTAGRAM.join(","),
      state: input.state,
      enable_fb_login: "false",
    });
    return `https://www.instagram.com/oauth/authorize?${params}`;
  }
  if (platform === "YOUTUBE") {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: OAUTH_SCOPES.YOUTUBE.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: input.state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }
  const params = new URLSearchParams({
    client_key: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.TIKTOK.join(","),
    state: input.state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params}`;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  accountId: string;
  accountName: string | null;
  scopes: string[];
  /** Non-secret extras persisted as PlatformCredential.metadata. */
  metadata: Record<string, unknown>;
}

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  refreshExpiresAt?: Date | null;
}

interface FlowDeps {
  env: OAuthEnv;
  fetchImpl?: FetchLike;
  now?: Date;
}

function deps(input: FlowDeps): { fetchImpl: FetchLike; now: Date } {
  return { fetchImpl: input.fetchImpl ?? ((url, init) => fetch(url, init)), now: input.now ?? new Date() };
}

function expiresAtFrom(now: Date, expiresIn: unknown): Date | null {
  const seconds = typeof expiresIn === "number" ? expiresIn : typeof expiresIn === "string" ? Number(expiresIn) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? new Date(now.getTime() + seconds * 1000) : null;
}

function form(params: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  };
}

function ensureOk(platform: Platform, op: string, result: HttpResult): Record<string, unknown> {
  const body = (result.body ?? {}) as Record<string, unknown>;
  if (!result.ok || (typeof body.error === "string" && body.error.length > 0)) {
    throw new OAuthError(platform, `${op} failed (HTTP ${result.status})${describePlatformError(result.body)}`, result.body);
  }
  return body;
}

function graphBase(env: OAuthEnv): string {
  return `https://graph.instagram.com/${env.INSTAGRAM_GRAPH_API_VERSION ?? DEFAULT_INSTAGRAM_GRAPH_API_VERSION}`;
}

export async function exchangeAuthorizationCode(
  platform: Platform,
  input: FlowDeps & { code: string },
): Promise<OAuthTokenSet> {
  const { fetchImpl, now } = deps(input);
  const { clientId, clientSecret } = clientConfig(platform, input.env);
  const redirectUri = oauthRedirectUri(platform, input.env);

  if (platform === "INSTAGRAM") {
    const code = input.code.replace(/#_$/, "");
    const short = ensureOk(
      platform,
      "code exchange",
      await request(fetchImpl, "https://api.instagram.com/oauth/access_token", form({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      })),
    );
    const shortData = (Array.isArray(short.data) ? short.data[0] : short) as Record<string, unknown> | undefined;
    const shortToken = shortData?.access_token;
    if (typeof shortToken !== "string") throw new OAuthError(platform, "no short-lived access_token returned.", short);
    const permissions = shortData?.permissions;
    const scopes = Array.isArray(permissions)
      ? permissions.map(String)
      : typeof permissions === "string"
        ? permissions.split(",").map((s) => s.trim()).filter(Boolean)
        : [];

    const longLived = ensureOk(
      platform,
      "long-lived token exchange",
      await request(
        fetchImpl,
        `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(clientSecret)}&access_token=${encodeURIComponent(shortToken)}`,
      ),
    );
    const accessToken = longLived.access_token;
    if (typeof accessToken !== "string") throw new OAuthError(platform, "no long-lived access_token returned.", longLived);

    const me = ensureOk(
      platform,
      "profile lookup",
      await request(fetchImpl, `${graphBase(input.env)}/me?fields=user_id,username&access_token=${encodeURIComponent(accessToken)}`),
    );
    const accountId = String(me.user_id ?? shortData?.user_id ?? "");
    if (!accountId) throw new OAuthError(platform, "could not determine the Instagram account id.", me);
    const accountName = typeof me.username === "string" ? me.username : null;
    return {
      accessToken,
      refreshToken: null,
      expiresAt: expiresAtFrom(now, longLived.expires_in),
      accountId,
      accountName,
      scopes,
      metadata: { scopes, accountName, issuedAt: now.toISOString() },
    };
  }

  if (platform === "YOUTUBE") {
    const token = ensureOk(
      platform,
      "code exchange",
      await request(fetchImpl, "https://oauth2.googleapis.com/token", form({
        code: input.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      })),
    );
    const accessToken = token.access_token;
    if (typeof accessToken !== "string") throw new OAuthError(platform, "no access_token returned.", token);
    const refreshToken = typeof token.refresh_token === "string" ? token.refresh_token : null;
    if (!refreshToken) {
      throw new OAuthError(
        platform,
        "Google returned no refresh_token — remove this app's access at myaccount.google.com/permissions and connect again.",
      );
    }
    const scopes = typeof token.scope === "string" ? token.scope.split(" ").filter(Boolean) : [];
    const channel = ensureOk(
      platform,
      "channel lookup",
      await request(fetchImpl, "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    const item = (channel.items as { id?: string; snippet?: { title?: string } }[] | undefined)?.[0];
    if (!item?.id) throw new OAuthError(platform, "this Google account has no YouTube channel.", channel);
    const accountName = item.snippet?.title ?? null;
    return {
      accessToken,
      refreshToken,
      expiresAt: expiresAtFrom(now, token.expires_in),
      accountId: item.id,
      accountName,
      scopes,
      metadata: { scopes, accountName, issuedAt: now.toISOString() },
    };
  }

  const token = ensureOk(
    platform,
    "code exchange",
    await request(fetchImpl, "https://open.tiktokapis.com/v2/oauth/token/", form({
      client_key: clientId,
      client_secret: clientSecret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    })),
  );
  const accessToken = token.access_token;
  if (typeof accessToken !== "string" || typeof token.open_id !== "string") {
    throw new OAuthError(platform, "no access_token/open_id returned.", token);
  }
  const scopes = typeof token.scope === "string" ? token.scope.split(",").map((s) => s.trim()).filter(Boolean) : [];
  let accountName: string | null = null;
  try {
    const info = await request(fetchImpl, "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    accountName = ((info.body as { data?: { user?: { display_name?: string } } } | null)?.data?.user?.display_name) ?? null;
  } catch {
    // Display name is cosmetic.
  }
  const refreshExpiresAt = expiresAtFrom(now, token.refresh_expires_in);
  return {
    accessToken,
    refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : null,
    expiresAt: expiresAtFrom(now, token.expires_in),
    accountId: token.open_id,
    accountName,
    scopes,
    metadata: {
      scopes,
      accountName,
      openId: token.open_id,
      issuedAt: now.toISOString(),
      refreshExpiresAt: refreshExpiresAt?.toISOString() ?? null,
    },
  };
}

export async function refreshAccessToken(
  platform: Platform,
  input: FlowDeps & { accessToken: string; refreshToken: string | null },
): Promise<RefreshedTokens> {
  const { fetchImpl, now } = deps(input);

  if (platform === "INSTAGRAM") {
    const body = ensureOk(
      platform,
      "token refresh",
      await request(
        fetchImpl,
        `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(input.accessToken)}`,
      ),
    );
    if (typeof body.access_token !== "string") throw new OAuthError(platform, "refresh returned no access_token.", body);
    return { accessToken: body.access_token, refreshToken: null, expiresAt: expiresAtFrom(now, body.expires_in) };
  }

  if (!input.refreshToken) throw new OAuthError(platform, "no refresh token stored — reconnect in Settings → Connections.");
  const { clientId, clientSecret } = clientConfig(platform, input.env);

  if (platform === "YOUTUBE") {
    const body = ensureOk(
      platform,
      "token refresh",
      await request(fetchImpl, "https://oauth2.googleapis.com/token", form({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: input.refreshToken,
        grant_type: "refresh_token",
      })),
    );
    if (typeof body.access_token !== "string") throw new OAuthError(platform, "refresh returned no access_token.", body);
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : input.refreshToken,
      expiresAt: expiresAtFrom(now, body.expires_in),
    };
  }

  const body = ensureOk(
    platform,
    "token refresh",
    await request(fetchImpl, "https://open.tiktokapis.com/v2/oauth/token/", form({
      client_key: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    })),
  );
  if (typeof body.access_token !== "string") throw new OAuthError(platform, "refresh returned no access_token.", body);
  return {
    accessToken: body.access_token,
    // TikTok may rotate the refresh token — always store what it returns.
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : input.refreshToken,
    expiresAt: expiresAtFrom(now, body.expires_in),
    refreshExpiresAt: expiresAtFrom(now, body.refresh_expires_in),
  };
}
