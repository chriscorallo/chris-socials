"use client";

import Link from "next/link";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CalEvent, PoolItem } from "../../lib/calendar-data";
import { formatMinutes, monthDayLabel, weekdayName } from "../../lib/calendar-views";
import { formatHhmm, parseHhmm } from "@chris/domain/tz";
import { friendlyStateLabel } from "@chris/domain/friendly-status";
import type { ContentState } from "@chris/domain/planning";
import { thumbUrlFor } from "../../lib/media-urls";
import { ALL_PLATFORMS, PLATFORM_COLOR, PLATFORM_NAME, PlatformDots, StatusPill } from "./calendar-ui";
import { moveEvent, scheduleAt, unscheduleEvent } from "./actions";
import { runAutopilotAction } from "../content/[id]/actions";

export type SheetState =
  | { kind: "event"; event: CalEvent }
  | { kind: "add"; ymd: string; minutes: number };

/** Bottom sheet on phones, centered dialog on desktop. Esc / backdrop / grabber closes. */
export function Sheet({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  // Portaled to <body>: PageShell's <main> is its own stacking context (z-10), which would
  // otherwise trap the sheet under the fixed tab bar.
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-end justify-center lg:items-center" role="dialog" aria-modal aria-label={label}>
      <button type="button" aria-label="Close" className="backdrop-enter absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className="sheet-enter relative max-h-[88dvh] w-full overflow-y-auto overscroll-contain rounded-t-[22px] border border-[var(--color-border-strong)] bg-[#141418] shadow-2xl lg:max-w-[460px] lg:rounded-[22px]"
        style={{ paddingBottom: "max(var(--safe-bottom), 16px)" }}
      >
        <div className="sticky top-0 z-10 flex justify-center bg-[#141418] pb-1 pt-2.5 lg:hidden">
          <button type="button" onClick={onClose} aria-label="Close" className="h-1.5 w-10 rounded-full bg-white/25" />
        </div>
        <div className="px-5 pb-2 pt-2 lg:pt-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function whenLabel(ymd: string, startMin: number) {
  return `${weekdayName(ymd)}, ${monthDayLabel(ymd)} · ${formatMinutes(startMin)}`;
}

function PlatformToggles({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {ALL_PLATFORMS.map((p) => {
        const on = value.includes(p);
        return (
          <button
            key={p}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== p) : [...value, p])}
            className={`flex min-h-[44px] items-center justify-center gap-2 rounded-xl border text-[14px] font-medium ${
              on ? "border-[var(--color-gold-500)]/60 bg-[var(--color-gold-500)]/12 text-[var(--color-text)]" : "border-[var(--color-border)] bg-white/[0.03] text-[var(--color-text-muted)]"
            }`}
          >
            <span className="h-2 w-2 rounded-full" style={{ background: PLATFORM_COLOR[p] }} />
            {PLATFORM_NAME[p]}
          </button>
        );
      })}
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="mt-3 rounded-xl bg-[var(--color-rose-500)]/12 px-3 py-2 text-[14px] text-[var(--color-rose-400)]">{error}</p>;
}

export function EventSheetBody({
  state,
  readyPool,
  autopilot,
  defaultPlatforms,
  onDone,
}: {
  state: SheetState;
  readyPool: PoolItem[];
  autopilot: PoolItem[];
  defaultPlatforms: string[];
  onDone: (msg?: string) => void;
}) {
  if (state.kind === "add") {
    return (
      <PickVideo
        heading="Add a video"
        sub={`${weekdayName(state.ymd)}, ${monthDayLabel(state.ymd)}`}
        ymd={state.ymd}
        minutes={state.minutes}
        platforms={defaultPlatforms}
        readyPool={readyPool}
        autopilot={autopilot}
        editableTime
        onDone={onDone}
      />
    );
  }
  const e = state.event;
  if (e.kind === "slot") {
    return (
      <PickVideo
        heading="Open slot"
        sub={`${whenLabel(e.ymd, e.startMin)} · ${e.platforms.map((p) => PLATFORM_NAME[p]).join(" + ")}`}
        ymd={e.ymd}
        minutes={e.startMin}
        atIso={e.iso}
        platforms={e.platforms}
        readyPool={readyPool}
        autopilot={autopilot}
        suggestionId={e.suggestion?.contentItemId}
        onDone={onDone}
      />
    );
  }
  return <PostDetail e={e} onDone={onDone} />;
}

