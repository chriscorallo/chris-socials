"use client";

import { useEffect, useState } from "react";
import { formatYmdShort } from "@chris/domain/plan-import";
import { PlanItemUpload } from "./PlanItemUpload";

export interface ChecklistItem {
  id: string;
  title: string;
  ymd: string;
  filmBy: string;
  platforms: string[];
  hook: string | null;
  notes: string | null;
}

const KEY = "plan-film-checklist-v1";

/**
 * "Filming checklist": everything to film in a date range, with hooks and notes, checkable as
 * he goes. Ticks are a per-device convenience (localStorage) — the real "filmed" signal is
 * uploading the footage, which moves the video on for good.
 */
export function FilmChecklist({ items, mode }: { items: ChecklistItem[]; mode: "blob" | "local" }) {
  const [done, setDone] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      // Reading persisted ticks after mount (localStorage isn't available during SSR).
      setDone(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, boolean>);
    } catch {
      // private mode / blocked storage — ticks just won't persist
    }
  }, []);
  function toggle(id: string) {
    setDone((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }
  const left = items.filter((i) => !done[i.id]).length;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[14px] text-[var(--color-text-muted)]">
        {items.length === 0 ? "Nothing to film in these days." : `${left} of ${items.length} left to film`}
      </p>
      <ul className="flex flex-col gap-2.5">
        {items.map((i) => (
          <li key={i.id} className={`panel flex gap-3 p-4 ${done[i.id] ? "opacity-55" : ""}`}>
            <button
              type="button"
              onClick={() => toggle(i.id)}
              aria-pressed={!!done[i.id]}
              aria-label={done[i.id] ? `Mark ${i.title} not filmed` : `Mark ${i.title} filmed`}
              className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 ${done[i.id] ? "border-[var(--color-emerald-400)] bg-[var(--color-emerald-500)]/20 text-[var(--color-emerald-400)]" : "border-[var(--color-border)]"}`}
            >
              {done[i.id] && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m5 12 5 5L20 7" />
                </svg>
              )}
            </button>
            <div className="min-w-0 flex-1">
              <p className={`text-[16px] font-medium leading-snug ${done[i.id] ? "line-through" : ""}`}>{i.title}</p>
              <p className="mt-0.5 text-[12.5px] text-[var(--color-text-faint)]">
                Film by {formatYmdShort(i.filmBy)} · posts {formatYmdShort(i.ymd)}
                {i.platforms.length ? ` · ${i.platforms.map(shortPlatform).join(", ")}` : ""}
              </p>
              {i.hook && <p className="mt-2 text-[14.5px] leading-snug">“{i.hook}”</p>}
              {i.notes && <p className="mt-1.5 whitespace-pre-line text-[13.5px] leading-snug text-[var(--color-text-muted)]">{i.notes}</p>}
            </div>
            <div className="shrink-0 self-center">
              <PlanItemUpload contentItemId={i.id} mode={mode} label="Upload" compact />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function shortPlatform(p: string): string {
  return p === "TIKTOK" ? "TikTok" : p === "INSTAGRAM" ? "Reels" : p === "YOUTUBE" ? "Shorts" : p;
}
