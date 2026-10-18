## Plan context — bring the ChatGPT planning conversation into the app (2026-10-17)

Chris built his whole 120-video plan and business model in one long ChatGPT conversation and
wants it inside the app ("let me just export it in"): for the in-app Script agent and Weekly
Strategist (when he has credit), for the ChatGPT connector another agent is building (it calls
a domain function), and for his own reference. To be merged into `/docs/DECISIONS.md` by the
integrator.

## Decision 1 — Three sources, all deterministic, $0

`/plan/context` ("Your ChatGPT conversation"; card on `/plan`, "ChatGPT conversation" under
More — `/settings/chatgpt` didn't exist on fix/usable-v1 yet; the connector agent can link
here or fold this in).

1. **Official data export** (Settings → Data Controls → Export Data → emailed .zip). The .zip
   is read **in the browser**: a small dependency-free ZIP reader
   (`packages/domain/src/plan-context/zip.ts`) reads the central directory with `File.slice`
   and decompresses only `conversations.json` (any folder; split `conversations-000.json`…
   files too; ZIP64 sizes/offsets) with `fflate@0.8.2`'s `inflateSync` (pinned, apps/web).
   Photos/audio in the zip are never read or uploaded — a test asserts < 200 KB read from a zip
   carrying a 2 MB image. Also accepts `conversations.json` directly, and `chat.html`
   (`var jsonData = …`, string-aware bracket match) when conversations.json is missing.
   **Format** (researched; OpenAI doesn't document it — third-party write-ups + the shape every
   exporter tool uses): an array of `{title, create_time, update_time, conversation_id|id,
   current_node, mapping: {id: {parent, children[], message: {author.role, create_time,
   recipient, metadata, content: {content_type, parts|text}}}}}`. Messages are a tree; the
   visible chat is the path `current_node → root` (no/unknown `current_node`: follow the
   newest child). Kept: user + assistant text (`text`, `multimodal_text` string parts, audio
   transcriptions, assistant `code` only when addressed to Chris). Dropped: system, custom
   instructions (`user_editable_context`), memory, hidden reasoning (`thoughts`,
   `reasoning_recap`), tool calls (`recipient ≠ all`) and tool output, browsing quotes,
   `is_visually_hidden_from_conversation`, images (counted: "1 image left out"). Consecutive
   assistant pieces (split around tool calls) merge into one reply; citation tokens
   (`cite…`, `【4:0†source】`) are stripped; timestamps kept. Picker: title, date,
   message count, preview, search over titles + text; several chats can be saved.
2. **Share link** (`chatgpt.com/share/<id>`): one server-side fetch (only that host/path, 15 s).
   The public page is React Router SSR streaming turbo-stream chunks
   (`streamController.enqueue("…")`); we decode the flat, index-referenced format and look for
   an object with `mapping` / `linear_conversation`, then reuse the export parser. Probed live:
   a non-existent id returns HTTP 200 with `serverResponse: {type: "error", error:
   "Conversation has been deleted…"}` — shown to Chris verbatim. A real share's payload was
   **not** observed (no public share link to test); if ChatGPT blocks the fetch (Cloudflare) or
   changes the page, the message says so and points to export/paste. No further scraping.
3. **Paste** ("select all in the chat and paste"): ChatGPT's web page carries hidden speaker
   labels that come along in a copy ("You said:" / "ChatGPT said:"); also "You:"/"ChatGPT:",
   "User:"/"Assistant:", `## You`, `**ChatGPT:**`. Split only when ≥ 2 labels alternate
   between both speakers; otherwise one block with role `unknown` and a plain note. UI noise
   ("Copy code", "Thought for 12s", "ChatGPT can make mistakes…") dropped. Optional "Update
   “X” (keeps the old version)".

## Decision 2 — Storage: versioned, idempotent, private (migration `20261017230000_plan_context`)