function PostDetail({ e, onDone }: { e: CalEvent; onDone: (msg?: string) => void }) {
  const [date, setDate] = useState(e.ymd);
  const [time, setTime] = useState(formatHhmm(e.startMin));
  const [platforms, setPlatforms] = useState(e.platforms);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const reschedulable = e.canReschedule && e.contentItemId;

  const save = () =>
    start(async () => {
      const minutes = parseHhmm(time);
      if (minutes === null) return setError("Pick a time.");
      const r = await moveEvent({ contentItemId: e.contentItemId!, ymd: date, minutes, platforms });
      if (r.ok) onDone("Rescheduled");
      else setError(r.error);
    });

  const unschedule = () =>
    start(async () => {
      const r = await unscheduleEvent({ contentItemId: e.contentItemId! });
      if (r.ok) onDone("Removed from calendar");
      else setError(r.error);
    });

  return (
    <div>
      <div className="flex gap-4">
        {e.thumbKey ? (
          // Poster frame, not the video file (lib/poster.ts).
          <img
            src={thumbUrlFor(e.thumbKey)}
            alt=""
            decoding="async"
            className="h-[136px] w-[77px] shrink-0 rounded-xl bg-black object-cover"
          />
        ) : (
          <div className="flex h-[136px] w-[77px] shrink-0 items-center justify-center rounded-xl border border-dashed border-[var(--color-border-strong)] text-center text-[11px] text-[var(--color-text-faint)]">
            No render yet
          </div>
        )}
        <div className="min-w-0 flex-1">
          <StatusPill status={e.status} />
          <h2 className="mt-2 text-[19px] font-semibold leading-snug">{e.title}</h2>
          <p className="mt-1 text-[14px] text-[var(--color-text-muted)]">{whenLabel(e.ymd, e.startMin)}</p>
          <p className="mt-1.5 flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
            <PlatformDots platforms={e.platforms} size={7} />
            {e.platforms.map((p) => PLATFORM_NAME[p]).join(", ") || "No platforms"}
          </p>
        </div>
      </div>

      {e.note && <p className="mt-3 rounded-xl bg-white/[0.04] px-3 py-2 text-[14px] text-[var(--color-text-muted)]">{e.note}</p>}

      {e.links.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {e.links.map((l) => (
            <a key={l.platform} href={l.url} target="_blank" rel="noreferrer" className="btn btn-ghost !min-h-[38px] !text-[13px]">
              View on {PLATFORM_NAME[l.platform]} ↗
            </a>
          ))}
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Link href={`/content/${e.contentItemId}`} className="btn btn-ghost">
          Open
        </Link>
        {e.canEdit ? (
          <Link href={`/content/${e.contentItemId}/edit`} className="btn btn-ghost !text-[var(--color-gold-400)]">
            Edit video
          </Link>
        ) : (
          <span />
        )}
      </div>

      {reschedulable ? (
        <div className="mt-5 border-t border-[var(--color-border)] pt-4">
          <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">Reschedule</p>
          <div className="grid grid-cols-[1.4fr_1fr] gap-2">
            <input type="date" value={date} onChange={(ev) => setDate(ev.target.value)} className="field-input" aria-label="Date" />
            <input type="time" value={time} step={900} onChange={(ev) => setTime(ev.target.value)} className="field-input" aria-label="Time" />
          </div>
          <div className="mt-2">
            <PlatformToggles value={platforms} onChange={setPlatforms} />
          </div>
          <button type="button" onClick={save} disabled={pending} className="btn btn-primary mt-3 w-full">
            {pending ? "Saving…" : "Save new time"}
          </button>
          {e.status === "scheduled" && (
            <button type="button" onClick={unschedule} disabled={pending} className="btn btn-ghost mt-2 w-full !text-[var(--color-rose-400)]">
              Remove from calendar
            </button>
          )}
          <ErrorLine error={error} />
          <p className="mt-3 text-[12.5px] leading-snug text-[var(--color-text-faint)]">
            Or drag it: on a computer, drag in any view; on iPhone, press and hold in Week or Day. Removing it keeps the
            video ready to schedule again.
          </p>
        </div>
      ) : (
        e.status === "draft" && (
          <p className="mt-4 text-[13px] leading-snug text-[var(--color-text-faint)]">
            This video isn&apos;t READY yet, so it can&apos;t be scheduled to publish. Finish it on its page; then it can take this spot.
          </p>
        )
      )}
    </div>
  );
}

function PickVideo({
  heading,
  sub,
  ymd,
  minutes,
  atIso,
  platforms: initialPlatforms,
  readyPool,
  autopilot,
  suggestionId,
  editableTime,
  onDone,
}: {
  heading: string;
  sub: string;
  ymd: string;
  minutes: number;
  atIso?: string;
  platforms: string[];
  readyPool: PoolItem[];
  autopilot: PoolItem[];
  suggestionId?: string;
  editableTime?: boolean;
  onDone: (msg?: string) => void;
}) {
  const [platforms, setPlatforms] = useState(initialPlatforms);
  const [time, setTime] = useState(formatHhmm(minutes));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const pool = suggestionId ? [...readyPool].sort((a, b) => (a.id === suggestionId ? -1 : b.id === suggestionId ? 1 : 0)) : readyPool;

  const pick = (id: string) => {
    setBusyId(id);
    start(async () => {
      const m = parseHhmm(time);
      const r =
        atIso && !editableTime
          ? await scheduleAt({ contentItemId: id, atIso, platforms })
          : await moveEvent({ contentItemId: id, ymd, minutes: m ?? minutes, platforms });
      setBusyId(null);
      if (r.ok) onDone("Scheduled");
      else setError(r.error);
    });
  };

  return (
    <div>
      <p className="eyebrow">{heading}</p>
      <h2 className="mt-1 text-[19px] font-semibold leading-snug">{sub}</h2>

      {editableTime && (
        <label className="mt-3 block">
          <span className="field-label">Time</span>
          <input type="time" value={time} step={900} onChange={(ev) => setTime(ev.target.value)} className="field-input" />
        </label>
      )}
      <div className="mt-3">
        <PlatformToggles value={platforms} onChange={setPlatforms} />
      </div>

      {pool.length > 0 ? (
        <>
          <p className="mb-2 mt-5 text-[13px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">Ready to post · tap to schedule</p>
          <ul className="overflow-hidden rounded-2xl border border-[var(--color-border)]">
            {pool.map((item) => (
              <li key={item.id} className="border-b border-[var(--color-border)] last:border-b-0">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => pick(item.id)}
                  className="flex min-h-[54px] w-full items-center gap-3 px-3.5 py-2 text-left active:bg-white/[0.05] disabled:opacity-60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{item.title}</span>
                    {item.id === suggestionId && <span className="text-[12px] font-semibold text-[var(--color-gold-400)]">Suggested — oldest ready video</span>}
                  </span>
                  <span className="shrink-0 text-[14px] font-semibold text-[var(--color-gold-400)]">{busyId === item.id ? "…" : "Schedule"}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="mt-5 rounded-2xl border border-dashed border-[var(--color-border-strong)] p-4">
          <p className="text-[15px] font-medium">Nothing is ready to post.</p>
          <p className="mt-1 text-[13.5px] leading-snug text-[var(--color-text-muted)]">
            {autopilot.length > 0 ? "Push the closest one forward with Autopilot — it runs every automatic step it can and stops where it needs you." : "Nothing is in production either — start from an idea."}
          </p>
          {autopilot.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2">
              {autopilot.map((item) => (
                <li key={item.id}>
                  <form action={runAutopilotAction} className="flex items-center gap-2">
                    <input type="hidden" name="contentItemId" value={item.id} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium">{item.title}</span>
                      <span className="text-[12px] text-[var(--color-text-faint)]">{friendlyStateLabel(item.state as ContentState)}</span>
                    </span>
                    <button type="submit" className="btn btn-ghost !min-h-[38px] shrink-0 !px-3 !text-[13px]">
                      Autopilot
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <Link href="/ideas" className="btn btn-ghost !text-[13px]">
              Ideas
            </Link>
            <Link href="/film" className="btn btn-ghost !text-[13px]">
              Film list
            </Link>
          </div>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}
