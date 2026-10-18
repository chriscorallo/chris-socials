import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthClient, PrismaClient } from "@prisma/client";
import { recordAudit } from "./audit";

/**
 * OAuth 2.1 authorization server for the ChatGPT connector (the MCP resource is /api/mcp).
 * Small and strict on purpose — one operator, one kind of client:
 *  - authorization code + PKCE S256 only (no implicit, no client credentials, no "plain");
 *  - public clients only (token_endpoint_auth_method "none"); registered by Dynamic Client
 *    Registration (RFC 7591) or, for ChatGPT, a Client ID Metadata Document (CIMD) fetched only
 *    from an allow-listed host;
 *  - redirect URIs must be on the allow-list (ChatGPT's callbacks; loopback only outside production);
 *  - tokens are opaque 256-bit random strings, stored ONLY as SHA-256 hashes, bound to one
 *    resource (audience) and a scope; access 1 h, refresh 30 days, refresh tokens single-use
 *    with reuse detection (a replayed refresh token or code revokes the whole grant);
 *  - every approval, revocation and anomaly is in AuditLog; rows are never deleted.
 * No external library: the surface is ~5 endpoints and every check is unit-tested
 * (connector-oauth.test.ts). See docs/decisions-pending/chatgpt-connector.md.
 */

export const SCOPE_READ = "plan:read";
export const SCOPE_WRITE = "scripts:write";
export const SCOPE_OFFLINE = "offline_access";
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_OFFLINE] as const;
const DEFAULT_SCOPES = [SCOPE_READ, SCOPE_WRITE];

export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;
export const CODE_TTL_S = 5 * 60;
/** Dynamic registrations accepted per hour (all clients) — DCR is unauthenticated by design. */
export const MAX_REGISTRATIONS_PER_HOUR = 20;
/** Tool calls per grant. */
export const TOOL_CALLS_PER_MINUTE = 30;
export const TOOL_CALLS_PER_DAY = 1000;

export const TOOL_CALL_ACTION = "CHATGPT_TOOL_CALL";

export interface OAuthServerConfig {
  /** Issuer = the app's public base URL, no trailing slash ("https://….vercel.app"). */
  issuer: string;
  /** The protected resource (audience): `${issuer}/api/mcp`. */
  resource: string;
  /** Loopback redirect URIs (http://localhost:*, 127.0.0.1) — dev / MCP Inspector only. */
  allowLoopback: boolean;
  /** Extra exact redirect URIs (env CHATGPT_CONNECTOR_REDIRECT_URIS). */
  extraRedirectUris?: readonly string[];
  /** Hosts a CIMD client_id URL may live on. */
  cimdHosts?: readonly string[];
  now?: () => Date;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export class OAuthError extends Error {
  constructor(
    public readonly error: string,
    public readonly description: string,
    public readonly status = 400,
  ) {
    super(description);
  }
  toJSON() {
    return { error: this.error, error_description: this.description };
  }
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (buf: Buffer) => buf.toString("base64url");
const token = (prefix: string) => `${prefix}${b64url(randomBytes(32))}`;
const nowOf = (cfg: OAuthServerConfig) => (cfg.now ? cfg.now() : new Date());

// ---- redirect URIs ---------------------------------------------------------------------------

const CHATGPT_REDIRECTS = ["https://chatgpt.com/connector_platform_oauth_redirect"];
const CHATGPT_REDIRECT_PREFIXES = ["https://chatgpt.com/connector/oauth/"];
export const DEFAULT_CIMD_HOSTS = ["chatgpt.com"];

export function isAllowedRedirectUri(uri: string, cfg: Pick<OAuthServerConfig, "allowLoopback" | "extraRedirectUris">): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (CHATGPT_REDIRECTS.includes(uri) || (cfg.extraRedirectUris ?? []).includes(uri)) return true;
  if (CHATGPT_REDIRECT_PREFIXES.some((p) => uri.startsWith(p) && /^[A-Za-z0-9_-]{1,128}$/.test(uri.slice(p.length)))) return true;
  if (cfg.allowLoopback && u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]")) return true;
  return false;
}

// ---- metadata --------------------------------------------------------------------------------

/** RFC 8414 authorization server metadata. */
export function authorizationServerMetadata(cfg: OAuthServerConfig) {
  return {
    issuer: cfg.issuer,
    authorization_endpoint: `${cfg.issuer}/oauth/authorize`,
    token_endpoint: `${cfg.issuer}/oauth/token`,
    registration_endpoint: `${cfg.issuer}/oauth/register`,
    revocation_endpoint: `${cfg.issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SUPPORTED_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${cfg.issuer}/settings/chatgpt`,
  };
}

/** RFC 9728 protected resource metadata for /api/mcp. */
export function protectedResourceMetadata(cfg: OAuthServerConfig) {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Chris Studio",
    resource_documentation: `${cfg.issuer}/settings/chatgpt`,
  };
}

