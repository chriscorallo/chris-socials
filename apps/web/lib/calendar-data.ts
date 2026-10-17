/**
 * Server-side gather for the Calendar views: turns ScheduleEntry / Publication / Render rows
 * and the posting plan into one flat, serializable list of events (posts + open plan slots)
 * positioned in APP_TIMEZONE. The client components only lay these out.
 */
import {
  prisma,
  FINISHING_EDIT_STATES,
  generatePlanSlots,
  matchSlotsToSchedule,
  groupSlots,
  minutesInTz,
  startOfDayInTz,
  ymdInTz,
  COURSE_THRESHOLDS,
  type PostingPlanData,
} from "@chris/domain";

export type EventStatus = "scheduled" | "publishing" | "published" | "failed" | "missed" | "draft" | "slot";

export interface CalEvent {
  id: string;
  kind: "post" | "slot";
  status: EventStatus;
  contentItemId: string | null;
  title: string;
  ymd: string;
  startMin: number;
  iso: string;
  platforms: string[];
  state: string | null;
  canReschedule: boolean;
  canEdit: boolean;
  /** Storage key of the latest successful render (served by /api/media). */
  thumbKey: string | null;
  links: { platform: string; url: string }[];
  note: string | null;
  suggestion: { contentItemId: string; title: string } | null;
}

export interface PoolItem {
  id: string;
  title: string;
  state: string;
}

export const APP_TZ = process.env.APP_TIMEZONE || "America/Los_Angeles";

const RESCHEDULABLE = new Set(["READY", "SCHEDULED"]);
const LIVE = new Set(["PUBLISHED", "MEASURING", "ARCHIVED"]);

