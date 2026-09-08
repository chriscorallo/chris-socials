import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The shared visual language every page composes from — see app/globals.css for the actual
 * tokens (.panel, .btn-*, .badge-*, .eyebrow). Kept as small, composable primitives rather
 * than one giant page-shell component, since every page's content differs a lot more than its
 * chrome does.
 */

export function PageShell({ children, maxWidth = 880 }: { children: ReactNode; maxWidth?: number }) {
  return (
    <>
      <div className="ambient-field" aria-hidden />
      <main
        className="relative z-10 mx-auto px-6 pt-10 pb-24"
        style={{ maxWidth }}
      >
        {children}
      </main>
    </>
  );
}

export function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description?: string }) {
  return (
    <header className="mb-6">
      <p className="eyebrow mb-1">{eyebrow}</p>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description && <p className="mt-2 max-w-2xl text-sm text-[var(--color-text-muted)]">{description}</p>}
    </header>
  );
}

export function Panel({
  children,
  className = "",
  padding = "p-6",
}: {
  children: ReactNode;
  className?: string;
  padding?: string;
}) {
  return <section className={`panel flex flex-col ${padding} ${className}`}>{children}</section>;
}

export function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="mb-3.5">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="mt-1 text-[17px] font-semibold text-[var(--color-text)]">{title}</h2>
    </div>
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
}: {
  href: string;
  children: ReactNode;
  tone?: "primary" | "ghost" | "danger";
}) {
  return (
    <Link href={href} className={`btn btn-${tone}`}>
      {children}
    </Link>
  );
}

export function Button({
  children,
  tone = "ghost",
  type = "submit",
  disabled,
}: {
  children: ReactNode;
  tone?: "primary" | "ghost" | "danger";
  type?: "submit" | "button";
  disabled?: boolean;
}) {
  return (
    <button type={type} disabled={disabled} className={`btn btn-${tone}`}>
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

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="text-sm text-[var(--color-text-muted)]">{children}</p>;
}

export function QuietLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="link-quiet text-sm">
      {children}
    </Link>
  );
}
