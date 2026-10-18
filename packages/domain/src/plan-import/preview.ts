import { parseHhmm, weekdayOfYmd } from "../tz";
import { PLAN_PLATFORMS, type PlanPlatform } from "../plan-platforms";
import type { PostingPlanData } from "../posting-plan-core";
import { normalizeTitleKey } from "./rows";
import type { PlanDraftRow } from "./types";

/**
 * Preview checks — what the import screen shows before anything is created — and the
 * commit-side helpers (default posting time, idempotency key) the server uses on the exact
 * same rows.
 */

export interface ExistingPlanned {
  title: string;
  ymd: string;
  contentItemId?: string;
}

export type RowStatus = "ok" | "duplicate" | "needsDate" | "needsTitle";

export interface ValidatedRow extends PlanDraftRow {
  status: RowStatus;
  /** For duplicates: the existing item it matches. */
  existingId: string | null;
}

export function dedupeKey(title: string, ymd: string): string {
  return `${normalizeTitleKey(title)}@${ymd}`;
}

/**
 * Marks each row: needs a title / needs a date (must fix or drop), already planned (same
 * title + same day as an existing video, or as an earlier row in this import — skipped by
 * default), or fine.
 */
export function validateRows(rows: PlanDraftRow[], existing: ExistingPlanned[]): ValidatedRow[] {
  const known = new Map(existing.map((e) => [dedupeKey(e.title, e.ymd), e.contentItemId ?? "existing"]));
  const seen = new Set<string>();
  return rows.map((r) => {
    if (!r.title.trim()) return { ...r, status: "needsTitle", existingId: null };
    if (!r.ymd) return { ...r, status: "needsDate", existingId: null };
    const k = dedupeKey(r.title, r.ymd);
    if (known.has(k)) return { ...r, status: "duplicate", existingId: known.get(k)! };
    if (seen.has(k)) return { ...r, status: "duplicate", existingId: null };
    seen.add(k);
    return { ...r, status: "ok", existingId: null };
  });
}

export interface PlanSummary {
  count: number;
  firstYmd: string | null;
  lastYmd: string | null;
  perPlatform: Record<PlanPlatform, number>;
  duplicates: number;
  needsFix: number;
}

