"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PRIMARY_LINKS, MORE_LINKS, isActive } from "./nav-links-data";

const LINK = "rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ";
const ON = "bg-white/10 text-[var(--color-text)]";
const OFF = "text-[var(--color-text-muted)] hover:text-[var(--color-text)]";

/** Split out from NavBar.tsx specifically so usePathname's client-only active-link
 * highlighting can sit inside a Suspense boundary — required on dynamic routes like
 * /content/[id] per Next.js's CSR-bailout rules, otherwise that route's whole page would
 * silently fall back to client-side rendering. NavBar.tsx (server) supplies the
 * non-interactive fallback, so there's no loading flash.
 *
 * Desktop: the four daily places, then a "More" menu with everything else (same split as the
 * phone tab bar). */
export function NavLinks() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  if (open && openedAt !== pathname) {
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const moreActive = MORE_LINKS.some((l) => isActive(l.href, pathname));
  return (
    <>
      {PRIMARY_LINKS.map((link) => {
        const active = isActive(link.href, pathname);
        return (
          <Link key={link.href} href={link.href} prefetch={true} aria-current={active ? "page" : undefined} className={LINK + (active ? ON : OFF)}>
            {link.label}
          </Link>
        );
      })}
      <div ref={ref} className="relative">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            setOpen((o) => !o);
            setOpenedAt(pathname);
          }}
          className={LINK + "inline-flex items-center gap-1 " + (moreActive || open ? ON : OFF)}
        >
          More
          <svg width="10" height="7" viewBox="0 0 14 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="m1 1.5 6 6 6-6" />
          </svg>
        </button>
        {open && (
          <div role="menu" className="absolute left-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-2xl border border-[var(--color-border-strong)] bg-[#121216] p-1.5 shadow-2xl">
            {MORE_LINKS.map((link) => {
              const active = isActive(link.href, pathname);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className="block rounded-xl px-3 py-2 hover:bg-white/[0.06]"
                >
                  <span className={`block text-[14px] font-medium ${active ? "text-[var(--color-gold-400)]" : ""}`}>{link.label}</span>
                  <span className="block truncate text-[12px] text-[var(--color-text-faint)]">{link.hint}</span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
