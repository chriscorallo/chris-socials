"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_LINKS } from "./nav-links-data";

/** Split out from NavBar.tsx specifically so usePathname's client-only active-link
 * highlighting can sit inside a Suspense boundary — required on dynamic routes like
 * /content/[id] per Next.js's CSR-bailout rules, otherwise that route's whole page would
 * silently fall back to client-side rendering. NavBar.tsx (server) supplies the
 * non-interactive fallback, so there's no loading flash either. */
export function NavLinks() {
  const pathname = usePathname();
  return (
    <>
      {NAV_LINKS.map((link) => {
        const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={
              "rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors " +
              (active
                ? "bg-white/10 text-[var(--color-text)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]")
            }
          >
            {link.label}
          </Link>
        );
      })}
    </>
  );
}
