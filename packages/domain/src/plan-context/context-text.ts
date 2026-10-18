import { HIGHLIGHT_LABELS, findHighlights } from "./highlights";
import type { PlanContextMessage } from "./types";

/**
 * The plan conversation as one bounded text block for a model call (the Script agent, the
 * Weekly Strategist, the ChatGPT connector). Deterministic budget: Highlights first (≤ 35% of
 * the budget), then the MOST RECENT messages walking backwards until the budget is spent —
 * shown in chronological order with an explicit "N earlier messages left out" line. Anything
 * cut sets `truncated` so callers can say so honestly.
 */

export interface PlanContextInput {
  title: string;
  importedAt: string | null;
  messages: PlanContextMessage[];
}

export interface PlanContextText {
  text: string;
  truncated: boolean;
  chars: number;
  /** Messages included in full or in part / total, across all conversations. */
  includedMessages: number;
  totalMessages: number;
  conversations: number;
}

const HEADER = `# Chris's planning conversation with ChatGPT (imported by Chris)

Background on his video plan, business and intent, in his own planning chat. Use it for
intent, audience, offers and tone. It is NOT a verified source: never take a fact, number,
statistic or rule from it.`;

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 12)).trimEnd()} …[cut]`;
}

const speaker = (r: PlanContextMessage["role"]) => (r === "user" ? "Chris" : r === "assistant" ? "ChatGPT" : "Pasted");

function dayOf(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

function renderOne(c: PlanContextInput, budget: number): { text: string; truncated: boolean; included: number } {
  let truncated = false;
  const head = `## "${c.title}"${c.importedAt ? ` (imported ${dayOf(c.importedAt)})` : ""} — ${c.messages.length} messages`;
  let remaining = budget - head.length - 2;

  // Highlights first.
  const highlights = findHighlights(c.messages, { perCategory: 1 });
  let hlBlock = "";
  if (highlights.length && remaining > 200) {
    const hlBudget = Math.floor(remaining * 0.35);
    const lines: string[] = [];
    let used = 0;
    const perItem = Math.max(160, Math.floor(hlBudget / highlights.length));
    for (const h of highlights) {
      const line = `- [${HIGHLIGHT_LABELS[h.category]}] ${clip(h.text.replace(/\n{2,}/g, "\n"), perItem - 20)}`;
      if (used + line.length + 1 > hlBudget) {
        truncated = true;
        break;
      }
      if (line.endsWith("…[cut]")) truncated = true;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length) {
      hlBlock = `### Highlights (sections found by their headings)\n${lines.join("\n")}`;
      remaining -= hlBlock.length + 2;
    }
  }

  // Then the most recent messages, newest backwards.
  const picked: string[] = [];
  const convHeaderReserve = 120;
  remaining -= convHeaderReserve;
  let i = c.messages.length - 1;
  for (; i >= 0 && remaining > 80; i--) {
    const m = c.messages[i]!;
    const label = `[${speaker(m.role)}${m.at ? ` · ${dayOf(m.at)}` : ""}] `;
    let body = m.text;
    if (label.length + body.length + 2 > remaining) {
      body = clip(body, remaining - label.length - 2);
      truncated = true;
    }
    const line = label + body;
    picked.unshift(line);
    remaining -= line.length + 2;
  }
  const omitted = i + 1;
  if (omitted > 0) truncated = true;
  const convHead = omitted > 0 ? `### Conversation — the most recent ${picked.length} of ${c.messages.length} messages (${omitted} earlier left out)` : `### Conversation`;
  const parts = [head, hlBlock, convHead, picked.join("\n\n")].filter(Boolean);
  return { text: parts.join("\n\n"), truncated, included: picked.length };
}

/** Newest conversation first; the budget is shared, unused budget rolls to the next one. */
export function buildPlanContextText(contexts: PlanContextInput[], opts: { maxChars: number }): PlanContextText {
  const totalMessages = contexts.reduce((s, c) => s + c.messages.length, 0);
  if (contexts.length === 0 || totalMessages === 0) {
    return { text: "", truncated: false, chars: 0, includedMessages: 0, totalMessages: 0, conversations: 0 };
  }
  const blocks: string[] = [];
  let truncated = false;
  let included = 0;
  let remaining = opts.maxChars - HEADER.length - 2;
  contexts.forEach((c, idx) => {
    const share = Math.floor(remaining / (contexts.length - idx));
    if (share < 300) {
      truncated = true;
      return;
    }
    const r = renderOne(c, share);
    blocks.push(r.text);
    truncated ||= r.truncated;
    included += r.included;
    remaining -= r.text.length + 2;
  });
  let text = [HEADER, ...blocks].join("\n\n");
  if (text.length > opts.maxChars) {
    text = clip(text, opts.maxChars);
    truncated = true;
  }
  return { text, truncated, chars: text.length, includedMessages: included, totalMessages, conversations: blocks.length };
}
