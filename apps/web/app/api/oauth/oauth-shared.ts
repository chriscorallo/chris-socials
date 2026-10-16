import type { Platform } from "@chris/platforms";

/** Shared by /api/oauth/[platform]/start and /callback. Not a route (no route.ts name). */

export const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

export function stateCookieName(platform: Platform): string {
  return `oauth_state_${platform.toLowerCase()}`;
}

export function appBaseUrl(request: Request): string {
  return (process.env.APP_BASE_URL ?? new URL(request.url).origin).replace(/\/+$/, "");
}

/** Back to Settings → Connections with a one-line status (shown by the page). */
export function connectionsUrl(request: Request, params: Record<string, string>): URL {
  const url = new URL(`${appBaseUrl(request)}/settings/connections`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value.slice(0, 300));
  return url;
}

export function isSecureBase(request: Request): boolean {
  return appBaseUrl(request).startsWith("https://");
}
