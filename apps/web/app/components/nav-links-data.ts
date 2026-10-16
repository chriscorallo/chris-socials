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
  { href: "/film", label: "Film" },
  { href: "/ideas", label: "Ideas" },
  { href: "/strategy", label: "Strategy" },
  { href: "/reference", label: "Reference" },
  { href: "/analytics", label: "Analytics" },
  { href: "/learnings", label: "Learnings" },
  { href: "/settings/connections", label: "Connections" },
];
