import Link from "next/link";

/**
 * "Film with teleprompter" entry point (docs/decisions-pending/teleprompter.md). `icon` is the
 * compact 44 px round button for list rows; `chip` a small labelled button; `full` a
 * full-width button.
 */
export function TeleprompterLink({ id, variant = "full", from }: { id?: string; variant?: "full" | "icon" | "chip"; from?: "plan" | "film" }) {
  const params = new URLSearchParams();
  if (id) params.set("id", id);
  if (from) params.set("from", from);
  const qs = params.toString();
  const href = `/film/teleprompter${qs ? `?${qs}` : ""}`;
  const icon = (size: number) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--color-gold-400)]" aria-hidden>
      <rect x="3" y="6" width="13" height="12" rx="2.5" />
      <path d="m16 10 5-3v10l-5-3" />
      <path d="M6.5 10h6M6.5 13h4" />
    </svg>
  );
  if (variant === "icon") {
    return (
      <Link
        href={href}
        aria-label="Film with teleprompter"
        title="Film with teleprompter"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--color-border-strong)] active:bg-white/10"
        data-testid={id ? `tp-${id}` : "tp-link"}
      >
        {icon(20)}
      </Link>
    );
  }
  if (variant === "chip") {
    return (
      <Link href={href} className="btn btn-ghost !min-h-[44px] gap-2 !text-[14px]" data-testid={id ? `tp-${id}` : "tp-link"}>
        {icon(18)}
        Teleprompter
      </Link>
    );
  }
  return (
    <Link href={href} className="btn btn-ghost w-full !min-h-[52px] gap-2 !text-[16px]" data-testid="film-with-teleprompter">
      {icon(20)}
      Film with teleprompter
    </Link>
  );
}
