import { prisma, homeGroupFor, nextActionFor, type ContentState, type HomeGroup, type NextAction } from "@chris/domain";
import { APP_TZ } from "./calendar-data";

/** Everything a video card shows: thumbnail source, plain status, the one next action. */
export interface VideoCardData {
  id: string;
  title: string;
  state: ContentState;
  group: HomeGroup;
  next: NextAction;
  /** /api/media URL of the latest good render, else the first take — null = placeholder. */
  thumbUrl: string | null;
  /** "Scheduled for Tue, Oct 21, 9:00 AM" etc. — null when there's nothing time-bound. */
  when: string | null;
  postUrl: string | null;
  updatedAt: Date;
}

export function formatWhen(d: Date): string {
  return d.toLocaleString("en-US", { timeZone: APP_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Loads video cards (newest activity first). One query with small includes. */
export async function loadVideoCards(opts: { states?: ContentState[]; limit?: number } = {}): Promise<VideoCardData[]> {
  const rows = await prisma.contentItem.findMany({
    where: opts.states ? { currentState: { in: opts.states } } : undefined,
    orderBy: { updatedAt: "desc" },
    take: opts.limit,
    select: {
      id: true,
      title: true,
      currentState: true,
      updatedAt: true,
      scheduleEntry: { select: { scheduledDate: true } },
      renders: { where: { status: "SUCCESS", storageKey: { not: null } }, orderBy: { createdAt: "desc" }, take: 1, select: { storageKey: true } },
      mediaAssets: { where: { kind: "RAW_TAKE" }, orderBy: { createdAt: "asc" }, take: 1, select: { storageKey: true } },
      publications: { where: { status: "SUCCESS", url: { not: null } }, orderBy: { createdAt: "desc" }, take: 1, select: { url: true, publishedAt: true } },
    },
  });
  return rows.map((r) => {
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
      next: nextActionFor(r.currentState),
      thumbUrl: key ? `/api/media/${key}` : null,
      when,
      postUrl: pub?.url ?? null,
      updatedAt: r.updatedAt,
    };
  });
}

/** Within "In progress": what's waiting on Chris first, then the most recently touched. */
export function sortInProgress(cards: VideoCardData[]): VideoCardData[] {
  const rank = (c: VideoCardData) => (c.next.kind === "FIX" ? 0 : c.next.needsYou ? 1 : 2);
  return [...cards].sort((a, b) => rank(a) - rank(b) || b.updatedAt.getTime() - a.updatedAt.getTime());
}