export function resourceMetadataUrl(cfg: OAuthServerConfig): string {
  return `${cfg.issuer}/.well-known/oauth-protected-resource${new URL(cfg.resource).pathname}`;
}

// ---- clients ---------------------------------------------------------------------------------

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null;
}

/** RFC 7591 dynamic registration. Only public, PKCE, code-flow clients with allow-listed redirect URIs. */
export async function registerClient(prisma: PrismaClient, body: unknown, cfg: OAuthServerConfig) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new OAuthError("invalid_client_metadata", "Body must be a JSON object.");
  const b = body as Record<string, unknown>;
  const redirectUris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (redirectUris.length === 0 || redirectUris.length > 5 || redirectUris.length !== (b.redirect_uris as unknown[]).length)
    throw new OAuthError("invalid_redirect_uri", "Give 1–5 redirect_uris.");
  const bad = redirectUris.find((u) => !isAllowedRedirectUri(u, cfg));
  if (bad) throw new OAuthError("invalid_redirect_uri", `This server only accepts ChatGPT's redirect URIs (got ${bad.slice(0, 200)}).`);
  const method = b.token_endpoint_auth_method ?? "none";
  if (method !== "none") throw new OAuthError("invalid_client_metadata", 'Only public clients (token_endpoint_auth_method "none") with PKCE are supported.');
  const grants = Array.isArray(b.grant_types) ? b.grant_types : ["authorization_code", "refresh_token"];
  if (grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) throw new OAuthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported.");
  const responses = Array.isArray(b.response_types) ? b.response_types : ["code"];
  if (responses.some((r) => r !== "code")) throw new OAuthError("invalid_client_metadata", 'Only response_type "code" is supported.');

  const now = nowOf(cfg);
  const recent = await prisma.oAuthClient.count({ where: { createdAt: { gte: new Date(now.getTime() - 3600_000) }, id: { startsWith: "csc_" } } });
  if (recent >= MAX_REGISTRATIONS_PER_HOUR) throw new OAuthError("temporarily_unavailable", "Too many registrations right now — try again later.", 429);

  const clientName = str(b.client_name, 200) ?? "Unnamed client";
  const id = token("csc_");
  const raw = JSON.stringify(b);
  const row = await prisma.oAuthClient.create({
    data: { id, clientName, redirectUris, metadata: raw.length <= 20_000 ? JSON.parse(raw) : { truncated: true }, createdAt: now },
  });
  await recordAudit(prisma, {
    actor: "oauth-dcr",
    actorType: "SYSTEM",
    action: "CHATGPT_CONNECTOR_CLIENT_REGISTERED",
    entityType: "OAuthClient",
    entityId: row.id,
    after: { clientName, redirectUris },
  });
  return {
    client_id: row.id,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

/**
 * A client by id: a registered one, or a CIMD URL on an allow-listed host (fetched, validated
 * and cached as an OAuthClient row; re-fetched when older than a day).
 */
export async function resolveClient(prisma: PrismaClient, clientId: string, cfg: OAuthServerConfig): Promise<OAuthClient> {
  if (!clientId || clientId.length > 500) throw new OAuthError("invalid_client", "Unknown client.", 401);
  const existing = await prisma.oAuthClient.findUnique({ where: { id: clientId } });
  const isUrl = clientId.startsWith("https://");
  if (existing && (!isUrl || nowOf(cfg).getTime() - existing.createdAt.getTime() < 86_400_000)) return existing;
  if (!isUrl) throw new OAuthError("invalid_client", "Unknown client — add the connector again in ChatGPT.", 401);

  const url = new URL(clientId);
  const hosts = cfg.cimdHosts ?? DEFAULT_CIMD_HOSTS;
  if (!hosts.includes(url.hostname) || url.port || url.search || url.hash) throw new OAuthError("invalid_client", "This server only accepts ChatGPT as a client.", 401);
  let doc: Record<string, unknown>;
  try {
    const res = await (cfg.fetch ?? fetch)(clientId, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 20_000) throw new Error("too large");
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    if (existing) return existing;
    throw new OAuthError("invalid_client", `Couldn't read the client metadata document (${err instanceof Error ? err.message : "error"}).`, 401);
  }
  if (doc.client_id !== clientId) throw new OAuthError("invalid_client", "Client metadata document's client_id doesn't match.", 401);
  const redirectUris = (Array.isArray(doc.redirect_uris) ? doc.redirect_uris : []).filter((u): u is string => typeof u === "string" && isAllowedRedirectUri(u, cfg));
  if (redirectUris.length === 0) throw new OAuthError("invalid_client", "Client metadata document has no allowed redirect_uris.", 401);
  const data = { clientName: str(doc.client_name, 200) ?? url.hostname, redirectUris, metadata: JSON.parse(JSON.stringify(doc)), createdAt: nowOf(cfg) };
  return existing ? prisma.oAuthClient.update({ where: { id: clientId }, data }) : prisma.oAuthClient.create({ data: { id: clientId, ...data } });
}

// ---- authorize -------------------------------------------------------------------------------

export interface AuthorizeParams {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  state?: string | null;
  scope?: string | null;
  resource?: string | null;
}

export interface ValidAuthorizeRequest {
  client: { id: string; name: string };
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scopes: string[];
  resource: string;
}

export type AuthorizeValidation =
  | { ok: true; request: ValidAuthorizeRequest }
  /** Never redirect when the client or redirect URI can't be trusted — show the error instead. */
  | { ok: false; redirect: null; error: string; description: string }
  | { ok: false; redirect: string; error: string; description: string };

export function parseScopes(scope: string | null | undefined): string[] {
  const asked = (scope ?? "").split(/\s+/).filter(Boolean);
  const known = asked.filter((s) => (SUPPORTED_SCOPES as readonly string[]).includes(s));
  const set = new Set(known.filter((s) => s !== SCOPE_OFFLINE).length ? known : [...known, ...DEFAULT_SCOPES]);
  return SUPPORTED_SCOPES.filter((s) => set.has(s));
}

/** The redirect back to the client with `iss` (RFC 9207) and state. */
export function clientRedirect(redirectUri: string, params: Record<string, string | null | undefined>, cfg: OAuthServerConfig): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  u.searchParams.set("iss", cfg.issuer);
  return u.toString();
}

