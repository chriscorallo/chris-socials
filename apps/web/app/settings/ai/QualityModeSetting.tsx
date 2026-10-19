"use client";

import { useState, useTransition } from "react";
import type { QualityCheckMode } from "@chris/domain";
import { setQualityModeSettingAction } from "./actions";

const OPTIONS: Array<{ mode: QualityCheckMode; title: string; body: string }> = [
  {
    mode: "FIRM",
    title: "Firm",
    body: "The AI checks must pass before a video goes on the calendar. If the AI can't run (no credit), Finish stops after rendering.",
  },
  {
    mode: "SKIP_ALLOWED",
    title: "Let me skip it",
    body: "When the AI can't run — or you choose to skip it — the video still goes on the calendar after the free technical check. It's logged as your decision and marked “Scheduled without AI quality check”.",
  },
];

/** Settings → AI credit: "Quality check before scheduling" (docs/decisions-pending/quality-override.md). */
export function QualityModeSetting({ initial }: { initial: QualityCheckMode }) {
  const [mode, setMode] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const choose = (m: QualityCheckMode) => {
    if (m === mode || pending) return;
    const prev = mode;
    setMode(m);
    setError(null);
    start(async () => {
      const r = await setQualityModeSettingAction(m).catch(() => ({ ok: false, error: "Couldn't save the setting — try again." }));
      if (!r.ok) {
        setMode(prev);
        setError(r.error ?? "Couldn't save the setting — try again.");
      }
    });
  };

  return (
    <div data-testid="quality-mode-setting">
      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Quality check before scheduling">
        {OPTIONS.map((o) => {
          const on = mode === o.mode;
          return (
            <button
              key={o.mode}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={pending}
              onClick={() => choose(o.mode)}
              className={`flex min-h-[56px] w-full items-start gap-3 rounded-xl border p-3 text-left transition ${
                on ? "border-[var(--color-gold-400)] bg-[var(--color-surface-raised)]" : "border-[var(--color-border)]"
              }`}
            >
              <span
                className={`mt-1 h-4 w-4 shrink-0 rounded-full border-2 ${on ? "border-[var(--color-gold-400)] bg-[var(--color-gold-400)]" : "border-[var(--color-text-faint)]"}`}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block text-[15px] font-semibold">{o.title}</span>
                <span className="mt-0.5 block text-[13px] leading-snug text-[var(--color-text-muted)]">{o.body}</span>
              </span>
            </button>
          );
        })}
      </div>
      {error && <p className="mt-2 text-[13px] text-[var(--color-rose-400)]">{error}</p>}
      <p className="mt-3 text-[12.5px] leading-snug text-[var(--color-text-faint)]">
        Always runs, free, either way: the render exists and the file is valid; length, size, codec and loudness are within each platform&apos;s limits; no missing media; no text or captions colliding on screen. A problem there always stops it. If the video shows numbers that haven&apos;t been fact-checked, you&apos;ll be asked to confirm you&apos;ve checked them.
      </p>
    </div>
  );
}
