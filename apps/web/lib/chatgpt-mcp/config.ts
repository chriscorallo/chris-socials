import type { OAuthServerConfig } from "@chris/domain";

/**
 * ChatGPT connector configuration. The issuer must be stable (ChatGPT stores it), so it is
 * APP_BASE_URL when set (production: https://chris-content-intelligence.vercel.app) and the
 * request's own origin otherwise (local dev). See docs/decisions-pending/chatgpt-connector.md.
 */

export const MCP_PATH = "/api/mcp";

export function connectorEnabled(): boolean {
  return (process.env.CHATGPT_CONNECTOR ?? "on").toLowerCase() !== "off";
}

export function connectorBaseUrl(requestUrl?: string): string {
  const base = process.env.APP_BASE_URL || (requestUrl ? new URL(requestUrl).origin : "http://localhost:3000");
  return base.replace(/\/+$/, "");
}

export function connectorConfig(requestUrl?: string): OAuthServerConfig {
  const issuer = connectorBaseUrl(requestUrl);
  const extra = (process.env.CHATGPT_CONNECTOR_REDIRECT_URIS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    issuer,
    resource: `${issuer}${MCP_PATH}`,
    // Loopback redirects (MCP Inspector, local SDK client) never in production unless explicitly allowed.
    allowLoopback: process.env.NODE_ENV !== "production" || process.env.CHATGPT_CONNECTOR_ALLOW_LOOPBACK === "true",
    extraRedirectUris: extra,
  };
}

/** Bearer-token endpoints are called cross-origin by browser tools (MCP Inspector); no cookies are involved. */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS, ...headers },
  });
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function disabledResponse(): Response {
  return jsonResponse({ error: "temporarily_unavailable", error_description: "The ChatGPT connector is turned off." }, 503);
}

/** Reads a request body with a hard size cap (DCR/token are unauthenticated). */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > maxBytes) return null;
  const text = await request.text();
  return text.length > maxBytes ? null : text;
}