export async function loadCalendarEvents(opts: {
  startYmd: string;
  endYmd: string;
  now: Date;
  tz: string;
  plan: PostingPlanData | null;
  readyPool: PoolItem[];
}): Promise<CalEvent[]> {
  const { tz, now } = opts;
  const from = startOfDayInTz(opts.startYmd, tz);
  const to = startOfDayInTz(opts.endYmd, tz);

  // Sequential reads — see /docs/DECISIONS.md's PGlite entries.
  const entries = await prisma.scheduleEntry.findMany({
    where: { scheduledDate: { gte: from, lt: to } },
    include: { contentItem: { select: { id: true, title: true, currentState: true } } },
  });
  const livePubs = await prisma.publication.findMany({
    where: {
      status: { in: ["SUCCESS", "DRAFT"] },
      OR: [{ publishedAt: { gte: from, lt: to } }, { publishedAt: null, createdAt: { gte: from, lt: to } }],
    },
    include: { contentItem: { select: { id: true, title: true, currentState: true } } },
  });
  const ids = [...new Set([...entries.map((e) => e.contentItemId), ...livePubs.map((p) => p.contentItemId)])];
  const allPubs = ids.length
    ? await prisma.publication.findMany({
        where: { contentItemId: { in: ids } },
        orderBy: [{ attempt: "desc" }, { createdAt: "desc" }],
        select: { contentItemId: true, platform: true, status: true, url: true, errorMessage: true, publishedAt: true, createdAt: true },
      })
    : [];
  const renders = ids.length
    ? await prisma.render.findMany({
        where: { contentItemId: { in: ids }, status: "SUCCESS", storageKey: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { contentItemId: true, storageKey: true },
      })
    : [];
  const thumbBy = new Map<string, string>();
  for (const r of renders) if (!thumbBy.has(r.contentItemId) && r.storageKey) thumbBy.set(r.contentItemId, r.storageKey);

  // Per item: live publications (earliest time + platforms + links), latest-attempt failures.
  const latest = new Map<string, (typeof allPubs)[number]>();
  const live = new Map<string, { at: Date; platforms: Set<string>; links: { platform: string; url: string }[] }>();
  for (const p of allPubs) {
    const k = `${p.contentItemId}:${p.platform}`;
    if (!latest.has(k)) latest.set(k, p);
    if (p.status === "SUCCESS" || p.status === "DRAFT") {
      const at = p.publishedAt ?? p.createdAt;
      const cur = live.get(p.contentItemId) ?? { at, platforms: new Set<string>(), links: [] };
      if (at < cur.at) cur.at = at;
      cur.platforms.add(p.platform);
      if (p.url && !cur.links.some((l) => l.platform === p.platform)) cur.links.push({ platform: p.platform, url: p.url });
      live.set(p.contentItemId, cur);
    }
  }
  const failuresBy = new Map<string, { platform: string; message: string | null }[]>();
  for (const p of latest.values()) {
    if (p.status !== "FAILED") continue;
    failuresBy.set(p.contentItemId, [...(failuresBy.get(p.contentItemId) ?? []), { platform: p.platform, message: p.errorMessage }]);
  }

  const events: CalEvent[] = [];
  const seen = new Set<string>();
  const base = (id: string, title: string, state: string, at: Date) => ({
    contentItemId: id,
    title,
    state,
    ymd: ymdInTz(at, tz),
    startMin: minutesInTz(at, tz),
    iso: at.toISOString(),
    canReschedule: RESCHEDULABLE.has(state),
    canEdit: FINISHING_EDIT_STATES.has(state as never),
    thumbKey: thumbBy.get(id) ?? null,
    suggestion: null,
  });

  // Published (anywhere) → at its publish time.
  for (const p of livePubs) {
    if (seen.has(p.contentItemId)) continue;
    const l = live.get(p.contentItemId)!;
    if (l.at < from || l.at >= to) continue;
    seen.add(p.contentItemId);
    const fails = failuresBy.get(p.contentItemId) ?? [];
    events.push({
      id: `pub:${p.contentItemId}`,
      kind: "post",
      status: "published",
      platforms: [...l.platforms],
      links: l.links,
      note: fails.length ? `Failed on ${fails.map((f) => f.platform).join(", ")}${fails[0]!.message ? ` — ${fails[0]!.message}` : ""}` : null,
      ...base(p.contentItemId, p.contentItem.title, p.contentItem.currentState, l.at),
    });
  }

  // Scheduled / failed / missed / not-ready-yet → at the ScheduleEntry date.
  const missedBefore = now.getTime() - COURSE_THRESHOLDS.missedGraceMinutes * 60000;
  for (const e of entries) {
    if (seen.has(e.contentItemId) || live.has(e.contentItemId)) continue;
    const state = e.contentItem.currentState;
    if (state === "CANCELLED") continue;
    seen.add(e.contentItemId);
    const fails = failuresBy.get(e.contentItemId) ?? [];
    let status: EventStatus;
    if (fails.length) status = "failed";
    else if (state === "PUBLISHING") status = "publishing";
    else if (state === "SCHEDULED") status = e.scheduledDate.getTime() < missedBefore ? "missed" : "scheduled";
    else if (LIVE.has(state)) status = "published";
    else status = "draft";
    events.push({
      id: `sched:${e.contentItemId}`,
      kind: "post",
      status,
      platforms: (e.targetPlatforms as string[]) ?? [],
      links: [],
      note: fails.length
        ? `${fails.map((f) => f.platform).join(", ")} failed${fails[0]!.message ? `: ${fails[0]!.message}` : ""}`
        : status === "draft"
          ? "Dated on the calendar but not finished yet."
          : status === "missed"
            ? "Its time passed without publishing."
            : null,
      ...base(e.contentItemId, e.contentItem.title, state, e.scheduledDate),
    });
  }

  // Open posting-plan slots (future only), one per local time, with a READY suggestion.
  if (opts.plan) {
    const slots = generatePlanSlots(opts.plan, from < now ? now : from, to);
    const posts = events
      .filter((ev) => ev.kind === "post" && ev.status !== "missed")
      .map((ev) => ({ id: ev.id, at: new Date(ev.iso), platforms: ev.platforms }));
    const { matches } = matchSlotsToSchedule(slots, posts, { tz: opts.plan.timezone });
    const groups = groupSlots(matches.filter((m) => !m.filledBy).map((m) => m.slot));
    groups.forEach((g, i) => {
      const r = opts.readyPool[i] ?? null;
      events.push({
        id: g.key,
        kind: "slot",
        status: "slot",
        contentItemId: null,
        title: "Open slot",
        ymd: g.ymd,
        startMin: minutesInTz(g.at, tz),
        iso: g.at.toISOString(),
        platforms: g.platforms,
        state: null,
        canReschedule: false,
        canEdit: false,
        thumbKey: null,
        links: [],
        note: null,
        suggestion: r ? { contentItemId: r.id, title: r.title } : null,
      });
    });
  }

  events.sort((a, b) => a.iso.localeCompare(b.iso) || (a.kind === "slot" ? 1 : 0) - (b.kind === "slot" ? 1 : 0));
  return events;
}

/** Items Autopilot could push toward an open slot when nothing is READY — most finished first. */
export async function loadAutopilotCandidates(limit = 4): Promise<PoolItem[]> {
  const order = ["QC_REPAIR", "RENDERED", "EDITING", "EDIT_PLANNED", "TAKE_SELECTED", "MEDIA_INGESTED", "SCRIPTED", "SCRIPTING", "RESEARCHED", "RESEARCHING", "CONTRACTED", "SELECTED"] as const;
  const rows = await prisma.contentItem.findMany({
    where: { currentState: { in: [...order] }, scheduleEntry: null },
    select: { id: true, title: true, currentState: true },
  });
  return rows
    .sort((a, b) => order.indexOf(a.currentState as (typeof order)[number]) - order.indexOf(b.currentState as (typeof order)[number]))
    .slice(0, limit)
    .map((r) => ({ id: r.id, title: r.title, state: r.currentState }));
}