/** Counts the rows that will actually be created ("ok"). */
export function summarizeRows(rows: ValidatedRow[]): PlanSummary {
  const ok = rows.filter((r) => r.status === "ok");
  const days = ok.map((r) => r.ymd!).sort();
  const perPlatform = Object.fromEntries(PLAN_PLATFORMS.map((p) => [p, 0])) as Record<PlanPlatform, number>;
  for (const r of ok) for (const p of r.platforms) perPlatform[p]++;
  return {
    count: ok.length,
    firstYmd: days[0] ?? null,
    lastYmd: days[days.length - 1] ?? null,
    perPlatform,
    duplicates: rows.filter((r) => r.status === "duplicate").length,
    needsFix: rows.filter((r) => r.status === "needsDate" || r.status === "needsTitle").length,
  };
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon Oct 20" */
export function formatYmdShort(ymd: string, withWeekday = true): string {
  const [, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const md = `${SHORT_MONTHS[m - 1]} ${d}`;
  return withWeekday ? `${SHORT_DAYS[weekdayOfYmd(ymd)]} ${md}` : md;
}

/** "23 videos over Oct 20 – Nov 19 · TikTok 18 · Reels 15 · Shorts 9" */
export function summaryLine(s: PlanSummary): string {
  if (s.count === 0) return "Nothing to create yet";
  const span =
    s.firstYmd && s.lastYmd
      ? s.firstYmd === s.lastYmd
        ? ` on ${formatYmdShort(s.firstYmd)}`
        : ` over ${formatYmdShort(s.firstYmd, false)} – ${formatYmdShort(s.lastYmd, false)}`
      : "";
  const label: Record<PlanPlatform, string> = { TIKTOK: "TikTok", INSTAGRAM: "Reels", YOUTUBE: "Shorts" };
  const plats = PLAN_PLATFORMS.filter((p) => s.perPlatform[p] > 0).map((p) => `${label[p]} ${s.perPlatform[p]}`);
  return [`${s.count} video${s.count === 1 ? "" : "s"}${span}`, ...plats].join(" · ");
}

/**
 * Posting time for a planned video with no time in the plan: the posting plan's preferred
 * time for the first of its platforms (preferring a cadence that posts on that weekday), else
 * 18:00 — the same default the posting plan itself uses.
 */
export function defaultTimeFor(ymd: string, platforms: PlanPlatform[], plan: Pick<PostingPlanData, "cadences"> | null): string {
  return slotTimesFor(ymd, platforms, plan)[0]!;
}

/** Chris's posting times (4 a day per app) — used when there is no posting plan yet. */
export const DEFAULT_SLOT_TIMES = ["09:00", "12:00", "17:00", "20:00"];

/**
 * The day's posting times for these platforms, sorted: the posting plan's preferred times of
 * the cadences that post that weekday (else any cadence for those platforms), else
 * DEFAULT_SLOT_TIMES.
 */
export function slotTimesFor(ymd: string, platforms: PlanPlatform[], plan: Pick<PostingPlanData, "cadences"> | null): string[] {
  if (plan) {
    const wd = weekdayOfYmd(ymd);
    const cads = plan.cadences.filter((c) => c.enabled && platforms.includes(c.platform) && c.preferredTimes.length);
    const onDay = cads.filter((c) => c.preferredDays.length === 0 || c.preferredDays.includes(wd));
    const times = [...new Set((onDay.length ? onDay : cads).flatMap((c) => c.preferredTimes))].filter((t) => parseHhmm(t) !== null).sort();
    if (times.length) return times;
  }
  return DEFAULT_SLOT_TIMES;
}

/**
 * Times for rows the plan gave no time: several videos on the same day are spread over that
 * day's posting times in order (1st → 09:00, 2nd → 12:00, 3rd → 17:00, 4th → 20:00), skipping
 * times another row that day already asked for; more videos than times cycle round. A plan
 * with 4 videos a day therefore lands exactly on the 4 daily slots.
 */
export function assignDefaultTimes<T extends { ymd: string | null; time: string | null; platforms: PlanPlatform[] }>(
  rows: T[],
  plan: Pick<PostingPlanData, "cadences"> | null,
): (string | null)[] {
  const explicit = new Map<string, Set<string>>();
  for (const r of rows) if (r.ymd && r.time) explicit.set(r.ymd, (explicit.get(r.ymd) ?? new Set()).add(r.time));
  const nth = new Map<string, number>();
  return rows.map((r) => {
    if (r.time || !r.ymd) return r.time;
    const taken = explicit.get(r.ymd) ?? new Set<string>();
    const all = slotTimesFor(r.ymd, r.platforms, plan);
    const free = all.filter((t) => !taken.has(t));
    const pool = free.length ? free : all;
    const k = nth.get(r.ymd) ?? 0;
    nth.set(r.ymd, k + 1);
    return pool[k % pool.length]!;
  });
}

export function enabledPlatformsOf(plan: Pick<PostingPlanData, "cadences"> | null): PlanPlatform[] {
  if (!plan) return [...PLAN_PLATFORMS];
  const on = plan.cadences.filter((c) => c.enabled && c.postsPerWeek > 0).map((c) => c.platform);
  return on.length ? PLAN_PLATFORMS.filter((p) => on.includes(p)) : [...PLAN_PLATFORMS];
}

/** The rows the server actually creates — stable, order-independent JSON for the idempotency hash. */
export interface CommitRow {
  title: string;
  ymd: string;
  time: string | null;
  platforms: PlanPlatform[];
  hook: string | null;
  notes: string | null;
  format: string | null;
  pillar: "SKILL" | "MINDSET" | "LIFESTYLE" | "PASSIONS" | null;
}

export function canonicalCommitRows(rows: CommitRow[]): string {
  const norm = rows
    .map((r) => ({
      t: normalizeTitleKey(r.title),
      d: r.ymd,
      h: r.time ?? "",
      p: [...r.platforms].sort().join(","),
      k: (r.hook ?? "").trim(),
      n: (r.notes ?? "").trim(),
    }))
    .sort((a, b) => (a.d + a.t).localeCompare(b.d + b.t));
  return JSON.stringify(norm);
}

/** The ContentItem description for a planned video: hook + notes as written — never a fake script. */
export function plannedDescription(row: Pick<CommitRow, "hook" | "notes">): string | undefined {
  const parts: string[] = [];
  if (row.hook?.trim()) parts.push(`Hook: ${row.hook.trim()}`);
  if (row.notes?.trim()) parts.push(row.notes.trim());
  return parts.length ? parts.join("\n\n") : undefined;
}
