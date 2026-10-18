"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { PlanContextMessage } from "@chris/domain/plan-context";

const LONG = 700;
const PAGE = 80;

function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const j = lower.indexOf(q, i);
    if (j < 0) {
      out.push(text.slice(i));
      break;
    }
    if (j > i) out.push(text.slice(i, j));
    out.push(
      <mark key={k++} className="rounded bg-[var(--color-gold-500)]/40 px-0.5 text-inherit">
        {text.slice(j, j + q.length)}
      </mark>,
    );
    i = j + q.length;
  }
  return out;
}

/** The conversation, readable on a phone: search (matches highlighted), long messages
 * folded, the most recent PAGE messages first with "Show earlier". */
export function ConversationView({ messages }: { messages: PlanContextMessage[] }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? messages.map((m, i) => ({ m, i })).filter(({ m }) => m.text.toLowerCase().includes(q)) : null), [messages, q]);
  const list = matches ?? messages.map((m, i) => ({ m, i })).slice(-shown);
  const hidden = matches ? 0 : Math.max(0, messages.length - shown);

  return (
    <section className="flex flex-col gap-3" data-testid="conversation">
      <div className="panel flex flex-col gap-2 p-4">
        <p className="eyebrow">The conversation</p>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search this chat" className="field-input" data-testid="conversation-search" />
        {matches && (
          <p className="text-[13px] text-[var(--color-text-muted)]" data-testid="search-count">
            {matches.length} message{matches.length === 1 ? "" : "s"} mention “{query.trim()}”
          </p>
        )}
      </div>
      {hidden > 0 && (
        <button type="button" className="btn btn-ghost w-full" onClick={() => setShown((s) => s + PAGE)}>
          Show {Math.min(PAGE, hidden)} earlier ({hidden} not shown)
        </button>
      )}
      <ul className="flex flex-col gap-2.5">
        {list.map(({ m, i }) => {
          const isLong = m.text.length > LONG;
          const expanded = open.has(i) || (!!q && isLong);
          const text = isLong && !expanded ? `${m.text.slice(0, LONG).trimEnd()}…` : m.text;
          const mine = m.role === "user";
          return (
            <li key={i} className={`flex ${mine ? "justify-end" : "justify-start"}`} data-testid="message" data-role={m.role}>
              <div className={`min-w-0 max-w-[92%] rounded-3xl px-4 py-3 ${mine ? "bg-[var(--color-gold-500)]/[0.12]" : "panel"}`}>
                <p className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">
                  {mine ? "You" : m.role === "assistant" ? "ChatGPT" : "Pasted"} · #{i + 1}
                  {m.at ? ` · ${new Date(m.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                </p>
                <p className="whitespace-pre-wrap break-words text-[14.5px] leading-snug">{highlight(text, q)}</p>
                {isLong && !q && (
                  <button
                    type="button"
                    className="mt-1.5 min-h-[36px] text-[13.5px] font-medium text-[var(--color-gold-400)]"
                    onClick={() =>
                      setOpen((s) => {
                        const n = new Set(s);
                        if (n.has(i)) n.delete(i);
                        else n.add(i);
                        return n;
                      })
                    }
                  >
                    {expanded ? "Show less" : `Show all (${Math.round(m.text.length / 6)} words)`}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
