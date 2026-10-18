import { describe, expect, it, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { prisma, commitPlanImport, approveAuthorization, disconnectConnector, isScriptVersionFilmable, addDaysYmd, ymdInTz } from "@chris/domain";
import { videoCode } from "@chris/domain/script-import";
import { handleMcpRequest } from "./server";
import { connectorConfig } from "./config";
import {
  authorizationServerMetadataResponse,
  protectedResourceMetadataResponse,
  registerResponse,
  revokeResponse,
  tokenResponse,
} from "./oauth-routes";

/**
 * End to end, the way ChatGPT does it: the official MCP SDK client discovers the auth server
 * from the 401, registers (DCR), sends Chris to /oauth/authorize with PKCE, exchanges the code,
 * then lists and calls tools — all through the real route functions (no server needed).
 */

const ORIGIN = "https://studio.test";
const MCP_URL = `${ORIGIN}/api/mcp`;
const REDIRECT = "http://localhost:6274/oauth/callback";
const TZ = "America/Los_Angeles";

const ROUTES: Record<string, (r: Request) => Promise<Response>> = {
  "/.well-known/oauth-protected-resource/api/mcp": protectedResourceMetadataResponse,
  "/.well-known/oauth-protected-resource": protectedResourceMetadataResponse,
  "/.well-known/oauth-authorization-server": authorizationServerMetadataResponse,
  "/oauth/register": registerResponse,
  "/oauth/token": tokenResponse,
  "/oauth/revoke": revokeResponse,
  "/api/mcp": (r) => handleMcpRequest(r),
};

const appFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const req = new Request(input, init);
  const h = ROUTES[new URL(req.url).pathname];
  return h ? h(req) : new Response("not found", { status: 404 });
};

class TestProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  authUrl?: URL;
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "SDK test client", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationMixed) {
    this.info = i;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(t: OAuthTokens) {
    this.saved = t;
  }
  redirectToAuthorization(url: URL) {
    this.authUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

let userId = "";
let videoIds: string[] = [];

beforeAll(async () => {
  delete process.env.APP_BASE_URL;
  userId = (await prisma.user.findFirstOrThrow()).id;
  const tag = Math.random().toString(36).slice(2, 7);
  const ymd = addDaysYmd(ymdInTz(new Date(), TZ), 900); // our own far-future window
  const res = await commitPlanImport(
    prisma,
    { sourceKind: "TEXT", rawInput: `mcp e2e ${tag}`, rows: [1, 2, 3].map((n) => ({ title: `MCP video ${n} ${tag}`, ymd: addDaysYmd(ymd, n), time: null, platforms: ["TIKTOK"], hook: `Hook ${n}`, notes: `Notes ${n}`, format: null, pillar: null })) },
    { actorId: userId },
    { tz: TZ, plan: null },
  );
  const items = await prisma.contentItem.findMany({ where: { planImportId: res.importId }, orderBy: { title: "asc" } });
  videoIds = items.map((i) => i.id);
});

/** Runs the whole OAuth dance with the SDK; returns a connected client. */
async function connectWithOAuth(provider = new TestProvider()) {
  const t1 = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: appFetch });
  const c1 = new Client({ name: "test", version: "1" });
  await expect(c1.connect(t1)).rejects.toBeInstanceOf(UnauthorizedError);
  expect(provider.authUrl).toBeDefined();
  const u = provider.authUrl!;
  expect(u.origin + u.pathname).toBe(`${ORIGIN}/oauth/authorize`);
  expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  expect(u.searchParams.get("resource")).toBe(MCP_URL);
  // Chris, signed in, taps Allow on the consent screen (same function the server action calls).
  const params = Object.fromEntries(u.searchParams);
  const back = new URL(await approveAuthorization(prisma, params, userId, connectorConfig(MCP_URL)));
  expect(back.searchParams.get("iss")).toBe(ORIGIN);
  await t1.finishAuth(back.searchParams.get("code")!);
  expect(provider.saved?.access_token).toMatch(/^cs_at_/);

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: appFetch });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  return { client, provider };
}