export async function validateAuthorizeRequest(prisma: PrismaClient, p: AuthorizeParams, cfg: OAuthServerConfig): Promise<AuthorizeValidation> {
  let client: OAuthClient;
  try {
    client = await resolveClient(prisma, p.client_id ?? "", cfg);
  } catch (err) {
    return { ok: false, redirect: null, error: "invalid_client", description: err instanceof Error ? err.message : "Unknown client." };
  }
  const redirectUri = p.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : "");
  if (!redirectUri || !client.redirectUris.includes(redirectUri) || !isAllowedRedirectUri(redirectUri, cfg))
    return { ok: false, redirect: null, error: "invalid_request", description: "The redirect address doesn't match what this client registered." };
  const fail = (error: string, description: string): AuthorizeValidation => ({
    ok: false,
    error,
    description,
    redirect: clientRedirect(redirectUri, { error, error_description: description, state: p.state }, cfg),
  });
  if (p.response_type !== "code") return fail("unsupported_response_type", 'Only response_type "code" is supported.');
  if (!p.code_challenge || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge)) return fail("invalid_request", "PKCE code_challenge (S256) is required.");
  if (p.code_challenge_method !== "S256") return fail("invalid_request", "code_challenge_method must be S256.");
  if (p.resource && p.resource !== cfg.resource) return fail("invalid_target", `Unknown resource; this server protects ${cfg.resource}.`);
  if (p.state && p.state.length > 2000) return fail("invalid_request", "state is too long.");
  return {
    ok: true,
    request: {
      client: { id: client.id, name: client.clientName },
      redirectUri,
      codeChallenge: p.code_challenge,
      state: p.state ?? null,
      scopes: parseScopes(p.scope),
      resource: cfg.resource,
    },
  };
}

