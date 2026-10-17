import Link from "next/link";
import { dueLabel, type CourseResult, type Nudge } from "@chris/domain";
import { scheduleFromNudge, dismissNudgeAction } from "./actions";
import { SubmitButton } from "../components/SubmitButton";
import { PLATFORM_COLOR, PLATFORM_NAME } from "./calendar-ui";

// Server-rendered nudge UI shared by the Calendar's Stay-on-course panel, /todo, and the Home
// card. Every row: severity dot, one-line title, short detail, a single primary action, and
// "Not today" (dismiss until tomorrow).

const SEVERITY_COLOR = {
  critical: "var(--color-rose-400)",
  warn: "var(--color-gold-400)",
  info: "var(--color-violet-400)",
} as const;

export function NudgeRow({ nudge, now, tz, back, compact = false }: { nudge: Nudge; now: Date; tz: string; back: string; compact?: boolean }) {
  const due = dueLabel(nudge.due, now, tz);
  const a = nudge.action;
  return (
    <li className="flex gap-3 py-3 first:pt-1 last:pb-1">
      <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full" style={{ background: SEVERITY_COLOR[nudge.severity] }} aria-label={nudge.severity} />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium leading-snug sm:text-[14px]">{nudge.title}</p>
        {!compact && nudge.detail && <p className="mt-0.5 text-[13.5px] leading-snug text-[var(--color-text-muted)] sm:text-[13px]">{nudge.detail}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {a?.kind === "schedule" && (
            <form action={scheduleFromNudge}>
              <input type="hidden" name="contentItemId" value={a.contentItemId} />
              <input type="hidden" name="atIso" value={a.atIso} />
              <input type="hidden" name="back" value={back} />
              {a.platforms.map((p) => (
                <input key={p} type="hidden" name="platforms" value={p} />
              ))}
              <SubmitButton className="btn btn-primary !min-h-[36px] !px-3.5 !text-[13px]" pendingLabel="Scheduling…">
                {a.label}
              </SubmitButton>
            </form>
          )}
          {a?.kind === "link" && (
            <Link href={a.href} className="btn btn-ghost !min-h-[36px] !px-3.5 !text-[13px]">
              {a.label}
            </Link>
          )}
          {due && (
            <span className={`text-[12.5px] ${due.includes("overdue") || due.startsWith("Overdue") || due.startsWith("Since") ? "text-[var(--color-rose-400)]" : "text-[var(--color-text-faint)]"}`}>
              {due}
            </span>
          )}
          {a?.kind === "schedule" && (
            <span className="inline-flex items-center gap-1">
              {a.platforms.map((p) => (
                <span key={p} className="h-1.5 w-1.5 rounded-full" style={{ background: PLATFORM_COLOR[p] }} title={PLATFORM_NAME[p]} />
              ))}
            </span>
          )}
          <form action={dismissNudgeAction} className="ml-auto">
            <input type="hidden" name="key" value={nudge.key} />
            <button type="submit" className="min-h-[36px] rounded-full px-2.5 text-[12.5px] text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] active:opacity-60">
              Not today
            </button>
          </form>
        </div>
      </div>
    </li>
  );
}

const STATUS_META = {
  ON_TRACK: { label: "On track", color: "var(--color-emerald-400)" },
  BEHIND: { label: "Behind", color: "var(--color-gold-400)" },
  AT_RISK: { label: "At risk", color: "var(--color-rose-400)" },
  NO_PLAN: { label: "No plan", color: "var(--color-text-muted)" },
} as const;

export function CourseStatusPill({ status }: { status: CourseResult["status"] }) {
  const m = STATUS_META[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold uppercase tracking-wide"
      style={{ color: m.color, background: `color-mix(in srgb, ${m.color} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${m.color} 30%, transparent)` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}

/** Planned-vs-filled bars per platform for one week. */
export function CoverageBars({ week }: { week: CourseResult["weeks"][number] }) {
  return (
    <div>
      <p className="mb-2 flex items-baseline justify-between text-[13px]">
        <span className="font-semibold">{week.label}</span>
        <span className="text-[var(--color-text-faint)]">
          {week.filled}/{week.planned} filled{week.published ? ` · ${week.published} live` : ""}
          {week.missed ? <span className="text-[var(--color-rose-400)]"> · {week.missed} missed</span> : null}
        </span>
      </p>
      <div className="flex flex-col gap-1.5">
        {week.platforms.map((p) => (
          <div key={p.platform} className="flex items-center gap-2">
            <span className="w-[52px] shrink-0 text-[12px] text-[var(--color-text-muted)]">{PLATFORM_NAME[p.platform]}</span>
            <div className="flex h-[10px] flex-1 gap-[3px]">
              {Array.from({ length: p.planned }, (_, i) => {
                const kind = i < p.published ? "live" : i < p.filled ? "sched" : i < p.filled + p.missed ? "missed" : "open";
                const bg =
                  kind === "live"
                    ? "var(--color-emerald-400)"
                    : kind === "sched"
                      ? "var(--color-violet-400)"
                      : kind === "missed"
                        ? "color-mix(in srgb, var(--color-rose-500) 55%, transparent)"
                        : "rgba(255,255,255,0.08)";
                return <span key={i} className="flex-1 rounded-[3px]" style={{ background: bg }} />;
              })}
            </div>
            <span className="w-[30px] shrink-0 text-right text-[12px] tabular-nums text-[var(--color-text-faint)]">
              {p.filled}/{p.planned}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
