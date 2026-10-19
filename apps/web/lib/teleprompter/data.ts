import type { PrismaClient } from "@chris/domain";
import { listPlannedVideos, ymdInTz, addDaysYmd, getOpenRecordingSession, listOpenRecordingDrafts, draftLabel } from "@chris/domain";
import { PRE_FILM_STATES } from "@chris/domain/plan-import";
import { pickPrompterSource, splitPlanDescription, type PrompterSource } from "./script-source";

/**
 * Server-side reads for the teleprompter (read-only; no AI, no writes). The prompter itself
 * never changes the video — only "Use this take" does, through the normal upload plumbing.
 */

export interface PrompterVideo {
  id: string;
  title: string;
  state: string;
  source: PrompterSource;
  /** Not filmed yet (or filmed with no footage) → a take can land here. */
  canFilm: boolean;
  takes: number;
}

/** States a prompter take may be uploaded into (pre-film + FILMED, as the plan board allows). */
export function prompterCanFilm(state: string): boolean {
  return PRE_FILM_STATES.has(state as never) || state === "FILMED" || state === "MEDIA_INGESTED" || state === "TAKE_SELECTED";
}

export async function loadPrompterVideo(prisma: PrismaClient, id: string): Promise<PrompterVideo | null> {
  const item = await prisma.contentItem.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      description: true,
      currentState: true,
      creatorCard: { select: { hook: true, talkingPoints: true, notes: true } },
      scriptVersions: { orderBy: { createdAt: "desc" }, take: 1, select: { spokenScript: true, authorType: true } },
      _count: { select: { scriptVersions: true, mediaAssets: { where: { kind: "RAW_TAKE", removedAt: null } } } },
    },
  });
  if (!item) return null;
  return {
    id: item.id,
    title: item.title,
    state: item.currentState,
    source: pickPrompterSource({
      scriptVersions: item.scriptVersions,
      scriptVersionCount: item._count.scriptVersions,
      creatorCard: item.creatorCard,
      description: item.description,
    }),
    canFilm: prompterCanFilm(item.currentState),
    takes: item._count.mediaAssets,
  };
}

/** One recorded segment of a draft, as the prompter shows it. */
export interface DraftSegmentInfo {
  id: string;
  /** The client key the segment was uploaded under. */
  key: string;
  index: number;
  seconds: number;
  /** Playable URL of the uploaded segment (for "Preview"). */
  url: string;
  scriptStart: number | null;
  scriptEnd: number | null;
}

/** An open recording draft (docs/decisions-pending/segmented-recording-drafts.md). */
export interface PrompterDraft {
  recordingSessionId: string;
  contentItemId: string;
  scriptPosition: number;
  scriptFingerprint: string | null;
  segments: DraftSegmentInfo[];
  updatedAt: string;
}

export async function loadPrompterDraft(prisma: PrismaClient, contentItemId: string): Promise<PrompterDraft | null> {
  const s = await getOpenRecordingSession(prisma, contentItemId);
  if (!s) return null;
  return {
    recordingSessionId: s.id,
    contentItemId: s.contentItemId,
    scriptPosition: s.scriptPosition,
    scriptFingerprint: s.scriptFingerprint,
    updatedAt: s.updatedAt.toISOString(),
    segments: s.segments
      .filter((g) => g.mediaAsset)
      .map((g) => ({
        id: g.id,
        key: g.clientKey,
        index: g.segmentIndex,
        seconds: g.mediaAsset!.durationSeconds ?? g.durationSeconds ?? 0,
        url: `/api/media/${g.mediaAsset!.storageKey}`,
        scriptStart: g.scriptPositionStart,
        scriptEnd: g.scriptPositionEnd,
      })),
  };
}

export interface PrompterDraftPick {
  id: string;
  title: string;
  label: string;
}

/** "Continue: …" — every video with an open recording draft, most recently touched first. */
export async function listPrompterDraftPicks(prisma: PrismaClient): Promise<PrompterDraftPick[]> {
  const drafts = await listOpenRecordingDrafts(prisma);
  if (drafts.length === 0) return [];
  const items = await prisma.contentItem.findMany({ where: { id: { in: drafts.map((d) => d.contentItemId) } }, select: { id: true, title: true } });
  return drafts.flatMap((d) => {
    const it = items.find((i) => i.id === d.contentItemId);
    return it ? [{ id: it.id, title: it.title, label: draftLabel(d) }] : [];
  });
}

export interface PrompterPick {
  id: string;
  title: string;
  /** "Today", "Tue Oct 20", or null for undated videos. */
  when: string | null;
  ymd: string | null;
  hook: string | null;
  hasScript: boolean;
}

/**
 * "Which video are you filming?" — planned videos not filmed yet (from a week back, so a
 * behind-schedule one is still there), soonest first; then undated videos that are ready to
 * film (script done). Capped so the list stays a phone-sized choice.
 */
export async function listPrompterPicks(prisma: PrismaClient, tz: string, limit = 40): Promise<PrompterPick[]> {
  const today = ymdInTz(new Date(), tz);
  const planned = (await listPlannedVideos(prisma, { tz })).filter((v) => PRE_FILM_STATES.has(v.state) && v.ymd >= addDaysYmd(today, -7));
  const plannedIds = new Set(planned.map((v) => v.id));
  const undated = await prisma.contentItem.findMany({
    where: { currentState: { in: ["SCRIPTED", "READY_TO_FILM"] }, scheduleEntry: null },
    select: { id: true, title: true, description: true },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  const scripted = new Set(
    (
      await prisma.scriptVersion.findMany({
        where: { contentItemId: { in: [...planned.map((v) => v.id), ...undated.map((u) => u.id)] } },
        select: { contentItemId: true },
        distinct: ["contentItemId"],
      })
    ).map((s) => s.contentItemId),
  );
  const fmt = (ymd: string) => {
    if (ymd === today) return "Today";
    if (ymd === addDaysYmd(today, 1)) return "Tomorrow";
    const d = new Date(`${ymd}T12:00:00Z`);
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  };
  const picks: PrompterPick[] = planned.map((v) => ({
    id: v.id,
    title: v.title,
    when: fmt(v.ymd),
    ymd: v.ymd,
    hook: splitPlanDescription(v.description).hook,
    hasScript: scripted.has(v.id),
  }));
  for (const u of undated) {
    if (plannedIds.has(u.id)) continue;
    picks.push({ id: u.id, title: u.title, when: null, ymd: null, hook: splitPlanDescription(u.description).hook, hasScript: scripted.has(u.id) });
  }
  return picks.slice(0, limit);
}