/** Chris approved — a one-time code for the client. Returns the redirect URL. */
export async function approveAuthorization(prisma: PrismaClient, p: AuthorizeParams, userId: string, cfg: OAuthServerConfig): Promise<string> {
  const v = await validateAuthorizeRequest(prisma, p, cfg);
  if (!v.ok) {
    if (v.redirect) return v.redirect;
    throw new OAuthError(v.error, v.description);
  }
  const r = v.request;
  const code = token("csc_code_");
  const now = nowOf(cfg);
  await prisma.oAuthAuthorizationCode.create({
    data: {
      codeHash: sha256Hex(code),
      clientId: r.client.id,
      userId,
      redirectUri: r.redirectUri,
      codeChallenge: r.codeChallenge,
      scope: r.scopes.join(" "),
      resource: r.resource,
      expiresAt: new Date(now.getTime() + CODE_TTL_S * 1000),
      createdAt: now,
    },
  });
  await recordAudit(prisma, {
    actor: userId,
    actorType: "HUMAN",
    action: "CHATGPT_CONNECTOR_AUTHORIZED",
    entityType: "OAuthClient",
    entityId: r.client.id,
    after: { clientName: r.client.name, scopes: r.scopes, redirectUri: r.redirectUri },
  });
  return clientRedirect(r.redirectUri, { code, state: r.state }, cfg);
}

export function denyAuthorizationRedirect(redirectUri: string, state: string | null | undefined, cfg: OAuthServerConfig): string {
  return clientRedirect(redirectUri, { error: "access_denied", error_description: "Chris didn't allow access.", state }, cfg);
}

// ---- token -----------------------------------------------------------------------------------

export function pkceChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issueTokens(prisma: PrismaClient, grantId: string, scope: string, cfg: OAuthServerConfig): Promise<TokenResponse> {
  const now = nowOf(cfg);
  const access = token("cs_at_");
  const refresh = token("cs_rt_");
  await prisma.oAuthToken.create({ data: { grantId, kind: "ACCESS", tokenHash: sha256Hex(access), scope, expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_S * 1000), createdAt: now } });
  await prisma.oAuthToken.create({ data: { grantId, kind: "REFRESH", tokenHash: sha256Hex(refresh), scope, expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_S * 1000), createdAt: now } });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope };
}

export async function revokeGrant(prisma: PrismaClient, grantId: string, reason: string, actor: { actorId: string; actorType: "HUMAN" | "SYSTEM" }, cfg?: OAuthServerConfig) {
  const g = await prisma.oAuthGrant.findUnique({ where: { id: grantId } });
  if (!g || g.revokedAt) return;
  await prisma.oAuthGrant.update({ where: { id: grantId }, data: { revokedAt: cfg ? nowOf(cfg) : new Date(), revokedReason: reason } });
  await recordAudit(prisma, { actor: actor.actorId, actorType: actor.actorType, action: "CHATGPT_CONNECTOR_REVOKED", entityType: "OAuthGrant", entityId: grantId, after: { reason } });
}

