## ChatGPT connector (2026-10-17)

Chris planned about 120 videos and his business model in one long ChatGPT conversation. He wants to type something like "write the scripts for the next 15 videos and save them to my app" inside that same conversation, and have it happen with no OpenAI API cost. This entry is to be merged into `/docs/DECISIONS.md` by the integrator.

The decision is a **remote MCP server inside the app** (`/api/mcp`). ChatGPT connects to it as a custom connector, using an **OAuth 2.1 authorization server** that is also inside the app (`/oauth/*`, `/.well-known/*`). Chris's ChatGPT subscription writes the scripts. The app only lists his planned videos and saves what ChatGPT sends, using the same code path as the copy-paste flow ("Scripts from ChatGPT").

## What OpenAI's docs say (checked 2026-10-17)

Sources:
- Help article "Developer mode and MCP apps in ChatGPT": https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt (updated about 2026-10-16)
- https://developers.openai.com/api/docs/guides/custom-mcp-server
- https://developers.openai.com/apps-sdk/build/auth
- https://developers.openai.com/apps-sdk/build/mcp-server
- https://developers.openai.com/apps-sdk/reference
- Custom GPTs: https://help.openai.com/en/articles/8554397-creating-and-editing-gpts and https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq

### Plan requirement (this is the main constraint)

- "Custom MCP server connections and full MCP support are available for ChatGPT **Business and Enterprise/Edu** customers on ChatGPT web."
- "Pro users can connect custom MCP servers with **read/fetch** permissions." Plus is not mentioned.
- On Business, "only admins and owners can create and publish plugins for custom MCP servers."
- So **saving scripts from ChatGPT needs Business (or Enterprise/Edu), with Chris as owner or admin.** On Plus or Pro, the copy-paste screen remains the way to do it.
- The setup page says this plainly.

### UI path

- Current path: chatgpt.com/plugins → **+** → **Add custom MCP server**. Enter a name and description, then the URL, then Authentication **OAuth**. Tick "I understand…", then Create.
- Developer Mode is no longer required.
- Older path, still documented: Settings → Apps → Advanced → Developer mode → Create.
- Adding a server works on the **web only**. After that it works in chats, including on the phone.
- In a chat, Chris picks the app with **@** or from the + menu.

### Transport

- "Expose a streamable HTTP endpoint, typically at `/mcp`."
- We serve **Streamable HTTP, stateless** (one fresh server per request, JSON responses), so it fits a plain Vercel Function.
- GET and DELETE return 405, which is allowed for a stateless server.

### Auth

ChatGPT expects:
- Authorization code with **PKCE S256**.
- RFC 8414 metadata.
- RFC 9728 protected-resource metadata, reached through `WWW-Authenticate: Bearer resource_metadata="…"` on a 401.
- The **`resource` parameter** (RFC 8707) on both the authorize and token requests.
- **`iss` in authorization responses** (RFC 9207).
- **`offline_access`** listed in `scopes_supported`, with refresh tokens issued. Otherwise "ChatGPT may lose access after the original authorization expires".

Client registration:
- **CIMD is preferred.** The client_id is `https://chatgpt.com/oauth/…/client.json`.
- **DCR is still accepted.**

Redirect URIs: `https://chatgpt.com/connector_platform_oauth_redirect`, or `https://chatgpt.com/connector/oauth/{callback_id}`.

### Write tools

- "Tools without [readOnlyHint] are treated as write actions." "Write actions by default require confirmation". The confirmation can be remembered for the rest of that conversation.
- `destructiveHint` means "may delete or overwrite user data". `openWorldHint: false` is for "a bounded private account".
- The hints only change how ChatGPT presents a call: "servers must still enforce their own authorization logic."

### Limits

- **No official response-size limit is documented.** Community reports describe truncation, and roughly 5k tokens across all tool definitions.
- So we keep three small tools, cap a batch at 30, and paginate.

### Known risk

- Business users reported write calls blocked by "OpenAI's safety checks" (community thread, June–July 2026). Plainer tool descriptions partly helped.
- Our descriptions avoid alarming wording, but we can't test this without a real Business workspace.

## Decision

### Tools

There are three tools, and no model call happens anywhere ($0). They are built in `apps/web/lib/chatgpt-mcp/server.ts`. The logic is in `packages/domain/src/chatgpt-connector.ts`.

**`list_videos_needing_scripts`** (read-only; idempotent; openWorld false)
- Arguments: `{batchSize=15 (max 30), from?, includeWithScripts?, offset?}`.
- Returns not-yet-filmed planned videos, soonest first, starting a week back. That is the same window as the Plan banner and `/plan/scripts`.
- Each video has: id, the **same 4-character code** as the copy-paste prompt, date, title, hook idea, notes, and whether it has a script.
- It also returns Chris's live **style targets** from `getReferenceStyleProfile`, and **`scriptRules`**.
- `scriptRules` comes from `scriptWritingRules()`. That is the exact brand, voice, format and `[CHECK]` text that `buildScriptPrompt` uses; the text was extracted, not copied. Output was verified byte-identical, and a test asserts the prompt contains the rules.

