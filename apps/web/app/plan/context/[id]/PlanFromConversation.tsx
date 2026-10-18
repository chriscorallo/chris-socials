"use client";

import Link from "next/link";
import { useState } from "react";
import type { PlanCandidate } from "@chris/domain/plan-context";

type Candidate = PlanCandidate & { when: string };

/** "Update my plan from this conversation": the plan tables/lists found in the chat (same
 * parsers as plan import). Default selection = every part not superseded by a newer draft.
 * Continues to the normal import preview — nothing is created until Chris taps Create there. */
export function PlanFromConversation({ versionId, candidates }: { versionId: string; candidates: Candidate[] }) {
  const [picked, setPicked] = useState<Set<number>>(() => new Set(candidates.filter((c) => c.supersededBy === null).map((c) => c.messageIndex)));
  if (candidates.length === 0) {
    return (
      <section className="panel p-4" data-testid="plan-candidates">
        <p className="eyebrow">Your video plan</p>
        <p className="mt-1 text-[14px] text-[var(--color-text-muted)]">
          No dated video list or table found in this chat. If the plan is there in another shape, copy it and use{" "}
          <Link href="/plan/import" className="text-[var(--color-gold-400)] underline">
            Import plan
          </Link>
          .
        </p>
      </section>
    );
  }
  const rows = candidates.filter((c) => picked.has(c.messageIndex)).reduce((s, c) => s + c.rowCount, 0);
  const href = `/plan/import?context=${encodeURIComponent(versionId)}&m=${[...picked].sort((a, b) => a - b).join(",")}`;
  return (
    <section className="panel flex flex-col gap-3 p-4" data-testid="plan-candidates">
      <div>
        <p className="eyebrow">Your video plan</p>
        <p className="mt-0.5 text-[16px] font-semibold">
          Found {candidates.length} plan{candidates.length === 1 ? "" : "s"} in this chat
        </p>
        <p className="text-[13px] text-[var(--color-text-faint)]">Older drafts that a later answer repeats are unticked. You&apos;ll check every video before anything is added.</p>
      </div>
      <ul className="flex flex-col gap-2">
        {candidates.map((c) => {
          const on = picked.has(c.messageIndex);
          return (
            <li key={c.messageIndex}>
              <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border px-3 py-2.5 ${on ? "border-[var(--color-gold-500)]/70 bg-[var(--color-gold-500)]/[0.06]" : "border-[var(--color-border)]"}`} data-testid="plan-candidate">
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5 shrink-0"
                  checked={on}
                  onChange={() =>
                    setPicked((p) => {
                      const n = new Set(p);
                      if (n.has(c.messageIndex)) n.delete(c.messageIndex);
                      else n.add(c.messageIndex);
                      return n;
                    })
                  }
                />
                <span className="min-w-0">
                  <span className="block text-[14.5px] font-medium">
                    {c.rowCount} videos · {c.when}
                  </span>
                  <span className="block text-[12.5px] text-[var(--color-text-muted)]">
                    {c.kind === "table" ? "Table" : "List"} in message #{c.messageIndex + 1}
                    {c.supersededBy !== null ? ` · older draft of #${c.supersededBy + 1}` : ""}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-[var(--color-text-faint)]">{c.sampleTitles.join(" · ")}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {picked.size > 0 ? (
        <Link href={href} className="btn btn-primary w-full" data-testid="update-plan">
          Update my plan from this conversation ({rows})
        </Link>
      ) : (
        <button type="button" className="btn btn-primary w-full" disabled>
          Tick a plan to continue
        </button>
      )}
    </section>
  );
}
