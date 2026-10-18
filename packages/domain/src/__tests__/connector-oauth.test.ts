import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../prisma";
import {
  approveAuthorization,
  authorizationServerMetadata,
  disconnectConnector,
  exchangeToken,
  getConnectorStatus,
  isAllowedRedirectUri,
  OAuthError,
  parseScopes,
  pkceChallenge,
  protectedResourceMetadata,
  recordToolCall,
  registerClient,
  resolveClient,
  revokeToken,
  sha256Hex,
  toolRateLimitExceeded,
  validateAuthorizeRequest,
  verifyAccessToken,
  TOOL_CALLS_PER_MINUTE,
  type OAuthServerConfig,
} from "../connector-oauth";

const cfg: OAuthServerConfig = { issuer: "https://studio.test", resource: "https://studio.test/api/mcp", allowLoopback: false };
const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

async function userId(): Promise<string> {
  return (await prisma.user.findFirstOrThrow()).id;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function newClient() {
  return registerClient(prisma, { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none" }, cfg);
}

async function codeFor(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const url = await approveAuthorization(
    prisma,
    { response_type: "code", client_id: clientId, redirect_uri: CHATGPT_REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: cfg.resource, ...extra },
    await userId(),
    cfg,
  );
  const u = new URL(url);
  expect(u.origin + u.pathname).toBe(CHATGPT_REDIRECT);
  expect(u.searchParams.get("state")).toBe("st-1");
  expect(u.searchParams.get("iss")).toBe(cfg.issuer);
  return u.searchParams.get("code")!;
}

async function connect() {
  const client = await newClient();
  const { verifier, challenge } = pkce();
  const code = await codeFor(client.client_id, challenge);
  const tokens = await exchangeToken(prisma, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CHATGPT_REDIRECT, resource: cfg.resource }, cfg);
  return { client, tokens, code, verifier };
}

const expectOAuth = async (p: Promise<unknown>, error: string) => {
  await expect(p).rejects.toBeInstanceOf(OAuthError);
  await expect(p).rejects.toMatchObject({ error });
};

describe("connector OAuth: metadata + redirect allow-list", () => {
  it("advertises PKCE S256, public clients, DCR + CIMD, offline_access and iss", () => {
    const m = authorizationServerMetadata(cfg);
    expect(m).toMatchObject({
      issuer: cfg.issuer,
      authorization_endpoint: "https://studio.test/oauth/authorize",
      token_endpoint: "https://studio.test/oauth/token",
      registration_endpoint: "https://studio.test/oauth/register",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(m.scopes_supported).toContain("offline_access");
    expect(protectedResourceMetadata(cfg)).toMatchObject({ resource: cfg.resource, authorization_servers: [cfg.issuer] });
  });

  it("only ChatGPT's callbacks (loopback only when allowed)", () => {
    expect(isAllowedRedirectUri(CHATGPT_REDIRECT, cfg)).toBe(true);
    expect(isAllowedRedirectUri("https://chatgpt.com/connector/oauth/abc_123", cfg)).toBe(true);
    expect(isAllowedRedirectUri("https://chatgpt.com/connector/oauth/../evil", cfg)).toBe(false);
    expect(isAllowedRedirectUri("https://evil.example/cb", cfg)).toBe(false);
    expect(isAllowedRedirectUri("https://chatgpt.com.evil.example/connector_platform_oauth_redirect", cfg)).toBe(false);
    expect(isAllowedRedirectUri("http://localhost:6274/cb", cfg)).toBe(false);
    expect(isAllowedRedirectUri("http://localhost:6274/cb", { ...cfg, allowLoopback: true })).toBe(true);
    expect(isAllowedRedirectUri("https://x.example/cb", { ...cfg, extraRedirectUris: ["https://x.example/cb"] })).toBe(true);
  });

  it("scopes: unknown dropped, empty → read + write", () => {
    expect(parseScopes(null)).toEqual(["plan:read", "scripts:write"]);
    expect(parseScopes("openid email plan:read")).toEqual(["plan:read"]);
    expect(parseScopes("offline_access")).toEqual(["plan:read", "scripts:write", "offline_access"]);
  });
});

describe("connector OAuth: registration + authorize", () => {
  it("DCR accepts a public ChatGPT client and rejects everything else", async () => {
    const c = await newClient();
    expect(c.client_id).toMatch(/^csc_/);
    expect(c.token_endpoint_auth_method).toBe("none");
    await expectOAuth(registerClient(prisma, { redirect_uris: ["https://evil.example/cb"] }, cfg), "invalid_redirect_uri");
    await expectOAuth(registerClient(prisma, { redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "client_secret_basic" }, cfg), "invalid_client_metadata");
    await expectOAuth(registerClient(prisma, { redirect_uris: [CHATGPT_REDIRECT], grant_types: ["client_credentials"] }, cfg), "invalid_client_metadata");
    await expectOAuth(registerClient(prisma, { redirect_uris: [] }, cfg), "invalid_redirect_uri");
    expect(await prisma.auditLog.count({ where: { entityId: c.client_id, action: "CHATGPT_CONNECTOR_CLIENT_REGISTERED" } })).toBe(1);
  });

  it("CIMD: fetches ChatGPT's client document only from chatgpt.com", async () => {
    const id = `https://chatgpt.com/oauth/${Math.random().toString(36).slice(2)}/client.json`;
    const fakeFetch = (async () => new Response(JSON.stringify({ client_id: id, client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT, "https://evil.example/cb"] }))) as unknown as typeof fetch;
    const c = await resolveClient(prisma, id, { ...cfg, fetch: fakeFetch });
    expect(c.redirectUris).toEqual([CHATGPT_REDIRECT]);
    await expectOAuth(resolveClient(prisma, "https://evil.example/client.json", { ...cfg, fetch: fakeFetch }), "invalid_client");
    const mismatch = (async () => new Response(JSON.stringify({ client_id: "other", redirect_uris: [CHATGPT_REDIRECT] }))) as unknown as typeof fetch;
    await expectOAuth(resolveClient(prisma, "https://chatgpt.com/oauth/zzz/client.json", { ...cfg, fetch: mismatch }), "invalid_client");
  });

  it("never redirects to an unverified place; protocol errors go back with error + iss", async () => {
    const c = await newClient();
    const unknown = await validateAuthorizeRequest(prisma, { client_id: "csc_nope", redirect_uri: CHATGPT_REDIRECT }, cfg);
    expect(unknown).toMatchObject({ ok: false, redirect: null });
    const wrongRedirect = await validateAuthorizeRequest(prisma, { client_id: c.client_id, redirect_uri: "https://evil.example/cb", response_type: "code" }, cfg);
    expect(wrongRedirect).toMatchObject({ ok: false, redirect: null });

    const base = { client_id: c.client_id, redirect_uri: CHATGPT_REDIRECT, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256", state: "s" };
    const plain = await validateAuthorizeRequest(prisma, { ...base, code_challenge_method: "plain" }, cfg);
    expect(plain.ok).toBe(false);
    const red = new URL((plain as { redirect: string }).redirect);
    expect(red.searchParams.get("error")).toBe("invalid_request");
    expect(red.searchParams.get("iss")).toBe(cfg.issuer);
    expect(red.searchParams.get("state")).toBe("s");
    expect((await validateAuthorizeRequest(prisma, { ...base, code_challenge: null }, cfg)).ok).toBe(false);
    const target = await validateAuthorizeRequest(prisma, { ...base, resource: "https://other.example/mcp" }, cfg);
    expect(target).toMatchObject({ ok: false, error: "invalid_target" });
    expect((await validateAuthorizeRequest(prisma, base, cfg)).ok).toBe(true);
  });
});

describe("connector OAuth: tokens", () => {
  it("code exchange with PKCE; wrong verifier, wrong client, expired code rejected; replay revokes the grant", async () => {
    const client = await newClient();
    const { verifier, challenge } = pkce();
    const code = await codeFor(client.client_id, challenge);
    const form = { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CHATGPT_REDIRECT };
    await expectOAuth(exchangeToken(prisma, { ...form, code_verifier: pkce().verifier }, cfg), "invalid_grant");
    await expectOAuth(exchangeToken(prisma, { ...form, client_id: "csc_other" }, cfg), "invalid_grant");
    await expectOAuth(exchangeToken(prisma, { ...form, redirect_uri: "https://chatgpt.com/connector/oauth/x" }, cfg), "invalid_grant");
    await expectOAuth(exchangeToken(prisma, { ...form, resource: "https://other.example/mcp" }, cfg), "invalid_target");

    const tokens = await exchangeToken(prisma, form, cfg);
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "plan:read scripts:write" });
    expect(tokens.access_token).toMatch(/^cs_at_/);
    // Stored only as hashes.
    expect(await prisma.oAuthToken.count({ where: { tokenHash: tokens.access_token } })).toBe(0);
    expect(await prisma.oAuthToken.count({ where: { tokenHash: sha256Hex(tokens.access_token) } })).toBe(1);
    const access = await verifyAccessToken(prisma, tokens.access_token, cfg);
    expect(access).toMatchObject({ clientId: client.client_id, scopes: ["plan:read", "scripts:write"], resource: cfg.resource });

    await expectOAuth(exchangeToken(prisma, form, cfg), "invalid_grant"); // replay
    expect(await verifyAccessToken(prisma, tokens.access_token, cfg)).toBeNull(); // grant revoked

    const { verifier: v2, challenge: c2 } = pkce();
    const late = await codeFor(client.client_id, c2);
    const later = { ...cfg, now: () => new Date(Date.now() + 6 * 60_000) };
    await expectOAuth(exchangeToken(prisma, { ...form, code: late, code_verifier: v2 }, later), "invalid_grant");
  });

  it("refresh rotates; reusing an old refresh token revokes everything; no scope widening", async () => {
    const { client, tokens } = await connect();
    const r1 = await exchangeToken(prisma, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }, cfg);
    expect(r1.access_token).not.toBe(tokens.access_token);
    expect(await verifyAccessToken(prisma, r1.access_token, cfg)).not.toBeNull();
    await expectOAuth(exchangeToken(prisma, { grant_type: "refresh_token", refresh_token: r1.refresh_token, client_id: "csc_other" }, cfg), "invalid_grant");
    await expectOAuth(exchangeToken(prisma, { grant_type: "refresh_token", refresh_token: r1.refresh_token, client_id: client.client_id, scope: "plan:read admin" }, cfg), "invalid_scope");
    const narrowed = await exchangeToken(prisma, { grant_type: "refresh_token", refresh_token: r1.refresh_token, client_id: client.client_id, scope: "plan:read" }, cfg);
    expect(narrowed.scope).toBe("plan:read");

    await expectOAuth(exchangeToken(prisma, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }, cfg), "invalid_grant");
    expect(await verifyAccessToken(prisma, narrowed.access_token, cfg)).toBeNull();
    await expectOAuth(exchangeToken(prisma, { grant_type: "refresh_token", refresh_token: narrowed.refresh_token, client_id: client.client_id }, cfg), "invalid_grant");
  });

  it("access tokens: expired, wrong audience, refresh-as-access and revoked are all rejected", async () => {
    const { tokens } = await connect();
    expect(await verifyAccessToken(prisma, tokens.access_token, { ...cfg, now: () => new Date(Date.now() + 3601_000) })).toBeNull();
    expect(await verifyAccessToken(prisma, tokens.access_token, { ...cfg, resource: "https://other.example/api/mcp" })).toBeNull();
    expect(await verifyAccessToken(prisma, tokens.refresh_token, cfg)).toBeNull();
    expect(await verifyAccessToken(prisma, "cs_at_garbage", cfg)).toBeNull();
    expect(await verifyAccessToken(prisma, tokens.access_token, cfg)).not.toBeNull();
    await revokeToken(prisma, tokens.refresh_token, cfg);
    expect(await verifyAccessToken(prisma, tokens.access_token, cfg)).toBeNull();
    await expectOAuth(exchangeToken(prisma, { grant_type: "client_credentials" }, cfg), "unsupported_grant_type");
  });

  it("status, rate limit and Disconnect", async () => {
    const { tokens } = await connect();
    const uid = await userId();
    const access = (await verifyAccessToken(prisma, tokens.access_token, cfg))!;
    const st = await getConnectorStatus(prisma, uid);
    expect(st.connected).toBe(true);

    expect(await toolRateLimitExceeded(prisma, access.grantId)).toBeNull();
    for (let i = 0; i < TOOL_CALLS_PER_MINUTE; i++) await recordToolCall(prisma, access, { tool: "get_video", ok: true, durationMs: 1, summary: {} });
    expect(await toolRateLimitExceeded(prisma, access.grantId)).toMatch(/Too many/);
    expect((await getConnectorStatus(prisma, uid)).recent[0]).toMatchObject({ tool: "get_video", ok: true });

    expect(await disconnectConnector(prisma, uid)).toBeGreaterThanOrEqual(1);
    expect(await verifyAccessToken(prisma, tokens.access_token, cfg)).toBeNull();
    expect((await getConnectorStatus(prisma, uid)).connected).toBe(false);
    const grant = await prisma.oAuthGrant.findUniqueOrThrow({ where: { id: access.grantId } });
    expect(grant.revokedReason).toBe("Disconnected by Chris in Settings");
    expect(await prisma.oAuthToken.count({ where: { grantId: access.grantId } })).toBeGreaterThan(0); // kept, not deleted
  });

  it("pkceChallenge is RFC 7636 S256 (appendix B vector)", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
