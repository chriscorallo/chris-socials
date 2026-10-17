import { FLOW_STEPS, flowStepFor, type ContentState } from "@chris/domain";

/** Plan → Write → Film → Edit → Post, with the current step lit. */
export function FlowProgress({ state }: { state: ContentState }) {
  const { index, done } = flowStepFor(state);
  const cancelled = state === "CANCELLED";
  return (
    <ol className="flex w-full items-start" aria-label="Progress">
      {FLOW_STEPS.map((step, i) => {
        const complete = !cancelled && (i < index || done);
        const current = !cancelled && !done && i === index;
        return (
          <li key={step} className="flex min-w-0 flex-1 flex-col items-center gap-1.5" aria-current={current ? "step" : undefined}>
            <div className="flex w-full items-center">
              <span className={`h-[3px] flex-1 rounded-full ${i === 0 ? "opacity-0" : complete || current ? "bg-[var(--color-gold-400)]" : "bg-white/12"}`} />
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${
                  current
                    ? "bg-[var(--color-gold-400)] text-[#111] ring-4 ring-[var(--color-gold-500)]/25"
                    : complete
                      ? "bg-[var(--color-gold-500)]/30 text-[var(--color-gold-400)]"
                      : "border border-white/15 text-[var(--color-text-faint)]"
                }`}
              >
                {complete ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m2.5 6.5 2.3 2.3L9.5 3.5" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <span className={`h-[3px] flex-1 rounded-full ${i === FLOW_STEPS.length - 1 ? "opacity-0" : complete ? "bg-[var(--color-gold-400)]" : "bg-white/12"}`} />
            </div>
            <span className={`text-[12px] ${current ? "font-semibold text-[var(--color-gold-400)]" : complete ? "text-[var(--color-text-muted)]" : "text-[var(--color-text-faint)]"}`}>
              {step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