/** POST /oauth/token (form fields). Throws OAuthError. */
export async function exchangeToken(prisma: PrismaClient, form: Record<string, string | undefined>, cfg: OAuthServerConfig): Promise<TokenResponse> {
  const now = nowOf(cfg);
  if (form.resource && form.resource !== cfg.resource) throw new OAuthError("invalid_target", `Unknown resource; this server protects ${cfg.resource}.`);
  if (form.client_secret) throw new OAuthError("invalid_client", "Public clients only — don't send a client_secret.", 401);

  if (form.grant_type === "authorization_code") {
    const { code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri } = form;
    if (!code || !verifier || !clientId) throw new OAuthError("invalid_request", "code, code_verifier and client_id are required.");
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) throw new OAuthError("invalid_grant", "Invalid code_verifier.");
    const row = await prisma.oAuthAuthorizationCode.findUnique({ where: { codeHash: sha256Hex(code) } });
    if (!row || row.clientId !== clientId) throw new OAuthError("invalid_grant", "Invalid or expired code.");
    if (row.usedAt) {
      // RFC 6749 §4.1.2: a replayed code revokes what it was exchanged for.
      if (row.grantId) await revokeGrant(prisma, row.grantId, "authorization code replayed", { actorId: "oauth-server", actorType: "SYSTEM" }, cfg);
      throw new OAuthError("invalid_grant", "Code already used.");
    }
    if (row.expiresAt <= now) throw new OAuthError("invalid_grant", "Code expired.");
    if (redirectUri && redirectUri !== row.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri doesn't match.");
    if (!safeEqual(pkceChallenge(verifier), row.codeChallenge)) throw new OAuthError("invalid_grant", "PKCE verification failed.");
    // Single use, race-safe: only one request can flip usedAt from null.
    const claimed = await prisma.oAuthAuthorizationCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
    if (claimed.count !== 1) throw new OAuthError("invalid_grant", "Code already used.");
    const grant = await prisma.oAuthGrant.create({ data: { clientId: row.clientId, userId: row.userId, scope: row.scope, resource: row.resource, createdAt: now, lastUsedAt: now } });
    await prisma.oAuthAuthorizationCode.update({ where: { id: row.id }, data: { grantId: grant.id } });
    await prisma.oAuthClient.update({ where: { id: row.clientId }, data: { lastUsedAt: now } });
    return issueTokens(prisma, grant.id, row.scope, cfg);
  }

  if (form.grant_type === "refresh_token") {
    const { refresh_token: refresh, client_id: clientId } = form;
    if (!refresh || !clientId) throw new OAuthError("invalid_request", "refresh_token and client_id are required.");
    const row = await prisma.oAuthToken.findUnique({ where: { tokenHash: sha256Hex(refresh) }, include: { grant: true } });
    if (!row || row.kind !== "REFRESH" || row.grant.clientId !== clientId) throw new OAuthError("invalid_grant", "Invalid refresh token.");
    if (row.grant.revokedAt) throw new OAuthError("invalid_grant", "This connection was disconnected — connect again from ChatGPT.");
    if (row.usedAt) {
      await revokeGrant(prisma, row.grantId, "refresh token reused", { actorId: "oauth-server", actorType: "SYSTEM" }, cfg);
      throw new OAuthError("invalid_grant", "Refresh token already used.");
    }
    if (row.expiresAt <= now) throw new OAuthError("invalid_grant", "Refresh token expired — connect again from ChatGPT.");
    let scope = row.scope;
    if (form.scope) {
      const asked = form.scope.split(/\s+/).filter(Boolean);
      const have = new Set(row.scope.split(" "));
      if (asked.some((s) => !have.has(s))) throw new OAuthError("invalid_scope", "Can't widen the scope on refresh.");
      scope = asked.join(" ");
    }
    const claimed = await prisma.oAuthToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
    if (claimed.count !== 1) {
      await revokeGrant(prisma, row.grantId, "refresh token reused", { actorId: "oauth-server", actorType: "SYSTEM" }, cfg);
      throw new OAuthError("invalid_grant", "Refresh token already used.");
    }
    await prisma.oAuthGrant.update({ where: { id: row.grantId }, data: { lastUsedAt: now } });
    return issueTokens(prisma, row.grantId, scope, cfg);
  }

  throw new OAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
}

/** RFC 7009: revoking any token of a grant revokes the grant (always "200 OK"). */
export async function revokeToken(prisma: PrismaClient, tokenValue: string | undefined, cfg: OAuthServerConfig): Promise<void> {
  if (!tokenValue) return;
  const row = await prisma.oAuthToken.findUnique({ where: { tokenHash: sha256Hex(tokenValue) } });
  if (row) await revokeGrant(prisma, row.grantId, "revoked by the client", { actorId: "oauth-client", actorType: "SYSTEM" }, cfg);
}

// ---- resource side ---------------------------------------------------------------------------

export interface VerifiedAccess {
  token: string;
  grantId: string;
  clientId: string;
  userId: string;
  scopes: string[];
  resource: string;
  expiresAt: Date;
}

/** Bearer token → its grant, or null (unknown, expired, revoked, refresh token, wrong audience). */
export async function verifyAccessToken(prisma: PrismaClient, bearer: string | null | undefined, cfg: OAuthServerConfig): Promise<VerifiedAccess | null> {
  if (!bearer || !bearer.startsWith("cs_at_") || bearer.length > 100) return null;
  const row = await prisma.oAuthToken.findUnique({ where: { tokenHash: sha256Hex(bearer) }, include: { grant: true } });
  const now = nowOf(cfg);
  if (!row || row.kind !== "ACCESS" || row.expiresAt <= now || row.grant.revokedAt || row.grant.resource !== cfg.resource) return null;
  // Throttled bookkeeping: lastUsedAt at most once a minute.
  if (!row.grant.lastUsedAt || now.getTime() - row.grant.lastUsedAt.getTime() > 60_000)
    await prisma.oAuthGrant.update({ where: { id: row.grantId }, data: { lastUsedAt: now } });
  return { token: bearer, grantId: row.grantId, clientId: row.grant.clientId, userId: row.grant.userId, scopes: row.scope.split(" ").filter(Boolean), resource: row.grant.resource, expiresAt: row.expiresAt };
}

