import type { ParsedConversation, PlanContextMessage } from "./types";

/**
 * ChatGPT's official data export (Settings → Data controls → Export data → emailed .zip):
 * `conversations.json` (large accounts: `conversations-000.json`, `-001`, … — same shape) is
 * an array of conversations. Each conversation's messages are a TREE, not a list:
 *
 *   { title, create_time, update_time, conversation_id | id, current_node,
 *     mapping: { [nodeId]: { id, parent, children[], message: null | {
 *       author: { role: "system" | "user" | "assistant" | "tool", … },
 *       create_time (unix seconds) | null, recipient ("all" = shown to Chris),
 *       metadata: { is_visually_hidden_from_conversation?, … },
 *       content: { content_type, parts?: (string | object)[], text?: string } } } } }
 *
 * Editing a message or regenerating a reply leaves the old branch in the tree; what Chris
 * sees in ChatGPT is the path from the root to `current_node`. We walk that path, keep only
 * what was visible (user + assistant text), drop system prompts, custom instructions, memory,
 * hidden reasoning, tool calls/output and browsing noise, and keep timestamps.
 * Pure + browser-safe — the .zip is read in the browser so the (often huge, image-laden)
 * file never uploads.
 */

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Content types that are never part of the visible conversation. */
const DROP_CONTENT_TYPES = new Set([
  "user_editable_context", // custom instructions
  "model_editable_context", // memory
  "thoughts", // hidden reasoning
  "reasoning_recap",
  "system_error",
  "tether_browsing_display",
  "tether_quote",
  "execution_output",
  "computer_output",
  "sonic_webpage",
  "app_pairing_content",
]);

