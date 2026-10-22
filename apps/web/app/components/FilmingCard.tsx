/**
 * The filming card (docs/PREMIUM_EDITOR_HANDOFF.md §3.2): how to film so the edit can be clean.
 * The cheapest quality lever is upstream — headlines need headroom, clean splices need a steady
 * level and a real mic. Open on /film, closed under the upload panel. No settings, no state.
 */
const TIPS: Array<{ title: string; body: string }> = [
  { title: "Leave the top third empty.", body: "Headlines live above your head. Sit in the lower two thirds, chest up. Shoot wide — punch-ins are the editor’s job." },
  { title: "Lock exposure and focus.", body: "Tap and hold on the iPhone camera. Keep the light steady." },
  { title: "Mic on, same distance the whole take.", body: "No music in the room." },
  { title: "Say the hook twice,", body: "then a full second of silence." },
  { title: "Pause a beat after the payoff and after the last line.", body: "Skip “let me know” — the editor ends on your question." },
  { title: "Stumbled? Stop, breathe, restart the sentence.", body: "Restarts are removed automatically." },
];

export function FilmingCard({ defaultOpen = false, className = "" }: { defaultOpen?: boolean; className?: string }) {
  return (
    <details open={defaultOpen} className={`panel group p-4 sm:p-5 ${className}`} data-testid="filming-card">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3 text-[15px] font-semibold">
        <span>Before you film</span>
        <span className="text-[13px] font-medium text-[var(--color-text-faint)] group-open:hidden">6 tips ›</span>
      </summary>
      <ol className="mt-2 flex flex-col gap-2.5">
        {TIPS.map((t, i) => (
          <li key={i} className="flex gap-3 text-[14px] leading-snug">
            <span className="mt-[1px] w-5 shrink-0 text-right font-semibold text-[var(--color-gold-400)]">{i + 1}</span>
            <span>
              <span className="font-medium">{t.title}</span> <span className="text-[var(--color-text-muted)]">{t.body}</span>
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
