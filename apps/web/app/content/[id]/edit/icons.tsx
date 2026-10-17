/** Minimal stroke icon set for the editor (24px grid, currentColor). */
const PATHS: Record<string, string> = {
  back: "M15 18l-6-6 6-6",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  redo: "M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  keyboard: "M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14.5h8",
  play: "M7 4.5v15l12.5-7.5z",
  pause: "M8 5v14M16 5v14",
  split: "M12 3v18M7 8l-4 4 4 4M17 8l4 4-4 4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  duplicate: "M8 8h12v12H8zM16 8V4H4v12h4",
  text: "M5 6V4h14v2M12 4v16M9 20h6",
  zoom: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5M11 8v6M8 11h6",
  captions: "M3 6h18v12H3zM7 13h3M13 13h4M7 10h10",
  plus: "M12 5v14M5 12h14",
  film: "M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4",
  crop: "M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2",
  image: "M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9h.01",
  warn: "M12 3l10 18H2zM12 10v4M12 17h.01",
  check: "M5 12.5l4.5 4.5L19 7",
  skipBack: "M18 6l-8 6 8 6zM6 6v12",
  skipFwd: "M6 6l8 6-8 6zM18 6v12",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  volume: "M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7",
  mute: "M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6",
  close: "M6 6l12 12M18 6L6 18",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  palette: "M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.5 0-.9-.7-1.3-.7-2.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3zM7.5 11h.01M10 7.5h.01M14.5 7.5h.01",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 12h.01",
  hand: "M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V12M14 11.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3 14a1.5 1.5 0 0 1 2.5-1.6L8 15",
  phone: "M7 2h10v20H7zM11 18h2",
  calendar: "M4 6h16v15H4zM4 10h16M8 3v5M16 3v5",
  magnet: "M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3zM6 7h4M14 7h4",
};

export function Icon({ name, size = 16, className = "" }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  const filled = name === "play";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}