**`get_video`** (read-only)
- Looks up a video by id or code.
- Returns its details and the latest script, with an author label and fact-checked yes/no.

**`save_scripts`** (write; `destructiveHint: false`, because it never deletes or overwrites)
- Takes **structured** items: `{videoId|code, hook, script, onScreen?, cta?, replace?}`, up to 30.
- Each item is rendered as one canonical block in the copy-paste format and read by the **same parser**. So `[CHECK]` extraction, hook and CTA joining, and cleaning behave exactly as they do for a paste.
- It is then saved through the **existing** `saveImportedScript`, with a new provenance option:
  - a new `ScriptVersion` with authorType `IMPORTED`, revisionNote "Imported from ChatGPT connector · N claims marked [CHECK]";
  - a `SCRIPT_IMPORTED` audit row with the canonical block, `source: "ChatGPT connector"` and the grant id;
  - an idempotent text hash;
  - never an overwrite;
  - an honest walk to SCRIPTED, with reason "Script saved by ChatGPT through the Chris Studio connector (approved by Chris) — not fact-checked yet…";
  - a contract that is STANDARD/MEDIUM, never the exempt NONE/LOW.
- Matching is by id or code. An unknown id or code gives **not-found**. A code shared by two videos, an id and code that disagree, or two scripts for one video in a single call gives **ambiguous**. A filmed video gives **not-allowed**.
- A video that already has a script gives **needs-confirmation-to-replace**, with a message telling ChatGPT to ask Chris first. It is replaced only with `replace: true`, and the old version is kept.
- Re-sending the same words gives **skipped-duplicate**.
- The result includes a one-line `summary` plus a plain-language message for each item, for ChatGPT to relay to Chris.

**`get_plan_context`** — **not built.** The separate "plan context import" feature hadn't landed on `fix/usable-v1` when this was finished (checked the branch tip, 70d6012). There is a clearly marked `TODO(plan-context)` in `server.ts`, and no model was created, to avoid a conflicting schema.

### Factual gate

- Connector scripts are `IMPORTED` versions with no Claims Gate verdict.
- `isScriptVersionFilmable` refuses them, and the FACTUAL hard gate BLOCKs them exactly like pasted scripts. That BLOCK is covered by `quality-gate-job.test.ts` for IMPORTED; the connector tests assert IMPORTED, no verdict, and filmable false.

### Auth design

The OAuth server is hand-rolled in `packages/domain/src/connector-oauth.ts`. Routes:
- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/api/mcp`
- `/oauth/register`, `/oauth/token`, `/oauth/revoke`
- the `/oauth/authorize` page

What it does:
- **Flows:** authorization code + PKCE **S256 only**. There is no implicit grant, no `plain`, and no client credentials. Only public clients are accepted (`token_endpoint_auth_method: none`); a `client_secret` is rejected.
- **Clients:** DCR (RFC 7591) and **CIMD**. A CIMD document is fetched only from `chatgpt.com`, with redirects refused, a 5 s timeout and a 20 KB cap. It is cached for a day as an `OAuthClient` row, and its `client_id` must equal the URL.
- **Redirect URIs:** must be ChatGPT's two callback forms, or exact URIs from `CHATGPT_CONNECTOR_REDIRECT_URIS`. Loopback is allowed only outside production (for MCP Inspector and local testing).
- If the client or redirect URI is invalid, the authorize page **shows an error and never redirects**. Other errors redirect back with `error`, `state` and `iss`.
- **Consent:** `/oauth/authorize` uses the app's existing Auth.js session.
  - If Chris isn't signed in, the login page now takes a same-site `next` path, validated on the server: it must start with `/`, not `//`, and contain no backslash. After sign-in he returns to the consent screen.
  - The screen lists what is allowed and what isn't. It shows a red warning if the return address isn't chatgpt.com.
  - Visiting the page grants nothing. Only the **Allow** server action creates a code, and it re-validates every parameter. Server actions also get Next's built-in origin check, which guards against CSRF.
- **Tokens:**
  - Opaque random 256-bit values (`cs_at_…`, `cs_rt_…`, `csc_code_…`), stored **only as SHA-256**.
  - Each token carries its own scope (a refresh can narrow it, never widen it).
  - Each token is bound to the resource `${APP_BASE_URL}/api/mcp`. A token is rejected for any other resource, and `resource` is checked at authorize and at token.
  - Access tokens last 1 h. Refresh tokens last 30 days and are **single-use with rotation**.
  - **Reusing a refresh token or replaying a code revokes the whole grant.**
  - Claiming a code or refresh token is race-safe (`updateMany … where usedAt: null`).
  - No signing key is needed, so there is **no new secret**.
