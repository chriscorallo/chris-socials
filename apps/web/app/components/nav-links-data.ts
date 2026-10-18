// Plain data, no "use client" — kept in its own file specifically so both the server
// component (NavBar.tsx's fallback) and the client component (NavLinks.tsx) can import the
// exact same list. Importing a non-component export from a "use client" file into a server
// component doesn't reliably carry the real value across the RSC boundary (every export of a
// "use client" module becomes an opaque client reference, not just the components) — found by
// actually loading the page, not by inspection.
/** The four places Chris goes every day — the desktop top bar shows these; everything else
 * sits under "More". Same split as the phone tab bar. See docs/decisions-pending/flow.md. */
export const PRIMARY_LINKS = [
  { href: "/", label: "Home" },
  { href: "/content", label: "Videos" },
  { href: "/upload", label: "Upload" },
  { href: "/calendar", label: "Calendar" },
];

/** Everything else (desktop "More" menu and the phone "More" sheet). */
export const MORE_LINKS: { href: string; label: string; hint: string }[] = [
  { href: "/plan", label: "Plan", hint: "Your imported video plan — what to film and upload next" },
  { href: "/plan/import", label: "Import plan", hint: "Bring in a day, week, month or year of videos" },
  { href: "/plan/scripts", label: "Scripts from ChatGPT", hint: "Free scripts for your planned videos" },
  { href: "/settings/chatgpt", label: "Connect ChatGPT", hint: "Let ChatGPT save scripts from your planning chat" },
  { href: "/film", label: "Film", hint: "What's ready to shoot, with hooks and talking points" },
  { href: "/ideas", label: "Ideas", hint: "Capture and browse ideas" },
  { href: "/todo", label: "To-do", hint: "What's missing to stay on your posting plan" },
  { href: "/strategy", label: "Strategy", hint: "This week's thesis and portfolio" },
  { href: "/analytics", label: "Analytics", hint: "How published videos are doing" },
  { href: "/learnings", label: "Learnings", hint: "Evidence, beliefs, experiments" },
  { href: "/reference", label: "Reference", hint: "Creators you learn from" },
  { href: "/settings/ai", label: "AI credit", hint: "What the AI has cost, and top up" },
  { href: "/settings/connections", label: "Connections", hint: "Instagram, TikTok, YouTube" },
];

/** Every destination, once. */
export const NAV_LINKS = [...PRIMARY_LINKS, ...MORE_LINKS.map(({ href, label }) => ({ href, label }))];

export type TabIcon = "home" | "content" | "upload" | "film" | "calendar";

/** Phone/tablet bottom tab bar (below lg): Home, Videos, + Upload in the thumb-center,
 * Calendar — plus "More" for the rest. */
export const TAB_LINKS: { href: string; label: string; icon: TabIcon }[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/content", label: "Videos", icon: "content" },
  { href: "/upload", label: "Upload", icon: "upload" },
  { href: "/calendar", label: "Calendar", icon: "calendar" },
];

export function isActive(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}
