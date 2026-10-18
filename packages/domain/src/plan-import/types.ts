import type { PlanPlatform } from "../plan-platforms";
import type { DateSpec } from "./dates";

export type PlanPillar = "SKILL" | "MINDSET" | "LIFESTYLE" | "PASSIONS";
export type PlanSourceKind = "CSV" | "XLSX" | "GOOGLE_SHEETS" | "TEXT" | "AI_CLEANUP";

/**
 * One planned video as read from Chris's plan, before anything is created. Everything the
 * preview shows and lets him edit lives here; `spec` is what the date text *said*, `ymd` what
 * it resolved to (null = couldn't tell → must be fixed or dropped before creating).
 */
export interface PlanDraftRow {
  key: string;
  /** 1-based line (text) or row (sheet) number in the source, for "row 14" messages. */
  sourceLine: number;
  title: string;
  dateText: string;
  spec: DateSpec | null;
  ymd: string | null;
  /** "HH:mm" when the plan said; null → posting plan's preferred time at create. */
  time: string | null;
  platforms: PlanPlatform[];
  /** True when the plan didn't name platforms and we used the posting plan's enabled ones. */
  platformsDefaulted: boolean;
  hook: string | null;
  notes: string | null;
  format: string | null;
  pillar: PlanPillar | null;
  /** Human-readable parse problems/notes ("Date range — using Oct 20", "Facebook ignored"). */
  warnings: string[];
}

export interface ParseContext {
  /** "YYYY-MM-DD" in the app's time zone. */
  today: string;
  /** Day 1 / Week 1 for relative plans. Defaults to today. */
  startDate?: string;
  /** Posting plan's enabled platforms — used for "all" and for rows that name none. */
  enabledPlatforms: PlanPlatform[];
}

export interface ParseResult {
  rows: PlanDraftRow[];
  /** True when any row's date depends on the start date (Week 2 / Day 3 / bare weekdays). */
  usesRelativeDates: boolean;
}
