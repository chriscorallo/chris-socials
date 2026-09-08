import { Suspense } from "react";
import { logout } from "../actions";
import { NavLinks } from "./NavLinks";
import { NAV_LINKS } from "./nav-links-data";

// Primary nav per /docs/PRODUCT_SPEC.md — UI principle: CALENDAR / CONTENT / ANALYTICS /
// LEARNINGS / IDEAS. Kept deliberately plain in *count*; the backend can get sophisticated,
// the nav should not. Strategy and Reference are Phase 2 additions not in the spec's
// canonical nav — they're real working pages, surfaced directly for now; spec's Home concept
// ("THIS WEEK / PERFORMANCE / CREATIVE DIRECTOR / NEEDS YOU") is where Strategy likely folds
// in once enough of that view exists to build it for real (Phase 7+).
//
// Server component on purpose — the active-link highlight needs usePathname (client-only),
// which on a dynamic route like /content/[id] requires a Suspense boundary to avoid a CSR
// bailout of the whole page (see /docs/ARCHITECTURE.md's Vercel Next.js notes). The fallback
// below is the same links, just without the highlight, so there's no loading flash.
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

export function NavBar() {
  return (
    <nav className="sticky top-0 z-50 border-b border-[var(--color-border)] bg-[var(--color-ink)]/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-5xl items-center gap-1 px-6 py-3">
        <span className="mr-3 flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: "linear-gradient(135deg, var(--color-gold-400), var(--color-violet-400))" }}
          />
          Chris
        </span>
        <Suspense fallback={<StaticFallbackLinks />}>
          <NavLinks />
        </Suspense>
        <form action={logout} className="ml-auto">
          <button type="submit" className="btn btn-ghost !py-1.5 !px-3 text-[13px]">
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
