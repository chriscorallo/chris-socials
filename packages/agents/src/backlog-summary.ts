/** Shared shape both the Creative Director and Weekly Strategist agents read the current
 * ideas backlog through — kept independent of @chris/domain's ContentItem type so this
 * package's public functions stay easy to call with plain data in tests. */
export interface BacklogItemSummary {
  id: string;
  title: string;
  description?: string | null;
  pillar?: string | null;
  format?: string | null;
}

export function formatBacklog(backlog: BacklogItemSummary[]): string {
  if (backlog.length === 0) return "(backlog is empty)";
  return backlog
    .map(
      (i) =>
        `- [${i.id}] ${i.title}${i.pillar ? ` (${i.pillar})` : ""} — ${i.description ?? "no description"}`,
    )
    .join("\n");
}
