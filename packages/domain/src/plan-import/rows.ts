import { combineSpecs, resolveDateSpec, specIsRelative, formatTime12, type DateSpec } from "./dates";
import type { PlanPlatform } from "../posting-plan-core";
import type { ParseContext, ParseResult, PlanDraftRow, PlanPillar } from "./types";
import { weekdayOfYmd } from "../tz";
import { formatYmdShort } from "./preview";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** What a parser collects for one row before dates are resolved and defaults applied. */
export interface PartialRow {
  sourceLine: number;
  title: string;
  dateText: string;
  spec: DateSpec | null;
  range?: boolean;
  time: string | null;
  platforms: PlanPlatform[] | null;
  unknownPlatforms: string[];
  hook: string | null;
  notes: string[];
  format: string | null;
  pillarText: string | null;
  inheritedDate?: boolean;
}

export function emptyPartial(sourceLine: number): PartialRow {
  return { sourceLine, title: "", dateText: "", spec: null, time: null, platforms: null, unknownPlatforms: [], hook: null, notes: [], format: null, pillarText: null };
}

const PILLARS: Record<string, PlanPillar> = {
  skill: "SKILL", skills: "SKILL", mindset: "MINDSET", lifestyle: "LIFESTYLE", passion: "PASSIONS", passions: "PASSIONS",
};

export function toPillar(text: string | null): PlanPillar | null {
  if (!text) return null;
  return PILLARS[text.trim().toLowerCase()] ?? null;
}

/** Strips wrapping quotes / markdown emphasis / "Video 3:" style prefixes from a title. */
export function cleanTitle(s: string): string {
  let t = s.replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/^(?:video|post|reel|tiktok|short|idea|episode|ep|clip)\s*#?\d+\s*[:.)\-–—]\s*/i, "");
  t = t.replace(/^[\s:–—|-]+|[\s:–—|-]+$/g, "");
  t = t.replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
  return t;
}

export function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Resolve dates (rolling cursor for bare weekdays), apply defaults, collect warnings. */
export function finalizeRows(partials: PartialRow[], ctx: ParseContext): ParseResult {
  const rows: PlanDraftRow[] = [];
  let cursor: string | null = null;
  let usesRelativeDates = false;
  partials.forEach((p, i) => {
    const warnings: string[] = [];
    const title = cleanTitle(p.title) || (p.hook ? cleanTitle(p.hook).slice(0, 80) : "");
    if (!cleanTitle(p.title)) warnings.push(title ? "No title — used the hook" : "No title");
    const ymd = p.spec ? resolveDateSpec(p.spec, ctx, cursor) : null;
    if (p.spec && specIsRelative(p.spec)) usesRelativeDates = true;
    if (ymd) cursor = ymd;
    if (!p.spec) warnings.push(p.dateText ? `Couldn't read the date "${p.dateText}"` : "No date");
    else if (!ymd) warnings.push(`"${p.dateText}" isn't a real date`);
    if (p.range) warnings.push("Date range — using the first day");
    if (ymd && p.spec?.kind === "absolute" && p.spec.weekday !== undefined && weekdayOfYmd(ymd) !== p.spec.weekday) {
      warnings.push(`The plan says ${DAY_NAMES[p.spec.weekday]}, but ${formatYmdShort(ymd, false)} is a ${DAY_NAMES[weekdayOfYmd(ymd)]} — kept the date`);
    }
    if (p.spec?.kind === "week") warnings.push("Only a week given — set to its first day");
    if (p.inheritedDate) warnings.push("No date on this row — same day as the row above");
    for (const u of p.unknownPlatforms) warnings.push(`${u[0]!.toUpperCase()}${u.slice(1)} isn't connected — ignored`);
    const platforms = p.platforms && p.platforms.length ? p.platforms : ctx.enabledPlatforms;
    const pillar = toPillar(p.pillarText);
    const notes = [...p.notes];
    if (p.pillarText && !pillar) notes.unshift(`Category: ${p.pillarText}`);
    rows.push({
      key: `r${i + 1}`,
      sourceLine: p.sourceLine,
      title,
      dateText: p.dateText.trim(),
      spec: p.spec,
      ymd,
      time: p.time,
      platforms: [...platforms],
      platformsDefaulted: !(p.platforms && p.platforms.length),
      hook: p.hook ? p.hook.replace(/^["“”']+|["“”']+$/g, "").trim() || null : null,
      notes: notes.map((n) => n.trim()).filter(Boolean).join("\n") || null,
      format: p.format?.trim() || null,
      pillar,
      warnings,
    });
  });
  return { rows, usesRelativeDates };
}

/**
 * Re-resolves every row's date for a new context (e.g. Chris changed the plan's start date),
 * keeping his inline edits. Rows whose ymd he set by hand (spec === null) keep that day.
 */
export function reresolveRows(rows: PlanDraftRow[], ctx: ParseContext): PlanDraftRow[] {
  let cursor: string | null = null;
  return rows.map((r) => {
    if (!r.spec) {
      if (r.ymd) cursor = r.ymd;
      return r;
    }
    const ymd = resolveDateSpec(r.spec, ctx, cursor);
    if (ymd) cursor = ymd;
    return { ...r, ymd };
  });
}

export { combineSpecs, formatTime12 };
