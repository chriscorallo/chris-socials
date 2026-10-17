"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { TAB_LINKS, MORE_LINKS, isActive, type TabIcon } from "./nav-links-data";

function Icon({ name, active }: { name: TabIcon | "more"; active: boolean }) {
  const common = {
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: active ? 2 : 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "home":
      return (
        <svg {...common}>
          <path d="M3.5 10.5 12 3.5l8.5 7" />
          <path d="M5.5 9v10.5h4.5v-6h4v6h4.5V9" />
        </svg>
      );
    case "content":
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
        </svg>
      );
    case "upload":
      // The primary action: a gold filled circle with a plus, so it reads as "add" at a glance.
      return (
        <svg width={30} height={30} viewBox="0 0 30 30" aria-hidden>
          <circle cx="15" cy="15" r="14" fill="var(--color-gold-400)" />
          <path d="M15 9v12M9 15h12" stroke="#111" strokeWidth={2.4} strokeLinecap="round" />
        </svg>
      );
    case "film":
      return (
        <svg {...common}>
          <rect x="2.5" y="6" width="13.5" height="12" rx="2.5" />
          <path d="m16 10.5 5.5-3v9l-5.5-3" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
          <path d="M3.5 10h17M8 3v4M16 3v4" />
        </svg>
      );
    case "more":
      return (
        <svg {...common}>
          <circle cx="5.5" cy="12" r="1.2" fill="currentColor" />
          <circle cx="12" cy="12" r="1.2" fill="currentColor" />
          <circle cx="18.5" cy="12" r="1.2" fill="currentColor" />
        </svg>
      );
  }
}

const TAB_CLASS =
  "flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 pt-1 text-[10.5px] font-medium tracking-tight transition-colors active:opacity-60";

/**
 * Phone/tablet navigation (hidden at lg+, where NavBar's horizontal links take over): a
 * fixed bottom tab bar in the thumb zone + a "More" bottom sheet. `signOut` is the server
 * action form, passed in from the server NavBar so this file never imports server code.
 */
export function MobileNav({ signOut }: { signOut: ReactNode }) {
  return <MobileNavShell signOut={signOut} pathname={usePathname()} />;
}

/** Same UI without reading the pathname — the Suspense fallback (no active highlight). */
export function MobileNavShell({ signOut, pathname }: { signOut: ReactNode; pathname: string | null }) {
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState<string | null>(null);

  // Close the sheet whenever navigation lands on a new route.
  if (open && openedAt !== null && pathname !== openedAt) {
    setOpen(false);
    setOpenedAt(null);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  const moreActive = MORE_LINKS.some((l) => isActive(l.href, pathname));

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-ink)_92%,transparent)] backdrop-blur-xl lg:hidden"
        style={{ paddingBottom: "var(--safe-bottom)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
      >
        <div className="mx-auto flex max-w-xl items-stretch">
          {TAB_LINKS.map((tab) => {
            const active = isActive(tab.href, pathname);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`${TAB_CLASS} ${active ? "text-[var(--color-gold-400)]" : "text-[var(--color-text-faint)]"}`}
              >
                <Icon name={tab.icon} active={active} />
                {tab.label}
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setOpenedAt(pathname);
            }}
            aria-haspopup="dialog"
            aria-expanded={open}
            className={`${TAB_CLASS} ${moreActive || open ? "text-[var(--color-gold-400)]" : "text-[var(--color-text-faint)]"}`}
          >
            <Icon name="more" active={moreActive} />
            More
          </button>
        </div>
      </nav>

      {open && (
        <div className="fixed inset-0 z-[60] lg:hidden" role="dialog" aria-modal="true" aria-label="More">
          <button
            type="button"
            aria-label="Close menu"
            className="backdrop-enter absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div
            className="sheet-enter absolute inset-x-0 bottom-0 mx-auto max-w-xl rounded-t-[22px] border-t border-[var(--color-border-strong)] bg-[#121216] shadow-2xl"
            style={{ paddingBottom: "calc(var(--safe-bottom) + 12px)" }}
          >
            <div className="flex justify-center pt-2.5 pb-1">
              <span aria-hidden className="h-1 w-10 rounded-full bg-white/20" />
            </div>
            <div className="flex items-center justify-between px-5 pb-2 pt-1">
              <p className="text-[17px] font-semibold">More</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-[var(--color-text-muted)] active:bg-white/10"
                aria-label="Close"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
            <ul className="mx-3 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-white/[0.03]">
              {MORE_LINKS.map((link) => {
                const active = isActive(link.href, pathname);
                return (
                  <li key={link.href} className="border-b border-[var(--color-border)] last:border-0">
                    <Link
                      href={link.href}
                      onClick={() => setOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className="flex min-h-[56px] items-center justify-between gap-3 px-4 py-2.5 active:bg-white/[0.06]"
                    >
                      <span className="min-w-0">
                        <span className={`block text-[16px] font-medium ${active ? "text-[var(--color-gold-400)]" : ""}`}>{link.label}</span>
                        <span className="block truncate text-[13px] text-[var(--color-text-faint)]">{link.hint}</span>
                      </span>
                      <svg width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="shrink-0 text-[var(--color-text-faint)]" aria-hidden>
                        <path d="m1 1 6 6-6 6" />
                      </svg>
                    </Link>
                  </li>
                );
              })}
            </ul>
            <div className="mx-3 mt-3">{signOut}</div>
          </div>
        </div>
      )}
    </>
  );
}