/** Per-grant rate limit from the audit trail itself (works across serverless instances). */
export async function toolRateLimitExceeded(prisma: PrismaClient, grantId: string, now = new Date()): Promise<string | null> {
  const where = (ms: number) => ({ entityType: "OAuthGrant", entityId: grantId, action: TOOL_CALL_ACTION, createdAt: { gte: new Date(now.getTime() - ms) } });
  if ((await prisma.auditLog.count({ where: where(60_000) })) >= TOOL_CALLS_PER_MINUTE) return "Too many requests this minute — wait a moment and try again.";
  if ((await prisma.auditLog.count({ where: where(86_400_000) })) >= TOOL_CALLS_PER_DAY) return "Daily limit reached for the ChatGPT connector — try again tomorrow.";
  return null;
}

/** Who/what/when + counts. Never the script text (the save path audits that separately). */
export async function recordToolCall(
  prisma: PrismaClient,
  access: Pick<VerifiedAccess, "grantId" | "userId" | "clientId">,
  call: { tool: string; ok: boolean; durationMs: number; summary: Record<string, unknown> },
) {
  await recordAudit(prisma, {
    actor: access.userId,
    actorType: "HUMAN",
    action: TOOL_CALL_ACTION,
    entityType: "OAuthGrant",
    entityId: access.grantId,
    after: { tool: call.tool, ok: call.ok, ...call.summary },
    metadata: { clientId: access.clientId, durationMs: call.durationMs },
  });
}

// ---- settings page ---------------------------------------------------------------------------

export interface ConnectorStatus {
  connected: boolean;
  connections: { grantId: string; clientName: string; connectedAt: Date; lastUsedAt: Date | null; scopes: string[] }[];
  lastUsedAt: Date | null;
  recent: { at: Date; tool: string; ok: boolean; saved: number | null; videos: number | null; message: string | null }[];
}

export async function getConnectorStatus(prisma: PrismaClient, userId: string): Promise<ConnectorStatus> {
  const grants = await prisma.oAuthGrant.findMany({ where: { userId, revokedAt: null }, include: { client: true }, orderBy: { createdAt: "desc" } });
  const now = Date.now();
  const live: typeof grants = [];
  for (const g of grants) {
    const alive = await prisma.oAuthToken.count({ where: { grantId: g.id, kind: "REFRESH", usedAt: null, expiresAt: { gt: new Date(now) } } });
    if (alive > 0) live.push(g);
  }
  const allGrantIds = (await prisma.oAuthGrant.findMany({ where: { userId }, select: { id: true } })).map((g) => g.id);
  const rows = allGrantIds.length
    ? await prisma.auditLog.findMany({ where: { entityType: "OAuthGrant", entityId: { in: allGrantIds }, action: TOOL_CALL_ACTION }, orderBy: { createdAt: "desc" }, take: 15 })
    : [];
  const recent = rows.map((r) => {
    const a = (r.after ?? {}) as Record<string, unknown>;
    return {
      at: r.createdAt,
      tool: String(a.tool ?? "?"),
      ok: a.ok === true,
      saved: typeof a.saved === "number" ? a.saved : null,
      videos: typeof a.videos === "number" ? a.videos : null,
      message: typeof a.error === "string" ? a.error : null,
    };
  });
  const lastUsed = [...live.map((g) => g.lastUsedAt), recent[0]?.at ?? null].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  return {
    connected: live.length > 0,
    connections: live.map((g) => ({ grantId: g.id, clientName: g.client.clientName, connectedAt: g.createdAt, lastUsedAt: g.lastUsedAt, scopes: g.scope.split(" ") })),
    lastUsedAt: lastUsed,
    recent,
  };
}

/** "Disconnect ChatGPT": revokes every live grant of this user (all tokens die with them). */
export async function disconnectConnector(prisma: PrismaClient, userId: string): Promise<number> {
  const grants = await prisma.oAuthGrant.findMany({ where: { userId, revokedAt: null }, select: { id: true } });
  for (const g of grants) await revokeGrant(prisma, g.id, "Disconnected by Chris in Settings", { actorId: userId, actorType: "HUMAN" });
  return grants.length;
}
