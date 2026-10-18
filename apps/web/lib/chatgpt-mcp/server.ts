import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  prisma,
  getReferenceStyleProfile,
  getOwnSpeechProfile,
  verifyAccessToken,
  toolRateLimitExceeded,
  recordToolCall,
  resourceMetadataUrl,
  listVideosNeedingScripts,
  getConnectorVideo,
  saveConnectorScripts,
  getActivePlanContext,
  SCOPE_READ,
  SCOPE_WRITE,
  MAX_LIST_BATCH,
  DEFAULT_LIST_BATCH,
  MAX_SAVE_ITEMS,
  type OAuthServerConfig,
  type VerifiedAccess,
} from "@chris/domain";
import { ownPaceWpm, scriptStyleFrom } from "@chris/domain/script-import";
import { getVoiceSamplesText } from "@chris/agents";
import { CORS_HEADERS, connectorConfig, connectorEnabled, disabledResponse } from "./config";

/**
 * The MCP server ChatGPT connects to (Streamable HTTP, stateless — a fresh server + transport per
 * request, JSON responses, so it runs in a plain Vercel Function). Every request carries an
 * OAuth access token issued by this app (connector-oauth.ts); no token → 401 with the RFC 9728
 * resource-metadata pointer, which is how ChatGPT discovers where to sign in.
 * Tools: list_videos_needing_scripts, get_video (read-only), save_scripts (write, never
 * destructive: new versions only). No model calls — ChatGPT does the writing on Chris's plan.
 * See docs/decisions-pending/chatgpt-connector.md.
 */

export const SERVER_INFO = { name: "chris-studio", version: "1.0.0" };

export const SERVER_INSTRUCTIONS =
  "Chris Studio is Chris Corallo's video planner. Use it when Chris asks to write or save scripts for his planned short-form videos. " +
  "Typical flow: call list_videos_needing_scripts, write each script in Chris's voice using the returned scriptRules and everything planned in this conversation, " +
  "then call save_scripts with the scripts. Relay save_scripts' summary and any per-video messages to Chris in plain words.";

const TZ = process.env.APP_TIMEZONE || "America/Los_Angeles";

async function styleContext() {
  const style = scriptStyleFrom(await getReferenceStyleProfile(prisma, { group: "MAIN" }));
  const own = ownPaceWpm(await getOwnSpeechProfile(prisma));
  return { style, wpm: own ?? style.wpm };
}