- **Scopes:** `plan:read` for the two read tools, `scripts:write` for `save_scripts`, and `offline_access` is advertised. Each tool checks its own scope.
- **Revocation:** "Disconnect ChatGPT" in Settings, plus the RFC 7009 `/oauth/revoke` endpoint. Both revoke grants by setting `revokedAt` and a reason. **Rows are never deleted.**
- **Rate limits:**
  - 30 tool calls per minute and 1,000 per day per grant. These are counted from the audit trail itself, so they hold across serverless instances.
  - 20 dynamic registrations per hour across all clients. DCR is unauthenticated, so this caps junk clients. An attacker could use up the quota and block DCR for an hour, but CIMD still works.
  - Bodies on the unauthenticated endpoints are capped at 16 KB.
- **Audit:**
  - `CHATGPT_TOOL_CALL` is recorded per tool call: who, which tool, ok or error, counts, duration and client. It holds **no script text**; the save path's `SCRIPT_IMPORTED` already keeps the text.
  - Also recorded: `CHATGPT_CONNECTOR_CLIENT_REGISTERED`, `CHATGPT_CONNECTOR_AUTHORIZED` and `CHATGPT_CONNECTOR_REVOKED`, the last with its reason (disconnect, client revoke, refresh reuse, code replay).
- **Kill switch:** `CHATGPT_CONNECTOR=off` makes the metadata, OAuth and MCP endpoints answer 503.
- **Off by default?** No. The connector does nothing until Chris himself approves a client while signed in, and that approval is the opt-in (CLAUDE.md "feature flags for risky behavior": the risky part is gated behind his consent, and the env switch turns it off).
- **CORS:** `*` on the bearer and metadata endpoints. They are cookie-less, and MCP Inspector runs in a browser.

### Threat model

| Threat | Mitigation |
|---|---|
| Anyone on the internet calls `/api/mcp` | 401 without a valid, unexpired, unrevoked access token for this exact resource |
| An attacker registers a client and phishes Chris into approving it | Redirect URIs must be ChatGPT's own callbacks (or loopback, dev only), so a code can't land on the attacker's server. The consent screen names the app and the return host, and warns when it isn't chatgpt.com |
| Code interception | PKCE S256; codes are single-use and last 5 min; a replay revokes the grant |
| A stolen refresh token | Rotation and reuse detection revoke the grant; Disconnect in Settings |
| A database leak | Only SHA-256 hashes of tokens and codes are stored |
| A token replayed against another server (confused deputy) | Audience binding (`resource`) |
| An over-permissive token | Two scopes, checked per tool; refresh can't widen them |
| Write damage from a confused model | No delete or overwrite path exists. A replace needs an explicit flag, ChatGPT's own confirmation dialog, and keeps the old version. Facts stay gated |
| Abuse or volume | Per-grant rate limits; per-call audit |
| SSRF through CIMD | Only `https://chatgpt.com/...`, no redirects, timeout, size cap |
| Login redirect abuse | `next` only accepts a same-site path |

### Libraries and versions

- `@modelcontextprotocol/sdk@1.32.1`, published 2026-10-05 and pinned. It is the v1 maintenance line.
  - Server: `McpServer` + `WebStandardStreamableHTTPServerTransport`.
  - Tests: its client `StreamableHTTPClientTransport` + `OAuthClientProvider`.
- `zod@4.5.4`, the same version already used in packages/domain.
- **Not used:**
  - Vercel's `mcp-handler`. The 2.x line needs the v2 SDK packages; its newest version (2.3.0) was under two weeks old, and 2.2.0 would have meant adopting SDK v2. Its auth helpers only wrap the resource side, and the authorization server still had to be written.
  - An off-the-shelf OAuth server (`oidc-provider` and similar). It would bring a much larger surface: sessions, interactions, JWKS and adapters, all on top of Auth.js. Our server is 5 endpoints with every branch unit-tested. The SDK's own `mcpAuthRouter` is Express-only.

## Alternatives considered

- **Custom GPT with Actions.** OpenAI now says "New GPT creation and publishing are not available on personal ChatGPT accounts, including Free, Go, Plus, and Pro", and custom GPTs are being retired (Enterprise on Dec 11, 2026, other plans "expected to follow"). A GPT also runs as its own chat, not inside his existing planning conversation. Rejected.
- **OpenAI API from the app.** It's billed separately from the subscription, which is the opposite of $0. Rejected (same as the copy-paste decision).
- **No auth, or a static bearer token in the URL.** It exposes write access to production data on a public URL, and ChatGPT's custom MCP UI supports OAuth properly. Rejected.
- **Stateful MCP sessions.** They need shared session storage across functions and give no benefit for three request/response tools.
- **One tool that accepts the copy-paste text.** Structured arguments are more reliable for a model than a formatted blob. The canonical block keeps the parser and provenance identical.