describe("ChatGPT connector MCP endpoint", () => {
  it("unauthenticated → 401 with the RFC 9728 resource_metadata pointer; bad token → invalid_token", async () => {
    const res = await appFetch(MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate")!;
    expect(www).toMatch(/^Bearer /);
    expect(www).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`);
    const bad = await appFetch(MCP_URL, { method: "POST", headers: { authorization: "Bearer cs_at_nope", "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const prm = await (await appFetch(`${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`)).json();
    expect(prm).toMatchObject({ resource: MCP_URL, authorization_servers: [ORIGIN] });
    const asm = await (await appFetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json();
    expect(asm.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("full OAuth (DCR + PKCE) → list tools → list videos → save → duplicate → needs confirmation", async () => {
    const { client } = await connectWithOAuth();

    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["get_video", "list_videos_needing_scripts", "save_scripts"]);
    expect(byName.list_videos_needing_scripts!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(byName.get_video!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.save_scripts!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(byName.save_scripts!.inputSchema.properties).toHaveProperty("scripts");

    const listed = await client.callTool({ name: "list_videos_needing_scripts", arguments: { batchSize: 2, from: addDaysYmd(ymdInTz(new Date(), TZ), 900) } });
    const sc = listed.structuredContent as { videos: { videoId: string; code: string; date: string }[]; scriptRules: string; styleTargets: { wordsPerMinute: number } };
    expect(sc.videos.map((v) => v.videoId)).toEqual(videoIds.slice(0, 2));
    expect(sc.videos[0]!.code).toBe(videoCode(videoIds[0]!));
    expect(sc.scriptRules).toContain("[CHECK]");
    expect(sc.styleTargets.wordsPerMinute).toBeGreaterThan(100);

    const save = await client.callTool({
      name: "save_scripts",
      arguments: {
        scripts: [
          { videoId: videoIds[0], hook: "Your bank loves you broke.", script: "Your bank loves you broke. Overdraft fees run about $35 [CHECK]. Turn them off." },
          { code: videoCode(videoIds[1]!), hook: "Stop.", script: "Stop. Read your statement." },
          { videoId: "nope", hook: "x", script: "x" },
        ],
      },
    });
    const out = save.structuredContent as { saved: number; outcomes: { status: string }[]; summary: string };
    expect(out.saved).toBe(2);
    expect(out.outcomes.map((o) => o.status)).toEqual(["saved", "saved", "not-found"]);
    expect((save.content as { text: string }[])[0]!.text).toMatch(/^2 saved/);

    const v = await prisma.scriptVersion.findFirstOrThrow({ where: { contentItemId: videoIds[0] } });
    expect(v.authorType).toBe("IMPORTED");
    expect(v.revisionNote).toMatch(/ChatGPT connector/);
    expect(isScriptVersionFilmable(v).ok).toBe(false); // the factual gate still stands
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: videoIds[0] } })).currentState).toBe("SCRIPTED");

    const again = await client.callTool({ name: "save_scripts", arguments: { scripts: [{ videoId: videoIds[0], hook: "Your bank loves you broke.", script: "Your bank loves you broke. Overdraft fees run about $35 [CHECK]. Turn them off." }] } });
    expect((again.structuredContent as { outcomes: { status: string }[] }).outcomes[0]!.status).toBe("skipped-duplicate");
    const other = await client.callTool({ name: "save_scripts", arguments: { scripts: [{ videoId: videoIds[0], hook: "New.", script: "New. Different words." }] } });
    expect((other.structuredContent as { outcomes: { status: string }[] }).outcomes[0]!.status).toBe("needs-confirmation-to-replace");
    expect(await prisma.scriptVersion.count({ where: { contentItemId: videoIds[0] } })).toBe(1);

    const got = await client.callTool({ name: "get_video", arguments: { code: videoCode(videoIds[0]!) } });
    expect((got.structuredContent as { video: { latestScript: { text: string } } }).video.latestScript.text).toContain("Turn them off.");

    const bad = await client.callTool({ name: "save_scripts", arguments: { scripts: [] } });
    expect(bad.isError).toBe(true);

    // Every tool call is audited with counts only (no script text).
    const calls = await prisma.auditLog.findMany({ where: { action: "CHATGPT_TOOL_CALL", actor: userId }, orderBy: { createdAt: "desc" }, take: 6 });
    expect(calls.some((c) => (c.after as { tool: string; saved?: number }).tool === "save_scripts" && (c.after as { saved?: number }).saved === 2)).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("Overdraft");
    await client.close();
  });

  it("refresh through the token endpoint, scope enforcement, Disconnect → 401", async () => {
    const { client, provider } = await connectWithOAuth();
    const info = provider.info!;
    const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });

    // Wrong PKCE verifier at the HTTP layer.
    const wrong = await appFetch(`${ORIGIN}/oauth/token`, form({ grant_type: "authorization_code", code: "csc_code_x", code_verifier: "a".repeat(43), client_id: info.client_id }));
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe("invalid_grant");

    // Refresh, narrowed to read-only: save_scripts is refused for that token.
    const r = await appFetch(`${ORIGIN}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: provider.saved!.refresh_token!, client_id: info.client_id, scope: "plan:read", resource: MCP_URL }));
    expect(r.status).toBe(200);
    const readOnly = (await r.json()) as OAuthTokens;
    const ro = new TestProvider();
    ro.info = info;
    ro.saved = readOnly;
    const roClient = new Client({ name: "ro", version: "1" });
    await roClient.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: ro, fetch: appFetch }));
    const denied = await roClient.callTool({ name: "save_scripts", arguments: { scripts: [{ videoId: videoIds[2], hook: "h", script: "h words" }] } });
    expect(denied.isError).toBe(true);
    expect(await prisma.scriptVersion.count({ where: { contentItemId: videoIds[2] } })).toBe(0);
    expect((await roClient.callTool({ name: "list_videos_needing_scripts", arguments: {} })).isError).toBeFalsy();

    // Wrong audience: a token for this server is useless at another resource URL.
    const other = await handleMcpRequest(
      new Request("https://elsewhere.test/api/mcp", { method: "POST", headers: { authorization: `Bearer ${readOnly.access_token}`, "content-type": "application/json" }, body: "{}" }),
      { ...connectorConfig(MCP_URL), resource: "https://elsewhere.test/api/mcp" },
    );
    expect(other.status).toBe(401);

    await disconnectConnector(prisma, userId);
    const after = await appFetch(MCP_URL, { method: "POST", headers: { authorization: `Bearer ${readOnly.access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(after.status).toBe(401);
    await client.close().catch(() => {});
    await roClient.close().catch(() => {});
  });
});