function result(structured: Record<string, unknown>, text?: string): CallToolResult {
  return { structuredContent: structured, content: [{ type: "text", text: text ?? JSON.stringify(structured) }] };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Scope check + rate limit + audit around every tool. */
async function guarded(
  access: VerifiedAccess,
  tool: string,
  scope: string,
  run: () => Promise<{ result: CallToolResult; summary: Record<string, unknown> }>,
): Promise<CallToolResult> {
  const started = Date.now();
  if (!access.scopes.includes(scope)) {
    await recordToolCall(prisma, access, { tool, ok: false, durationMs: 0, summary: { error: `missing scope ${scope}` } });
    return errorResult(`This connection wasn't given permission for that (${scope}). Disconnect and connect Chris Studio again in ChatGPT.`);
  }
  const limited = await toolRateLimitExceeded(prisma, access.grantId);
  if (limited) {
    await recordToolCall(prisma, access, { tool, ok: false, durationMs: 0, summary: { error: "rate limited" } });
    return errorResult(limited);
  }
  try {
    const out = await run();
    await recordToolCall(prisma, access, { tool, ok: !out.result.isError, durationMs: Date.now() - started, summary: out.summary });
    return out.result;
  } catch (err) {
    const message = err instanceof z.ZodError ? `Invalid arguments: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` : err instanceof Error ? err.message : String(err);
    await recordToolCall(prisma, access, { tool, ok: false, durationMs: Date.now() - started, summary: { error: message.slice(0, 300) } });
    return errorResult(message);
  }
}

/** Plan-context text sent to ChatGPT per call (tool results should stay well under ChatGPT's size limits). */
const PLAN_CONTEXT_DEFAULT_CHARS = 40_000;
const PLAN_CONTEXT_MAX_CHARS = 80_000;

const SECURITY = (scopes: string[]) => ({ securitySchemes: [{ type: "oauth2", scopes }] });

export function createMcpServer(access: VerifiedAccess): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "list_videos_needing_scripts",
    {
      title: "List planned videos that need scripts",
      description:
        "Returns Chris's planned (not yet filmed) short-form videos in date order, soonest first, with each video's id, 4-character code, date, title, hook idea and notes, " +
        "plus his style targets (words per minute, length, hook length, measured from his reference videos) and scriptRules (his brand, voice, format and the [CHECK] facts rule). " +
        `Use it before writing scripts. By default only videos without a script are returned, ${DEFAULT_LIST_BATCH} at a time (max ${MAX_LIST_BATCH}); call again after saving to get the next batch. Read-only.`,
      inputSchema: {
        batchSize: z.number().int().min(1).max(MAX_LIST_BATCH).optional().describe(`How many videos (default ${DEFAULT_LIST_BATCH}, max ${MAX_LIST_BATCH}).`),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Earliest planned date, YYYY-MM-DD (default: a week ago, so overdue videos come first)."),
        includeWithScripts: z.boolean().optional().describe("Also include videos that already have a script (for rewrites). Default false."),
        offset: z.number().int().min(0).optional().describe("Skip this many matching videos (paging). Default 0."),
      },
      annotations: { title: "List videos needing scripts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: SECURITY([SCOPE_READ]),
    },
    async (args) =>
      guarded(access, "list_videos_needing_scripts", SCOPE_READ, async () => {
        const { style } = await styleContext();
        const r = await listVideosNeedingScripts(prisma, args, { tz: TZ, style, voiceSamples: getVoiceSamplesText() });
        const lines = r.videos.map((v) => `- ${v.date} · ${v.code} · ${v.title}${v.hasScript ? " (has a script)" : ""}`).join("\n");
        const text = `${r.videos.length} of ${r.totalMatching} videos (${r.remainingAfterThisBatch} more after these).\n${lines}\n\nFull details as JSON:\n${JSON.stringify(r)}`;
        return { result: result({ ...r }, text), summary: { videos: r.videos.length, totalMatching: r.totalMatching } };
      }),
  );

  server.registerTool(
    "get_video",
    {
      title: "Get one planned video",
      description:
        "Returns one planned video by videoId or its 4-character code: date, title, hook idea, notes, status, and its latest saved script (if any). Use it when Chris wants to revise a specific video's script. Read-only.",
      inputSchema: {
        videoId: z.string().max(100).optional().describe("The video's id from list_videos_needing_scripts."),
        code: z.string().max(12).optional().describe("The video's 4-character code, e.g. K3F9."),
      },
      annotations: { title: "Get video", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: SECURITY([SCOPE_READ]),
    },
    async (args) =>
      guarded(access, "get_video", SCOPE_READ, async () => {
        const r = await getConnectorVideo(prisma, args, { tz: TZ });
        return { result: r.found ? result({ ...r }) : errorResult(r.message), summary: { found: r.found } };
      }),
  );

  server.registerTool(
    "save_scripts",
    {
      title: "Save scripts to Chris Studio",
      description:
        "Saves scripts Chris asked for onto his planned videos in Chris Studio, where he reads them in the teleprompter. Each script is added as a new version; nothing is ever deleted or overwritten. " +
        "Identify each video by videoId (preferred) or code from list_videos_needing_scripts. `script` is every word Chris says, starting with the hook line; keep [CHECK] after every specific number, rate, limit, date or rule. " +
        "A video that already has a script is skipped unless replace is true — only set replace when Chris has said to replace that video's script (the old version stays in the history). " +
        `Up to ${MAX_SAVE_ITEMS} scripts per call. Returns a per-video result to tell Chris (saved, already saved, needs his OK to replace, not found).`,
      inputSchema: {
        scripts: z
          .array(
            z.object({
              videoId: z.string().max(100).optional().describe("The video's id (preferred)."),
              code: z.string().max(12).optional().describe("The video's 4-character code, if no id."),
              hook: z.string().max(600).describe("The first line Chris says."),
              script: z.string().max(12000).describe("Every word Chris says, starting with the hook line, as plain paragraphs. No headings, stage directions, emoji or hashtags."),
              onScreen: z.array(z.string().max(300)).max(20).optional().describe("Optional short text overlays."),
              cta: z.string().max(600).optional().describe("Optional closing line, only if it isn't already the script's last line."),
              replace: z.boolean().optional().describe("Only true when Chris said to replace this video's existing script. Default false."),
            }),
          )
          .min(1)
          .max(MAX_SAVE_ITEMS),
      },
      annotations: { title: "Save scripts", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: SECURITY([SCOPE_WRITE]),
    },
    async (args) =>
      guarded(access, "save_scripts", SCOPE_WRITE, async () => {
        const { style, wpm } = await styleContext();
        const r = await saveConnectorScripts(prisma, args, { actorId: access.userId }, {
          tz: TZ,
          wpm,
          targetSeconds: { min: style.minSeconds, max: style.maxSeconds },
          grantId: access.grantId,
        });
        const lines = r.outcomes.map((o) => `- ${o.title ?? o.code ?? o.videoId ?? "?"}: ${o.status} — ${o.message}`).join("\n");
        const counts: Record<string, number> = {};
        for (const o of r.outcomes) counts[o.status] = (counts[o.status] ?? 0) + 1;
        return { result: result({ ...r }, `${r.summary}\n${lines}`), summary: { items: r.outcomes.length, saved: r.saved, statuses: counts } };
      }),
  );

  server.registerTool(
    "get_plan_context",
    {
      title: "Get Chris's planning conversation",
      description:
        "Returns the planning conversation(s) Chris imported into Chris Studio from ChatGPT (his plan, business model, audience, pillars), as plain text — highlights and the most recent messages first when it has to be shortened. " +
        "Use it when this chat doesn't already contain that planning context. It is for intent and direction only — never a source of facts or statistics. Read-only.",
      inputSchema: {
        maxChars: z.number().int().min(2_000).max(PLAN_CONTEXT_MAX_CHARS).optional().describe(`How much text to return (default ${PLAN_CONTEXT_DEFAULT_CHARS}, max ${PLAN_CONTEXT_MAX_CHARS}).`),
      },
      annotations: { title: "Get planning conversation", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: SECURITY([SCOPE_READ]),
    },
    async (args) =>
      guarded(access, "get_plan_context", SCOPE_READ, async () => {
        const r = await getActivePlanContext(prisma, { maxChars: args.maxChars ?? PLAN_CONTEXT_DEFAULT_CHARS });
        if (r.conversations === 0) {
          return { result: result({ conversations: 0 }, "Chris hasn't imported a planning conversation into Chris Studio yet (Plan → Bring in your ChatGPT conversation). Use this chat's own context."), summary: { conversations: 0 } };
        }
        const head = `${r.conversations} conversation(s): ${r.sources.map((s) => s.title).join(", ")}. ${r.includedMessages} of ${r.totalMessages} messages${r.truncated ? " (shortened — highlights and the most recent first)" : ""}.`;
        return { result: result({ truncated: r.truncated, conversations: r.conversations, includedMessages: r.includedMessages, totalMessages: r.totalMessages, sources: r.sources.map((s) => s.title) }, `${head}\n\n${r.text}`), summary: { conversations: r.conversations, chars: r.chars, truncated: r.truncated } };
      }),
  );

  return server;
}

function bearerOf(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

export function unauthorizedResponse(cfg: OAuthServerConfig, hadToken: boolean): Response {
  const parts = [`resource_metadata="${resourceMetadataUrl(cfg)}"`, `scope="${SCOPE_READ} ${SCOPE_WRITE}"`];
  if (hadToken) parts.unshift(`error="invalid_token"`, `error_description="The access token is missing, expired, revoked or not for this server"`);
  return new Response(JSON.stringify({ error: hadToken ? "invalid_token" : "unauthorized", error_description: "Sign in to Chris Studio to use this connector." }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": `Bearer ${parts.join(", ")}`, ...CORS_HEADERS },
  });
}

/** POST /api/mcp (and GET/DELETE, which a stateless server answers with 405). */
export async function handleMcpRequest(request: Request, cfg: OAuthServerConfig = connectorConfig(request.url)): Promise<Response> {
  if (!connectorEnabled()) return disabledResponse();
  const bearer = bearerOf(request);
  const access = await verifyAccessToken(prisma, bearer, cfg);
  if (!access) return unauthorizedResponse(cfg, !!bearer);
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)." }, id: null }), {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "POST", ...CORS_HEADERS },
    });
  }
  const server = createMcpServer(access);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(request, {
      authInfo: { token: access.token, clientId: access.clientId, scopes: access.scopes, expiresAt: Math.floor(access.expiresAt.getTime() / 1000), resource: new URL(access.resource) },
    });
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    const body = await res.text();
    return new Response(body || null, { status: res.status, headers });
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
