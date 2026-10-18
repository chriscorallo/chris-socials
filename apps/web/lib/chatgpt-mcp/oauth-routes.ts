import {
  prisma,
  authorizationServerMetadata,
  protectedResourceMetadata,
  registerClient,
  exchangeToken,
  revokeToken,
  OAuthError,
} from "@chris/domain";
import { connectorConfig, connectorEnabled, disabledResponse, jsonResponse, readBodyCapped } from "./config";

/**
 * The OAuth HTTP endpoints, as plain (Request) => Response functions so tests can call them
 * without a server. Routes under app/.well-known/* and app/oauth/* just re-export these.
 */

function oauthError(err: unknown): Response {
  if (err instanceof OAuthError) {
    const headers: Record<string, string> = err.status === 401 ? { "WWW-Authenticate": 'Basic realm="oauth"' } : {};
    return jsonResponse(err.toJSON(), err.status, headers);
  }
  console.error("[chatgpt-connector] oauth error", err);
  return jsonResponse({ error: "server_error", error_description: "Something went wrong." }, 500);
}

export async function authorizationServerMetadataResponse(request: Request): Promise<Response> {
  if (!connectorEnabled()) return disabledResponse();
  return jsonResponse(authorizationServerMetadata(connectorConfig(request.url)), 200, { "Cache-Control": "public, max-age=300" });
}

export async function protectedResourceMetadataResponse(request: Request): Promise<Response> {
  if (!connectorEnabled()) return disabledResponse();
  return jsonResponse(protectedResourceMetadata(connectorConfig(request.url)), 200, { "Cache-Control": "public, max-age=300" });
}

export async function registerResponse(request: Request): Promise<Response> {
  if (!connectorEnabled()) return disabledResponse();
  const text = await readBodyCapped(request, 16_000);
  if (text == null) return jsonResponse({ error: "invalid_client_metadata", error_description: "Body too large." }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonResponse({ error: "invalid_client_metadata", error_description: "Body must be JSON." }, 400);
  }
  try {
    return jsonResponse(await registerClient(prisma, body, connectorConfig(request.url)), 201);
  } catch (err) {
    return oauthError(err);
  }
}

async function formOf(request: Request): Promise<Record<string, string> | null> {
  const text = await readBodyCapped(request, 16_000);
  if (text == null) return null;
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    } catch {
      return null;
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export async function tokenResponse(request: Request): Promise<Response> {
  if (!connectorEnabled()) return disabledResponse();
  const form = await formOf(request);
  if (!form) return jsonResponse({ error: "invalid_request", error_description: "Unreadable body." }, 400);
  try {
    return jsonResponse(await exchangeToken(prisma, form, connectorConfig(request.url)), 200, { Pragma: "no-cache" });
  } catch (err) {
    return oauthError(err);
  }
}

export async function revokeResponse(request: Request): Promise<Response> {
  if (!connectorEnabled()) return disabledResponse();
  const form = await formOf(request);
  try {
    await revokeToken(prisma, form?.token, connectorConfig(request.url));
  } catch (err) {
    console.error("[chatgpt-connector] revoke error", err);
  }
  return jsonResponse({}, 200);
}
