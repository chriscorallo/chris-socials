import { cleanChatText } from "./chatgpt-export";
import type { ParsedConversation, PlanContextMessage, PlanContextRole } from "./types";

/**
 * "Select all in the chat and paste": ChatGPT's web page carries hidden speaker labels that
 * come along in a copy — "You said:" / "ChatGPT said:" on their own lines. Other copies
 * (exporter extensions, Notes, older UIs) use "You:" / "ChatGPT:", "User:" / "Assistant:",
 * markdown headings ("## You") or bold ("**ChatGPT:**"). We split on those when they
 * alternate believably; otherwise the paste is kept as one block (role "unknown") — honest,
 * still searchable and usable as context. UI noise lines ("Copy code", "Thought for 12s",
 * "ChatGPT can make mistakes…") are dropped. Best effort and deterministic.
 */

const USER_WORDS = "you said|you|user|me|chris";
const ASSISTANT_WORDS = "chatgpt said|chatgpt|assistant|gpt(?:-?[0-9o.]+)?|chatgpt [0-9o.]+";

// A marker alone on its line: "You said:", "## ChatGPT", "**You:**", "ChatGPT said:".
const LINE_MARKER = new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:\\*\\*|__)?\\s*(${USER_WORDS}|${ASSISTANT_WORDS})\\s*:?\\s*(?:\\*\\*|__)?\\s*:?\\s*$`, "i");
// A marker that starts a line with text after it: "You: …", "ChatGPT said: …".
const INLINE_MARKER = new RegExp(`^\\s*(?:\\*\\*|__)?(you said|chatgpt said|you|chatgpt|user|assistant)\\s*:\\s*(?:\\*\\*|__)?\\s*(\\S.*)$`, "i");

const NOISE_LINES = [
  /^copy( code)?$/i,
  /^(edit|share|regenerate|read aloud|good response|bad response|more actions)$/i,
  /^thought for \d+\s*(s|sec|seconds|m|min|minutes)?$/i,
  /^(searched the web|searching the web|sources?|reasoned for .*)$/i,
  /^chatgpt can make mistakes\b.*$/i,
  /^is this conversation helpful so far\??$/i,
  /^(4o|4o mini|o1|o3|o4-mini|gpt-4o|gpt-5(\.\d)?( thinking)?)$/i,
];

function roleOf(word: string): PlanContextRole {
  const w = word.toLowerCase().trim();
  return new RegExp(`^(?:${USER_WORDS})$`, "i").test(w) ? "user" : "assistant";
}

export function parsePastedConversation(text: string, title?: string): ParsedConversation {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/[\u200b-\u200d\ufeff]/g, "").split("\n");
  type Seg = { role: PlanContextRole; lines: string[] };
  const segs: Seg[] = [];
  const preamble: string[] = [];
  let cur: Seg | null = null;
  let markers = 0;
  for (const raw of lines) {
    const t = raw.trim();
    if (NOISE_LINES.some((re) => re.test(t))) continue;
    const lm = LINE_MARKER.exec(t);
    const im = lm ? null : INLINE_MARKER.exec(t);
    if (lm || im) {
      markers += 1;
      cur = { role: roleOf((lm ?? im)![1]!), lines: im ? [im[2]!] : [] };
      segs.push(cur);
      continue;
    }
    if (cur) cur.lines.push(raw);
    else preamble.push(raw);
  }

  const roles = segs.map((s) => s.role);
  const alternates = roles.length >= 2 && roles.includes("user") && roles.includes("assistant");
  let messages: PlanContextMessage[];
  const notes: string[] = [];
  if (markers >= 2 && alternates) {
    messages = [];
    const pre = cleanChatText(preamble.join("\n"));
    if (pre) messages.push({ role: "unknown", text: pre, at: null });
    for (const s of segs) {
      const body = cleanChatText(s.lines.join("\n"));
      if (!body) continue;
      const last = messages[messages.length - 1];
      if (last && last.role === s.role) last.text = `${last.text}\n\n${body}`;
      else messages.push({ role: s.role, text: body, at: null });
    }
  } else {
    const body = cleanChatText(lines.filter((l) => !NOISE_LINES.some((re) => re.test(l.trim()))).join("\n"));
    messages = body ? [{ role: "unknown", text: body, at: null }] : [];
    if (body) notes.push("Couldn't tell who said what (no “You said:” / “ChatGPT said:” labels) — kept as one block. It's still searchable and usable.");
  }
  return {
    conversationId: null,
    title: title?.trim() || guessTitle(messages) || "Pasted ChatGPT conversation",
    createdAt: null,
    updatedAt: null,
    messages,
    notes,
  };
}

function guessTitle(messages: PlanContextMessage[]): string | null {
  const first = messages.find((m) => m.role === "user") ?? messages[0];
  if (!first) return null;
  const line = first.text.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!line) return null;
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}
