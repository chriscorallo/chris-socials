import { Suspense } from "react";
import Link from "next/link";
import { logout } from "../actions";
import { NavLinks } from "./NavLinks";
import { MobileNav, MobileNavShell } from "./MobileNav";
import { NAV_LINKS } from "./nav-links-data";

// Primary nav per /docs/PRODUCT_SPEC.md — UI principle: CALENDAR / CONTENT / ANALYTICS /
// LEARNINGS / IDEAS. Kept deliberately plain in *count*; the backend can get sophisticated,
// the nav should not.
//
// Two shapes, one source list (nav-links-data.ts):
// - lg+ (desktop): the horizontal link row in a sticky top bar, as before.
// - below lg (phones, iPad portrait): a slim sticky top bar (brand only, padded under the
//   status bar / Dynamic Island) + a fixed bottom tab bar (Home, Content, Film, Calendar,
//   More) in the thumb zone, with the rest in a "More" bottom sheet. Chris mostly uses this
//   on his iPhone — see /docs/decisions-pending/mobile-app.md.
//
// Server component on purpose — the active-link highlight needs usePathname (client-only),
// which on a dynamic route like /content/[id] requires a Suspense boundary to avoid a CSR
// bailout of the whole page (see /docs/ARCHITECTURE.md's Vercel Next.js notes). The fallbacks
// below render the same links, just without the highlight, so there's no loading flash.
function StaticFallbackLinks() {
  return (
    <>
      {NAV_LINKS.map((link) => (
        <a
          key={link.href}
          href={link.href}
          className="rounded-full px-3 py-1.5 text-[13px] font-medium text-[var(--color-text-muted)]"
        >
          {link.label}
        </a>
      ))}
    </>
  );
}

function BrandMark({ className = "h-2 w-2" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 rounded-full ${className}`}
      style={{ background: "linear-gradient(135deg, var(--color-gold-400), var(--color-violet-400))" }}
    />
  );
}

export function NavBar() {
  const signOutForm = (
    <form action={logout}>
      <button type="submit" className="btn btn-ghost w-full !min-h-[52px] text-[15px] text-[var(--color-rose-400)]">
        Sign out
      </button>
    </form>
  );

  return (
    <>
      <header
        className="sticky top-0 z-50 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-ink)_78%,transparent)] backdrop-blur-xl"
        style={{ paddingTop: "var(--safe-top)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
      >
        {/* Phone / tablet: brand only — navigation lives in the bottom tab bar. */}
        <div className="flex h-12 items-center justify-center px-4 lg:hidden">
          <Link href="/" className="flex h-11 items-center gap-2 px-2 text-[15px] font-semibold tracking-tight">
            <BrandMark className="h-2.5 w-2.5" />
            Chris Studio
          </Link>
        </div>

        {/* Desktop */}
        <nav className="mx-auto hidden max-w-6xl items-center gap-1 px-6 py-3 lg:flex" aria-label="Primary">
          <Link href="/" className="mr-3 flex items-center gap-2 text-sm font-semibold tracking-tight">
            <BrandMark />
            Chris
          </Link>
          <Suspense fallback={<StaticFallbackLinks />}>
            <NavLinks />
          </Suspense>
          <form action={logout} className="ml-auto">
            <button type="submit" className="btn btn-ghost !min-h-0 !py-1.5 !px-3 text-[13px]">
              Sign out
            </button>
          </form>
        </nav>
      </header>

      <Suspense fallback={<MobileNavShell signOut={signOutForm} pathname={null} />}>
        <MobileNav signOut={signOutForm} />
      </Suspense>
    </>
  );
}
