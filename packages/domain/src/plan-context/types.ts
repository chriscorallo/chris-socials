/** One turn of Chris's planning conversation, as stored. `unknown` = a paste without
 * recognizable "You said:" / "ChatGPT said:" markers. */
export type PlanContextRole = "user" | "assistant" | "unknown";

export interface PlanContextMessage {
  role: PlanContextRole;
  text: string;
  /** ISO timestamp when the source had one (the export does; pastes don't). */
  at: string | null;
}

export type PlanContextSource = "EXPORT" | "CHAT_HTML" | "SHARE_LINK" | "PASTE";

/** A conversation as read from any source, before it's saved. */
export interface ParsedConversation {
  /** ChatGPT's conversation id when the source has it. */
  conversationId: string | null;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  messages: PlanContextMessage[];
  /** Non-fatal notes for Chris ("2 images left out", "3 edited branches skipped"). */
  notes: string[];
}

/** One row of the "pick your planning chat" list. */
export interface ConversationSummary {
  index: number;
  conversationId: string | null;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  charCount: number;
  /** First user message, for the list's preview line. */
  preview: string;
}

export function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

export function conversationStats(messages: PlanContextMessage[]): { messageCount: number; charCount: number; wordCount: number } {
  let charCount = 0;
  let wordCount = 0;
  for (const m of messages) {
    charCount += m.text.length;
    wordCount += countWords(m.text);
  }
  return { messageCount: messages.length, charCount, wordCount };
}

export function summarizeConversation(c: ParsedConversation, index: number): ConversationSummary {
  const firstUser = c.messages.find((m) => m.role === "user") ?? c.messages[0];
  return {
    index,
    conversationId: c.conversationId,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: c.messages.length,
    charCount: conversationStats(c.messages).charCount,
    preview: (firstUser?.text ?? "").replace(/\s+/g, " ").slice(0, 140),
  };
}