New tables only: `PlanContext` (title, source, conversationId?, `useForAi` default true) and
append-only `PlanContextVersion` (messages JSON `{role, text, at}[]`, counts, `contentHash`).
Same chat again (ChatGPT conversation id → same share link → explicit paste target) adds a
version unless the normalized content hash matches the latest ("Already saved — nothing
changed"). Latest version is active; older versions viewable. Saved through
`POST /api/plan-context` (a route handler: a long chat exceeds the 1 MB Server Action body
limit; the browser gzips the JSON to stay under Vercel's 4.5 MB request cap; ~3M-char cap).

**Privacy** (docs/SECURITY.md): signed-in pages only; never sent anywhere except model calls
Chris triggers (scripts / weekly plan) and the connector (his own ChatGPT). AuditLog rows
(`PLAN_CONTEXT_IMPORTED`, `PLAN_CONTEXT_AI_USE_CHANGED`, `PLAN_CONTEXT_DELETED`) carry counts,
hashes and titles — never the text. **Delete** purges the text (all versions, cascade) and
keeps the audit trail — the same "purge PII, keep history" rule as media. "Stop using" keeps
it readable but out of every AI context.

## Decision 3 — Useful without AI

- **Readable view** (`/plan/context/[id]`): chat bubbles, long messages folded ("Show all"),
  search with highlighted matches, newest 80 messages first ("Show earlier").
- **Highlights**: sections whose HEADING (markdown `#`, whole-line bold, short "Label:" lines,
  "1. Heading", inline "**Target audience:** …") names business model, audience, offer,
  pillars, posting cadence or monetization; section = heading → next heading of the same or
  higher level (≤ 1 500 chars); newest first, ≤ 3 per category; empty headings ignored. Labelled
  "found by their headings … not an AI summary". Body-text mentions never count (no guessing).
- **"Update my plan from this conversation"**: every message is run through the plan-import
  parsers (markdown tables / pasted cells → `tableToRows`, else `parseFreeText`); a candidate
  needs ≥ 3 titled rows, ≥ 3 and ≥ 50% dated. Chat prose is stripped first
  (`stripChatProse`: non-bullet, non-label, non-dated sentence lines of ≥ 6 words ending in
  `.!?` — found because "That keeps the pillars balanced across the week." parsed as a row).
  ChatGPT revises plans and delivers them week by week, so a candidate whose titles are ≥ 50%
  repeated by a newer one is marked "older draft" and unticked by default. The ticked messages
  go to `/plan/import?context=<versionId>&m=…`, each parsed separately (a table and a list
  can't confuse each other; keys re-prefixed) straight into the existing preview — Chris fixes
  / removes rows and taps Create; `commitPlanImport`'s idempotency and (title, day)
  de-duplication apply unchanged (`sourceKind TEXT`, `sourceRef "ChatGPT conversation: …"`).
  ImportClient change is one optional prop.

## Decision 4 — Domain API + agent context

`getActivePlanContext(prisma, { maxChars })` → `{ text, truncated, chars, includedMessages,
totalMessages, conversations, sources[] }`: every `useForAi` conversation's latest version,
newest first, budget shared (unused rolls over). Per conversation: a header that says it's
background, NOT a verified source; Highlights first (≤ 35% of budget); then the most recent
messages walking backwards, shown chronologically with "the most recent N of M messages (K
earlier left out)"; an oversized message is cut with "…[cut]". `truncated` is true whenever
anything was left out. `getPlanContextForAgent(prisma, "SCRIPT" | "WEEKLY_STRATEGIST")` wraps
it with `PLAN_CONTEXT_BUDGET_CHARS` (6 000 ≈ 1.5K tokens / 12 000 ≈ 3K tokens) and returns
undefined on any error (fail safe).

Wired as **optional** context: `runScriptAgent` / `runWeeklyStrategistAgent` take
`planContext?`, clip it to their budget again (own hard cap) and append it after the brand
context in `stableContext` (provider prompt-cached — it's identical across a pipeline's
draft + revisions, so the repeat cost is cache reads). `runResearchToScriptPipeline` passes it
to every Script call only — never to Research, Claims Gate or Brand Guardian (the factual
gate judges against the Research Packet alone). Callers: `apps/web/lib/content-steps.ts`
(research → script) and `generatePortfolio` (strategy). Prompts: `SCRIPT` and
`WEEKLY_STRATEGIST` → **v1.2.0** (rollback 1.1.0), `required_context` gains
`PlanContext (optional)`, plus a short section: intent only, never facts; Contract / Brand
Constitution / explicit decisions / first-party evidence outrank it; don't guess what was cut.
`docs/AGENT_CONTRACTS.md` updated. No model was called ($0); tests use MockModelProvider.

## Alternatives considered

- **Server-side zip upload**: hundreds of MB over mobile data, and the photos would leave the
  phone — rejected. A streaming server unzip still needs the upload.
- **Whole zip in memory with fflate `unzip`**: simpler, but loads the full file into memory
  on an iPhone; central-directory + slice reads only what's needed.
- **AI summary of the conversation** as the context: costs credit, not deterministic, loses
  his words. A summary could be added later as an optional button; the raw text is the source
  of truth either way.
- **Scraping chatgpt.com with a headless browser / logged-in session**: brittle, against
  ChatGPT's terms, not iPhone-friendly.
- **Storing messages as rows** (one per message): no query needs it; JSON per version keeps
  versions immutable and simple.

## Rationale

Final Test: Chris's real workflow is "talk to ChatGPT". One export (or one paste) puts the
full context where every AI step and he can use it, and the plan inside it reaches the board
through the preview he already knows — without AI credit. Quality: the context is labelled as
intent, never facts, so the factual gate is untouched.

## Reversibility

High. Remove `apps/web/app/plan/context/`, `apps/web/app/api/plan-context/`, the Plan card
and More link, the `fromConversation` prop, `packages/domain/src/plan-context*`, the agent
`planContext` params (prompts roll back to 1.1.0 by flipping the version). The tables are
additive; dropping them loses only the saved conversations.

## Verified / not verified

- Tests: `plan-context-parse.test.ts` (export tree walk incl. edited + regenerated branches,
  hidden/system/custom-instructions/reasoning/tool messages, multimodal parts, missing fields
  & current_node, citation tokens, chat.html, split-file names, zip central-directory read
  without touching media, not-a-zip; paste labels / inline / headings / no labels / false
  positive; share URL recognition, turbo-stream decode of a conversation, ChatGPT's own error,
  blocked page; highlights; plan candidates incl. superseded drafts and prose stripping;
  bounded context text), `plan-context-db.test.ts` (versions, unchanged re-import, paste
  target, share link versions, delete keeps audit without text, `getActivePlanContext` +
  "Stop using", found rows → `commitPlanImport` with no duplicates on repeat),
  `plan-context-agents.test.ts` (Script / Strategist inclusion + budgets, pipeline passes it to
  Script calls only, prompt registry v1.2.0).
- Playwright at 393×852 (throwaway PGlite + dev server on non-default ports): fixture export
  .zip (with a 3 MB fake photo) → pick the planning chat (search) → save → view, Highlights,
  search → "Update my plan from this conversation" → import preview → Create → re-save shows
  "Already saved". Screenshots in `docs/evidence/2026-10-17-plan-context/`.
- Not verified: a real ChatGPT export (the fixture imitates the documented-by-community
  schema), a real share page with a conversation, iOS Safari's file picker with a large zip.
