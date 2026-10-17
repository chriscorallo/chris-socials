// Plain data, no "use client" — kept in its own file specifically so both the server
// component (NavBar.tsx's fallback) and the client component (NavLinks.tsx) can import the
// exact same list. Importing a non-component export from a "use client" file into a server
// component doesn't reliably carry the real value across the RSC boundary (every export of a
// "use client" module becomes an opaque client reference, not just the components) — found by
// actually loading the page, not by inspection.
export const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/calendar", label: "Calendar" },
  { href: "/content", label: "Content" },
  { href: "/upload", label: "Upload" },
  { href: "/film", label: "Film" },
  { href: "/ideas", label: "Ideas" },
  { href: "/strategy", label: "Strategy" },
  { href: "/reference", label: "Reference" },
  { href: "/analytics", label: "Analytics" },
  { href: "/learnings", label: "Learnings" },
  { href: "/settings/connections", label: "Connections" },
];

export type TabIcon = "home" | "content" | "upload" | "film" | "calendar";

/** Phone/tablet bottom tab bar (below lg): the four destinations Chris uses daily, in thumb
 * order, plus "More" for the rest. See /docs/decisions-pending/mobile-app.md. */
export const TAB_LINKS: { href: string; label: string; icon: TabIcon }[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/content", label: "Content", icon: "content" },
  { href: "/upload", label: "Upload", icon: "upload" },
  { href: "/film", label: "Film", icon: "film" },
  { href: "/calendar", label: "Calendar", icon: "calendar" },
];

/** Everything not in the tab bar, shown in the "More" sheet. */
export const MORE_LINKS: { href: string; label: string; hint: string }[] = [
  { href: "/ideas", label: "Ideas", hint: "Capture and browse ideas" },
  { href: "/strategy", label: "Strategy", hint: "This week's thesis and portfolio" },
  { href: "/analytics", label: "Analytics", hint: "How published videos are doing" },
  { href: "/learnings", label: "Learnings", hint: "Evidence, beliefs, experiments" },
  { href: "/reference", label: "Reference", hint: "Creators you learn from" },
  { href: "/settings/connections", label: "Connections", hint: "Instagram, TikTok, YouTube" },
];

export function isActive(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}