## Reversibility

High.
- Remove:
  - `apps/web/app/api/mcp`, `apps/web/app/oauth`, `apps/web/app/.well-known`, `apps/web/app/settings/chatgpt`, `apps/web/lib/chatgpt-mcp`
  - `packages/domain/src/connector-oauth.ts`, `chatgpt-connector.ts` and their exports
  - the More link and the one-line hint on `/plan/scripts`
- Or set `CHATGPT_CONNECTOR=off` without a deploy of code.
- The migration `20261018010000_chatgpt_connector` only adds tables (`OAuthClient`, `OAuthAuthorizationCode`, `OAuthGrant`, `OAuthToken`). They can stay or be dropped by a later migration.
- Saved scripts are ordinary IMPORTED `ScriptVersion` rows.
- Shared edits are additive:
  - `buildScriptPrompt`'s text was extracted into `scriptWritingRules` / `scriptFormatRules` / `SCRIPT_FACTS_RULES` (output byte-identical).
  - `saveImportedScript` takes an optional `provenance`; it defaults to the paste wording.
  - The login page takes an optional `next`.

## Verified

### Tests (all green)

`pnpm typecheck`, `pnpm lint` and `pnpm test` all pass: 140 files, 1,164 tests. New tests:
- `packages/domain/src/__tests__/connector-oauth.test.ts` (11 tests):
  - metadata, the redirect allow-list and scope parsing;
  - DCR accept and reject cases;
  - CIMD (host-locked, client_id mismatch);
  - never redirecting to an unverified client, and error + `iss` + `state` on redirect;
  - PKCE: a wrong verifier, wrong client, wrong redirect, wrong resource and an expired code are each rejected, and a code replay revokes the grant;
  - hashed storage;
  - refresh rotation, reuse revoking the grant, and no scope widening;
  - expired, wrong-audience, refresh-as-access and revoked tokens;
  - the rate limit, status, and Disconnect keeping its rows;
  - the RFC 7636 test vector.
- `packages/domain/src/__tests__/chatgpt-connector.test.ts` (9 tests):
  - argument schemas, and the rules text matching the prompt;
  - the canonical block;
  - date ordering, batching, offset, includeWithScripts and get_video;
  - save: IMPORTED, provenance, SCRIPTED walk, contract not exempt, not filmable;
  - idempotency, needs-confirmation, replace keeping the old version;
  - not-found, ambiguous, mismatch, duplicate-in-call, filmed and code-collision cases.
- `apps/web/lib/chatgpt-mcp/chatgpt-mcp.test.ts` (3 tests), using the **official SDK client end to end through the real route functions**:
  - an unauthenticated call gets 401 with `resource_metadata`; a bad token gets `invalid_token`;
  - the full flow: discovery → DCR → authorize (PKCE, `resource`) → approve → token;
  - tools/list with the annotations;
  - list → save → duplicate → needs-confirmation → get_video → invalid arguments;
  - per-call audit with no script text;
  - a refresh narrowed to `plan:read` → save_scripts refused;
  - a wrong audience gets 401; Disconnect gets 401.

### Live check

Setup: a throwaway PGlite on port 56544 and `next dev` on port 3917, with 18 planned videos.
- The SDK client ran the full OAuth flow against localhost. Chromium at 393×852 followed the real authorize URL to `/login?next=…`, Chris's email and password brought it back to the consent screen, and **Allow** redirected with `code` + `iss`.
- Tokens came back with a refresh token. The tools showed as 2 read-only and 1 write.
- list returned 15 of 18; save returned "15 saved"; re-save returned skipped-duplicate; changed text returned needs-confirmation-to-replace; the next list returned 3.
- In the app:
  - `/plan` shows "3 videos need a script";
  - the teleprompter shows the script, labeled "Your script (from ChatGPT)";
  - `/settings/chatgpt` shows Connected ✓, last used, and recent activity;
  - Disconnect → the old token gets 401.
- No horizontal overflow on any screen.

### Not verified

These need real ChatGPT and Chris's account:
- whether his plan allows write tools (Business/Enterprise/Edu only, per the docs);
- that ChatGPT accepts this server's metadata, using CIMD or DCR;
- that the redirect URI it uses is on the allow-list (if ChatGPT shows a different one, set `CHATGPT_CONNECTOR_REDIRECT_URIS`);
- the confirmation UX;
- whether OpenAI's safety check lets `save_scripts` through;
- how ChatGPT handles 15 full scripts in one call (fallback: "save them 5 at a time");
- the iPhone experience once it's set up on the web.
