import Link from "next/link";
import type { ReactNode } from "react";
import { SubmitButton } from "./SubmitButton";

/**
 * The shared visual language every page composes from — see app/globals.css for the actual
 * tokens (.panel, .btn-*, .badge-*, .eyebrow). Kept as small, composable primitives rather
 * than one giant page-shell component, since every page's content differs a lot more than its
 * chrome does.
 *
 * Mobile-first: phone padding/sizes are the defaults, sm:/lg: add the desktop treatment.
 */

export function PageShell({ children, maxWidth = 880 }: { children: ReactNode; maxWidth?: number }) {
  return (
    <>
      <div className="ambient-field" aria-hidden />
      <main
        className="relative z-10 mx-auto pt-5 sm:pt-8 lg:pt-10"
        style={{
          maxWidth,
          // Clear the fixed bottom tab bar (0 at lg+) and any sticky action bar above it.
          paddingBottom: "calc(var(--tabbar-h) + var(--action-bar-h, 0px) + 2.5rem)",
          paddingLeft: "max(var(--gutter), var(--safe-left))",
          paddingRight: "max(var(--gutter), var(--safe-right))",
        }}
      >
        {children}
      </main>
    </>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="-ml-2 mb-1 inline-flex min-h-[44px] items-center gap-1 rounded-full px-2 text-[15px] text-[var(--color-gold-400)] active:opacity-60"
    >
      <svg width="9" height="16" viewBox="0 0 9 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M8 1 1 8l7 7" />
      </svg>
      {children}
    </Link>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 sm:mb-6">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <p className="eyebrow mb-1">{eyebrow}</p>
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-2xl">{title}</h1>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {description && <p className="mt-2 max-w-2xl text-[15px] leading-snug text-[var(--color-text-muted)] sm:text-sm">{description}</p>}
    </header>
  );
}

export function Panel({
  children,
  className = "",
  padding = "p-4 sm:p-6",
  id,
}: {
  children: ReactNode;
  className?: string;
  padding?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`panel flex min-w-0 flex-col ${padding} ${className}`}>
      {children}
    </section>
  );
}

export function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="mb-3.5 min-w-0">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="mt-1 text-[17px] font-semibold text-[var(--color-text)]">{title}</h2>
    </div>
  );
}

/** A panel whose body folds away — for read-only history/context on long pages, so the page
 * on a phone is a short list of headings instead of a wall of text. Native <details>: works
 * without JS, keyboard and VoiceOver accessible. */
export function CollapsiblePanel({
  eyebrow,
  title,
  meta,
  children,
  defaultOpen = false,
  id,
  className = "",
}: {
  eyebrow: string;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  id?: string;
  className?: string;
}) {
  return (
    <details id={id} open={defaultOpen} className={`panel min-w-0 ${className}`}>
      <summary className="flex min-h-[60px] cursor-pointer items-center justify-between gap-3 rounded-2xl px-4 py-3 active:bg-white/[0.03] sm:px-6 sm:py-4">
        <div className="min-w-0">
          <p className="eyebrow">{eyebrow}</p>
          <h2 className="mt-0.5 text-[17px] font-semibold text-[var(--color-text)]">{title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {meta}
          <svg width="14" height="9" viewBox="0 0 14 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="chevron text-[var(--color-text-faint)]" aria-hidden>
            <path d="m1 1.5 6 6 6-6" />
          </svg>
        </div>
      </summary>
      <div className="min-w-0 px-4 pb-4 sm:px-6 sm:pb-6">{children}</div>
    </details>
  );
}

/**
 * The one obvious next action, pinned in the thumb zone above the tab bar on phones/tablets
 * (on desktop the action panels themselves are visible, so it hides at lg+). Pages render it
 * once; it sets --action-bar-h so PageShell leaves room for it.
 */
export function StickyActionBar({ label, eyebrow = "Next step", children }: { label: string; eyebrow?: string; children: ReactNode }) {
  return (
    <>
      <style>{`@media (max-width: 1023.98px) { :root { --action-bar-h: 76px; } }`}</style>
      <div
        className="fixed inset-x-0 z-40 border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-ink)_88%,transparent)] backdrop-blur-xl lg:hidden"
        style={{ bottom: "var(--tabbar-h)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
      >
        <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">{eyebrow}</p>
            <p className="truncate text-[14px] font-medium">{label}</p>
          </div>
          <div className="shrink-0">{children}</div>
        </div>
      </div>
    </>
  );
}

type BadgeTone = "gold" | "violet" | "rose" | "emerald" | "neutral";

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function ButtonLink({
  href,
  children,
  tone = "ghost",
  className = "",
}: {
  href: string;
  children: ReactNode;
  tone?: "primary" | "ghost" | "danger";
  className?: string;
}) {
  return (
    <Link href={href} className={`btn btn-${tone} ${className}`}>
      {children}
    </Link>
  );
}

export function Button({
  children,
  tone = "ghost",
  type = "submit",
  disabled,
  className = "",
  pendingLabel,
}: {
  children: ReactNode;
  tone?: "primary" | "ghost" | "danger";
  type?: "submit" | "button";
  disabled?: boolean;
  className?: string;
  pendingLabel?: string;
}) {
  const cls = `btn btn-${tone} ${className}`;
  if (type === "submit") {
    return (
      <SubmitButton className={cls} disabled={disabled} pendingLabel={pendingLabel}>
        {children}
      </SubmitButton>
    );
  }
  return (
    <button type={type} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}

const BLOCKED_STATES = new Set(["RESEARCH_BLOCKED", "QC_BLOCKED", "CANCELLED"]);
const DONE_STATES = new Set(["PUBLISHED", "ARCHIVED", "READY", "SCHEDULED"]);
const EARLY_STATES = new Set(["IDEA", "SELECTED", "CONTRACTED"]);

/** A quick-glance color for any of the 23 states in the state machine (/docs/STATE_MACHINE.md)
 * — rose for anything blocked/cancelled, emerald for anything finished-and-live, gold for
 * still-early idea stages, violet for the broad "actively being produced" middle. Not a
 * precise per-state palette (23 distinct colors would defeat the point) — a coarse read of
 * "does this need worry" at a glance. */
export function contentStateTone(state: string): "rose" | "emerald" | "gold" | "violet" {
  if (BLOCKED_STATES.has(state)) return "rose";
  if (DONE_STATES.has(state)) return "emerald";
  if (EARLY_STATES.has(state)) return "gold";
  return "violet";
}

/** Human-readable state name for badges ("READY_TO_FILM" -> "Ready to film"). */
export function stateLabel(state: string): string {
  const s = state.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="text-[15px] leading-snug text-[var(--color-text-muted)] sm:text-sm">{children}</p>;
}

export function QuietLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="link-quiet text-[15px] sm:text-sm">
      {children}
    </Link>
  );
}

/** Platform name for a badge/label ("INSTAGRAM" -> "Instagram"). */
export function platformLabel(p: string): string {
  return p === "TIKTOK" ? "TikTok" : p === "YOUTUBE" ? "YouTube" : p === "INSTAGRAM" ? "Instagram" : p;
}