/** ISO from ChatGPT's unix-seconds floats (or ISO strings in some share payloads). */
export function toIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** Strips ChatGPT's inline citation tokens (private-use-area markers and 【…†…】 refs). */
export function cleanChatText(text: string): string {
  return text
    .replace(/\ue200[^\ue201]*\ue201/g, "")
    .replace(/【\d+(?::\d+)?†[^】]*】/g, "")
    .replace(/[\ue200-\ue2ff]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

interface ExtractResult {
  text: string;
  images: number;
}

/** Visible text of one message's `content`; null = not a visible message. */
export function extractContentText(content: unknown): ExtractResult | null {
  if (!isObj(content)) return null;
  const type = str(content.content_type) ?? "text";
  if (DROP_CONTENT_TYPES.has(type)) return null;
  let images = 0;
  const pieces: string[] = [];
  if (type === "code") {
    const t = str(content.text);
    const lang = str(content.language);
    if (t && t.trim()) pieces.push("```" + (lang && lang !== "unknown" ? lang : "") + "\n" + t.trim() + "\n```");
  } else if (Array.isArray(content.parts)) {
    for (const p of content.parts) {
      if (typeof p === "string") {
        if (p.trim()) pieces.push(p);
      } else if (isObj(p)) {
        const pt = str(p.content_type) ?? "";
        if (pt.includes("image")) images += 1;
        else if (pt === "audio_transcription" && str(p.text)) pieces.push(p.text as string);
        else if (pt.includes("audio") || pt.includes("video") || pt.includes("asset")) continue;
        else if (str(p.text)) pieces.push(p.text as string);
      }
    }
  } else if (str(content.text)) {
    pieces.push(content.text as string);
  } else if (str(content.result)) {
    pieces.push(content.result as string);
  }
  const text = cleanChatText(pieces.join("\n\n"));
  if (!text && images === 0) return null;
  return { text, images };
}

interface TreeNode {
  id: string;
  parent: string | null;
  children: string[];
  message: Json | null;
}

function readMapping(mapping: unknown): Map<string, TreeNode> {
  const out = new Map<string, TreeNode>();
  if (!isObj(mapping)) return out;
  for (const [key, raw] of Object.entries(mapping)) {
    if (!isObj(raw)) continue;
    const id = str(raw.id) ?? key;
    out.set(id, {
      id,
      parent: str(raw.parent),
      children: Array.isArray(raw.children) ? raw.children.filter((c): c is string => typeof c === "string") : [],
      message: isObj(raw.message) ? raw.message : null,
    });
  }
  return out;
}

/** Node ids on the visible branch, root → leaf. */
export function activeBranch(mapping: Map<string, TreeNode>, currentNode: string | null): string[] {
  let leaf = currentNode && mapping.has(currentNode) ? currentNode : null;
  if (!leaf) {
    // No usable current_node: from the root, follow the newest child (what ChatGPT shows by
    // default after an edit/regenerate).
    const root = [...mapping.values()].find((n) => !n.parent || !mapping.has(n.parent));
    if (!root) return [];
    let cur: TreeNode | undefined = root;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      leaf = cur.id;
      const kids: TreeNode[] = cur.children.map((c) => mapping.get(c)).filter((n): n is TreeNode => !!n);
      if (kids.length === 0) break;
      kids.sort((a, b) => msgTime(a) - msgTime(b));
      cur = kids[kids.length - 1];
    }
  }
  const path: string[] = [];
  const seen = new Set<string>();
  let id: string | null = leaf;
  while (id && mapping.has(id) && !seen.has(id)) {
    seen.add(id);
    path.push(id);
    id = mapping.get(id)!.parent;
  }
  return path.reverse();
}

function msgTime(n: TreeNode): number {
  const t = n.message?.create_time;
  return typeof t === "number" ? t : 0;
}

function visibleRole(message: Json): "user" | "assistant" | null {
  const author = isObj(message.author) ? message.author : {};
  const role = str(author.role);
  if (role !== "user" && role !== "assistant") return null;
  const meta = isObj(message.metadata) ? message.metadata : {};
  if (meta.is_visually_hidden_from_conversation === true) return null;
  if (meta.is_user_system_message === true) return null;
  // Assistant messages addressed to a tool (python, browser, dalle…) are tool calls.
  const recipient = str(message.recipient);
  if (role === "assistant" && recipient && recipient !== "all") return null;
  return role;
}

/** One conversation object from conversations.json (or a share page's payload). */
export function parseExportConversation(raw: unknown): ParsedConversation | null {
  if (!isObj(raw)) return null;
  const notes: string[] = [];
  const messages: PlanContextMessage[] = [];
  let images = 0;

  if (isObj(raw.mapping)) {
    const mapping = readMapping(raw.mapping);
    const path = activeBranch(mapping, str(raw.current_node));
    const onPath = new Set(path);
    let otherBranch = 0;
    for (const n of mapping.values()) {
      if (!onPath.has(n.id) && n.message && visibleRole(n.message)) otherBranch += 1;
    }
    for (const id of path) {
      const m = mapping.get(id)!.message;
      if (!m) continue;
      const role = visibleRole(m);
      if (!role) continue;
      const got = extractContentText(m.content);
      if (!got) continue;
      images += got.images;
      if (!got.text) continue;
      push(messages, { role, text: got.text, at: toIso(m.create_time) });
    }
    if (otherBranch > 0) notes.push(`${otherBranch} older version${otherBranch === 1 ? "" : "s"} of edited or regenerated messages left out (only what ChatGPT shows now is kept).`);
  } else if (Array.isArray(raw.linear_conversation) || Array.isArray(raw.messages)) {
    // Share-page / older payloads: already a list of { message } or messages.
    const list = (Array.isArray(raw.linear_conversation) ? raw.linear_conversation : raw.messages) as unknown[];
    for (const item of list) {
      const m = isObj(item) && isObj(item.message) ? item.message : isObj(item) ? item : null;
      if (!m) continue;
      const role = visibleRole(m);
      if (!role) continue;
      const got = extractContentText(m.content);
      if (!got) continue;
      images += got.images;
      if (got.text) push(messages, { role, text: got.text, at: toIso(m.create_time) });
    }
  } else {
    return null;
  }

  if (images > 0) notes.push(`${images} image${images === 1 ? "" : "s"} left out (text only).`);
  const title = (str(raw.title) ?? "").trim() || "Untitled chat";
  return {
    conversationId: str(raw.conversation_id) ?? str(raw.id),
    title,
    createdAt: toIso(raw.create_time),
    updatedAt: toIso(raw.update_time),
    messages,
    notes,
  };
}

/** ChatGPT often splits one answer into several assistant nodes around tool calls — they read
 * as one reply, so consecutive same-role messages are merged. */
function push(list: PlanContextMessage[], m: PlanContextMessage) {
  const last = list[list.length - 1];
  if (last && last.role === m.role && m.role === "assistant") {
    last.text = `${last.text}\n\n${m.text}`;
    return;
  }
  list.push(m);
}

/** conversations.json's parsed JSON → conversations with at least one message, newest first. */
export function parseConversationsJson(data: unknown): ParsedConversation[] {
  const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.conversations) ? data.conversations : isObj(data) ? [data] : [];
  const out: ParsedConversation[] = [];
  for (const raw of list) {
    const c = parseExportConversation(raw);
    if (c && c.messages.length > 0) out.push(c);
  }
  return out.sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""));
}

/** Text of conversations.json → conversations. Throws a plain-English error on bad JSON. */
export function parseConversationsJsonText(text: string): ParsedConversation[] {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\ufeff/, ""));
  } catch {
    throw new Error("That file isn't ChatGPT's conversations.json (it couldn't be read as JSON).");
  }
  return parseConversationsJson(data);
}

/** chat.html (also in the export) embeds the same data as `var jsonData = [...]`. */
export function extractJsonFromChatHtml(html: string): unknown | null {
  const m = /jsonData\s*=\s*/.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const open = html[start];
  if (open !== "[" && open !== "{") return null;
  const end = matchingBracket(html, start);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Index of the bracket closing the one at `start` (string-aware), or -1. */
export function matchingBracket(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (inStr) {
      if (ch === 92) i++; // backslash
      else if (ch === 34) inStr = false;
      continue;
    }
    if (ch === 34) inStr = true;
    else if (ch === 91 || ch === 123) depth++;
    else if (ch === 93 || ch === 125) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Names inside the export zip that hold conversations (any folder; split files too). */
export function isConversationsEntry(name: string): boolean {
  return /(^|\/)conversations(-\d+)?\.json$/i.test(name) && !name.includes("__MACOSX");
}

export function isChatHtmlEntry(name: string): boolean {
  return /(^|\/)chat\.html$/i.test(name) && !name.includes("__MACOSX");
}
