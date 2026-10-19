import { prisma, homeGroupFor, nextActionFor, listOpenRecordingDrafts, type ContentState, type HomeGroup, type NextAction } from "@chris/domain";
import { APP_TZ } from "./calendar-data";
import { thumbUrlFor } from "./media-urls";

/** Everything a video card shows: thumbnail source, plain status, the one next action. */
export interface VideoCardData {
  id: string;
  title: string;
  state: ContentState;
  group: HomeGroup;
  next: NextAction;
  /** Poster (/api/thumb) of the latest good render, else the first take — null = placeholder. */
  thumbUrl: string | null;
  /** "Scheduled for Tue, Oct 21, 9:00 AM" etc. — null when there's nothing time-bound. */
  when: string | null;
  postUrl: string | null;
  updatedAt: Date;
  /** An open teleprompter recording draft ("3 parts · 0:41 filmed"), or null. */
  draft: { parts: number; seconds: number } | null;
}

export function formatWhen(d: Date): string {
  return d.toLocaleString("en-US", { timeZone: APP_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Loads video cards (newest activity first). One query with small includes. */
export async function loadVideoCards(opts: { states?: ContentState[]; limit?: number } = {}): Promise<VideoCardData[]> {
  const rows = await prisma.contentItem.findMany({
    // Deleted (CANCELLED) videos never show in lists.
    where: opts.states ? { currentState: { in: opts.states } } : { currentState: { not: "CANCELLED" } },
    orderBy: { updatedAt: "desc" },
    take: opts.limit,
    select: {
      id: true,
      title: true,
      currentState: true,
      updatedAt: true,
      scheduleEntry: { select: { scheduledDate: true } },
      renders: { where: { status: "SUCCESS", storageKey: { not: null } }, orderBy: { createdAt: "desc" }, take: 1, select: { storageKey: true } },
      mediaAssets: { where: { kind: "RAW_TAKE", removedAt: null }, orderBy: { createdAt: "asc" }, take: 1, select: { storageKey: true } },
      publications: { where: { status: "SUCCESS", url: { not: null } }, orderBy: { createdAt: "desc" }, take: 1, select: { url: true, publishedAt: true } },
    },
  });
  const drafts = new Map((await listOpenRecordingDrafts(prisma, rows.map((r) => r.id))).map((d) => [d.contentItemId, d]));
  return rows.map((r) => {
    const draft = drafts.get(r.id) ?? null;
    const key = r.renders[0]?.storageKey ?? r.mediaAssets[0]?.storageKey ?? null;
    const pub = r.publications[0];
    let when: string | null = null;
    if ((r.currentState === "SCHEDULED" || r.currentState === "READY") && r.scheduleEntry) when = `Scheduled for ${formatWhen(r.scheduleEntry.scheduledDate)}`;
    else if (pub?.publishedAt) when = `Posted ${formatWhen(pub.publishedAt)}`;
    return {
      id: r.id,
      title: r.title,
      state: r.currentState,
      group: homeGroupFor(r.currentState),
      // A discarded recording draft leaves an ingested video with no takes — it needs footage
      // again (same rule as the plan board), not "Edit video".
      next: nextActionFor(r.mediaAssets.length === 0 && (r.currentState === "MEDIA_INGESTED" || r.currentState === "TAKE_SELECTED") ? "FILMED" : r.currentState, draft),
      thumbUrl: key ? thumbUrlFor(key) : null,
      when,
      postUrl: pub?.url ?? null,
      updatedAt: r.updatedAt,
      draft: draft ? { parts: draft.parts, seconds: draft.seconds } : null,
    };
  });
}

/** Within "In progress": what's waiting on Chris first, then the most recently touched. */
export function sortInProgress(cards: VideoCardData[]): VideoCardData[] {
  const rank = (c: VideoCardData) => (c.next.kind === "FIX" ? 0 : c.next.needsYou ? 1 : 2);
  return [...cards].sort((a, b) => rank(a) - rank(b) || b.updatedAt.getTime() - a.updatedAt.getTime());
}
