"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import {
  PLAN_PLATFORMS,
  addDaysYmd,
  effectivePostsPerWeek,
  generatePlanSlots,
  groupSlots,
  mondayOfYmd,
  parseHhmm,
  startOfDayInTz,
  type PlatformCadence,
  type PostingPlanData,
} from "@chris/domain/planning";
import { formatMinutes, monthDayLabel } from "../../../lib/calendar-views";
import { PLATFORM_COLOR, PLATFORM_NAME } from "../calendar-ui";
import { savePostingPlanAction } from "../actions";

const DAYS = [
  { d: 1, l: "M" },
  { d: 2, l: "T" },
  { d: 3, l: "W" },
  { d: 4, l: "T" },
  { d: 5, l: "F" },
  { d: 6, l: "S" },
  { d: 0, l: "S" },
];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PLATFORM_FULL: Record<string, string> = { TIKTOK: "TikTok", INSTAGRAM: "Instagram Reels", YOUTUBE: "YouTube Shorts" };

function Stepper({ value, onChange, min, max, label }: { value: number; onChange: (n: number) => void; min: number; max: number; label: string }) {
  return (
    <div className="flex items-center rounded-full border border-[var(--color-border)] bg-white/[0.04]" role="group" aria-label={label}>
      <button type="button" aria-label={`Fewer — ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)} className="flex h-11 w-11 items-center justify-center text-[22px] text-[var(--color-gold-400)] disabled:opacity-30">
        −
      </button>
      <span className="w-8 text-center text-[17px] font-semibold tabular-nums">{value}</span>
      <button type="button" aria-label={`More — ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)} className="flex h-11 w-11 items-center justify-center text-[22px] text-[var(--color-gold-400)] disabled:opacity-30">
        +
      </button>
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors ${on ? "bg-[var(--color-emerald-500)]" : "bg-white/15"}`}
    >
      <span className={`absolute left-0 top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow transition-transform ${on ? "translate-x-[22px]" : "translate-x-[2px]"}`} />
    </button>
  );
}

/** Spread posting times used when Chris raises posts-per-day past the times he picked. */
const DEFAULT_TIMES = ["09:00", "12:00", "17:00", "20:00", "07:30", "14:30", "19:00", "21:30", "11:00", "16:00"];

function postingDays(c: PlatformCadence): number {
  return c.preferredDays.length || 7;
}

function perDay(c: PlatformCadence): number {
  return Math.round(c.postsPerWeek / postingDays(c));
}

/** Sets posts per day (stored as posts per week = per day × posting days) and makes sure there
 * are at least that many distinct times, adding well-spread defaults. */
function withPerDay(c: PlatformCadence, n: number): PlatformCadence {
  const times = [...c.preferredTimes];
  for (const t of DEFAULT_TIMES) {
    if (times.length >= n) break;
    if (!times.includes(t)) times.push(t);
  }
  return { ...c, postsPerWeek: n * postingDays(c), preferredTimes: times.sort() };
}

function CadenceFields({ c, onChange }: { c: PlatformCadence; onChange: (c: PlatformCadence) => void }) {
  const [newTime, setNewTime] = useState("");
  const effective = effectivePostsPerWeek(c);
  const addTime = (t: string) => {
    if (parseHhmm(t) === null || c.preferredTimes.includes(t)) return;
    onChange({ ...c, preferredTimes: [...c.preferredTimes, t].sort() });
    setNewTime("");
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[15px] font-medium">Posts per day</p>
          <p className="text-[12.5px] text-[var(--color-text-faint)]">
            = {c.postsPerWeek} a week{c.preferredDays.length > 0 && c.preferredDays.length < 7 ? ` on ${c.preferredDays.length} days` : ""}
          </p>
          {effective < c.postsPerWeek && (
            <p className="text-[12.5px] text-[var(--color-gold-400)]">Only {effective} fit — add days or times</p>
          )}
        </div>
        <Stepper
          value={perDay(c)}
          onChange={(n) => onChange(withPerDay(c, n))}
          min={0}
          max={10}
          label="posts per day"
        />
      </div>
      <div>
        <p className="mb-2 text-[15px] font-medium">Days</p>
        <div className="grid grid-cols-7 gap-1.5">
          {DAYS.map(({ d, l }) => {
            const on = c.preferredDays.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                aria-label={DAY_NAMES[d]}
                onClick={() => {
                  const pd = perDay(c);
                  const next = { ...c, preferredDays: on ? c.preferredDays.filter((x) => x !== d) : [...c.preferredDays, d].sort() };
                  onChange({ ...next, postsPerWeek: pd * postingDays(next) });
                }}
                className={`flex h-11 items-center justify-center rounded-full text-[15px] font-semibold transition-colors ${
                  on ? "bg-[var(--color-gold-400)] text-[#14100a]" : "border border-[var(--color-border)] bg-white/[0.03] text-[var(--color-text-muted)]"
                }`}
              >
                {l}
              </button>
            );
          })}
        </div>
        {c.preferredDays.length === 0 && <p className="mt-1.5 text-[12.5px] text-[var(--color-text-faint)]">No days picked — posts spread across the whole week.</p>}
      </div>
      <div>
        <p className="mb-2 text-[15px] font-medium">Times</p>
        <div className="flex flex-wrap items-center gap-2">
          {c.preferredTimes.map((t) => (
            <span key={t} className="inline-flex h-10 items-center gap-1 rounded-full border border-[var(--color-gold-500)]/50 bg-[var(--color-gold-500)]/10 pl-3.5 pr-1 text-[14px] font-medium">
              {formatMinutes(parseHhmm(t)!)}
              <button
                type="button"
                aria-label={`Remove ${t}`}
                onClick={() => onChange({ ...c, preferredTimes: c.preferredTimes.filter((x) => x !== t) })}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-text-muted)] active:bg-white/10"
              >
                ×
              </button>
            </span>
          ))}
          <label className="inline-flex h-10 items-center gap-1.5 rounded-full border border-dashed border-[var(--color-border-strong)] pl-3 pr-1.5 text-[14px] text-[var(--color-text-muted)]">
            + Add
            <input
              type="time"
              step={900}
              value={newTime}
              onChange={(e) => setNewTime(e.target.value)}
              onBlur={(e) => addTime(e.target.value)}
              className="w-[96px] bg-transparent text-[16px] text-[var(--color-text)] outline-none"
              aria-label="Add a posting time"
            />
          </label>
          {newTime && (
            <button type="button" onClick={() => addTime(newTime)} className="btn btn-ghost !min-h-[38px] !px-3 !text-[13px]">
              Add {formatMinutes(parseHhmm(newTime) ?? 0)}
            </button>
          )}
        </div>
        {c.preferredTimes.length === 0 && <p className="mt-1.5 text-[12.5px] text-[var(--color-text-faint)]">No times — defaults to 6:00 PM.</p>}
      </div>
    </div>
  );
}

export function PlanEditor({ initial, today, hasPlan }: { initial: PostingPlanData; today: string; hasPlan: boolean }) {
  const [plan, setPlan] = useState<PostingPlanData>(() => ({
    ...initial,
    // Every platform present in the editor, even if an older plan left one out.
    cadences: PLAN_PLATFORMS.map(
      (p) => initial.cadences.find((c) => c.platform === p) ?? { platform: p, enabled: false, postsPerWeek: 28, preferredDays: [], preferredTimes: ["09:00", "12:00", "17:00", "20:00"] },
    ),
  }));
  const [saved, setSaved] = useState<null | "ok" | string>(null);
  const [pending, start] = useTransition();

  const shared = plan.cadences.find((c) => c.enabled) ?? plan.cadences[0]!;
  const setCadence = (platform: string, next: PlatformCadence) => {
    setSaved(null);
    setPlan((p) => ({
      ...p,
      cadences: p.cadences.map((c) =>
        p.sameForAll ? { ...next, platform: c.platform, enabled: c.platform === platform ? next.enabled : c.enabled } : c.platform === platform ? next : c,
      ),
    }));
  };
  const set = (patch: Partial<PostingPlanData>) => {
    setSaved(null);
    setPlan((p) => ({ ...p, ...patch }));
  };

  const previewMonday = addDaysYmd(mondayOfYmd(today), 7);
  const preview = useMemo(() => {
    const slots = generatePlanSlots({ ...plan, startDate: "2000-01-01" }, startOfDayInTz(previewMonday, plan.timezone), startOfDayInTz(addDaysYmd(previewMonday, 7), plan.timezone));
    return { slots, groups: groupSlots(slots) };
  }, [plan, previewMonday]);

  const save = () =>
    start(async () => {
      const r = await savePostingPlanAction(plan);
      setSaved(r.ok ? "ok" : r.error);
    });

  return (
    <div className="flex flex-col gap-4">
      <section className="panel flex items-center justify-between gap-4 p-4 sm:p-5">
        <div>
          <p className="text-[16px] font-semibold">Same schedule for all platforms</p>
          <p className="text-[13px] text-[var(--color-text-muted)]">One set of days and times, posted everywhere that&apos;s on.</p>
        </div>
        <Switch
          on={plan.sameForAll}
          label="Same schedule for all platforms"
          onChange={(v) => {
            setSaved(null);
            setPlan((p) => ({
              ...p,
              sameForAll: v,
              cadences: v ? p.cadences.map((c) => ({ ...shared, platform: c.platform, enabled: c.enabled })) : p.cadences,
            }));
          }}
        />
      </section>

      {plan.sameForAll ? (
        <section className="panel p-4 sm:p-5">
          <p className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">Post on</p>
          <div className="mb-5 grid grid-cols-3 gap-2">
            {plan.cadences.map((c) => (
              <button
                key={c.platform}
                type="button"
                aria-pressed={c.enabled}
                onClick={() => {
                  setSaved(null);
                  setPlan((p) => ({ ...p, cadences: p.cadences.map((x) => (x.platform === c.platform ? { ...x, enabled: !x.enabled } : x)) }));
                }}
                className={`flex min-h-[48px] items-center justify-center gap-2 rounded-xl border text-[14px] font-medium ${
                  c.enabled ? "border-[var(--color-gold-500)]/60 bg-[var(--color-gold-500)]/12" : "border-[var(--color-border)] bg-white/[0.03] text-[var(--color-text-faint)]"
                }`}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: PLATFORM_COLOR[c.platform] }} />
                {PLATFORM_NAME[c.platform]}
              </button>
            ))}
          </div>
          <CadenceFields c={shared} onChange={(n) => setCadence(shared.platform, { ...n, enabled: shared.enabled })} />
        </section>
      ) : (
        plan.cadences.map((c) => (
          <section key={c.platform} className={`panel p-4 sm:p-5 ${c.enabled ? "" : "opacity-80"}`}>
            <div className={`flex items-center justify-between gap-3 ${c.enabled ? "mb-4" : ""}`}>
              <p className="flex items-center gap-2.5 text-[17px] font-semibold">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: PLATFORM_COLOR[c.platform] }} />
                {PLATFORM_FULL[c.platform]}
              </p>
              <Switch on={c.enabled} label={`Post on ${PLATFORM_FULL[c.platform]}`} onChange={(v) => setCadence(c.platform, { ...c, enabled: v })} />
            </div>
            {c.enabled && <CadenceFields c={c} onChange={(n) => setCadence(c.platform, n)} />}
          </section>
        ))
      )}

      <section className="panel p-4 sm:p-5">
        <p className="mb-1 text-[16px] font-semibold">Lead times</p>
        <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">How far ahead of a post you want each step done. Nudges count back from these.</p>
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[15px]">
              Filmed <span className="text-[var(--color-text-muted)]">days before posting</span>
            </p>
            <Stepper value={plan.filmLeadDays} min={0} max={21} label="film lead days" onChange={(n) => set({ filmLeadDays: n, readyLeadDays: Math.min(plan.readyLeadDays, n) })} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[15px]">
              Ready <span className="text-[var(--color-text-muted)]">days before posting</span>
            </p>
            <Stepper value={plan.readyLeadDays} min={0} max={14} label="ready lead days" onChange={(n) => set({ readyLeadDays: n, filmLeadDays: Math.max(plan.filmLeadDays, n) })} />
          </div>
          <label className="flex items-center justify-between gap-3">
            <span className="text-[15px]">
              Plan starts <span className="text-[var(--color-text-muted)]">(no slots before)</span>
            </span>
            <input type="date" value={plan.startDate} onChange={(e) => e.target.value && set({ startDate: e.target.value })} className="field-input !w-auto" />
          </label>
        </div>
      </section>

      <section className="panel p-4 sm:p-5">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <p className="text-[16px] font-semibold">Week of {monthDayLabel(previewMonday)}</p>
          <p className="text-[13px] text-[var(--color-text-muted)]">
            {preview.slots.length} posts · {preview.groups.length} video{preview.groups.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: 7 }, (_, i) => addDaysYmd(previewMonday, i)).map((d, i) => {
            const groups = preview.groups.filter((g) => g.ymd === d);
            return (
              <div key={d} className="flex min-h-[112px] min-w-0 flex-col gap-1 rounded-xl bg-white/[0.03] p-1">
                <p className="text-center text-[11px] font-semibold uppercase text-[var(--color-text-faint)]">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i]}</p>
                {groups.map((g) => (
                  <div key={g.key} className="rounded-md bg-[var(--color-violet-500)]/15 px-1 py-1 text-center">
                    <p className="text-[10.5px] font-semibold leading-tight">{formatMinutes(Number(g.time.slice(0, 2)) * 60 + Number(g.time.slice(3)), true)}</p>
                    <p className="mt-0.5 flex justify-center gap-[3px]">
                      {g.platforms.map((p) => (
                        <span key={p} className="h-[6px] w-[6px] rounded-full" style={{ background: PLATFORM_COLOR[p] }} />
                      ))}
                    </p>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[12.5px] leading-snug text-[var(--color-text-faint)]">
          One video can go to several platforms at the same time — that&apos;s one &ldquo;video&rdquo; above. You&apos;ll need about{" "}
          {preview.groups.length} finished video{preview.groups.length === 1 ? "" : "s"} a week, each filmed {plan.filmLeadDays} day
          {plan.filmLeadDays === 1 ? "" : "s"} and ready {plan.readyLeadDays} day{plan.readyLeadDays === 1 ? "" : "s"} ahead.
        </p>
      </section>

      {/* Save — pinned above the tab bar on phones. */}
      <div
        className="sticky z-30 -mx-[var(--gutter)] border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-ink)_92%,transparent)] px-[var(--gutter)] py-3 backdrop-blur-xl lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0"
        style={{ bottom: "var(--tabbar-h)" }}
      >
        <div className="flex items-center gap-3">
          <button type="button" onClick={save} disabled={pending} className="btn btn-primary flex-1 sm:flex-none">
            {pending ? "Saving…" : hasPlan ? "Save plan" : "Use this plan"}
          </button>
          {saved === "ok" ? (
            <Link href="/calendar" className="text-[14px] font-medium text-[var(--color-emerald-400)]">
              Saved ✓ View calendar →
            </Link>
          ) : saved ? (
            <span className="text-[14px] text-[var(--color-rose-400)]">{saved}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
