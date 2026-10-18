import type { GraphicProps } from "../contract";
import { spec, type FamilySizer, type Spec } from "./types";

/**
 * PHONE & APPS family — generic phone/OS-style UI (no real OS chrome, app icons or system
 * fonts; app names + glyphs editable from the original icon set). Field mapping:
 *
 * DM_CHAT      title = contact name · subtitle = status ("Active now") · meta = receipt under
 *              the last sent message ("Read 9:41") · items = messages (text, side ME/THEM,
 *              sub = sender name in GROUP, icon = a tap-back reaction on that bubble). A typing
 *              indicator plays before each THEM message. MESSAGES phone-text thread ·
 *              DM direct-message style (avatars) · GROUP group chat · BUBBLES bubbles only.
 * NOTIFICATION items = notifications (meta = app name, text = title, sub = message, icon = app
 *              glyph, color = app tint) · meta = time ("now") · LOCK: title = big clock "9:41",
 *              subtitle = date. STACK · LOCK (lock screen) · BANNER (one big banner; a "$2,500.00"
 *              in the title counts up). Entries arrive in order, newest on top (the last lands
 *              on top, pushing the earlier ones down).
 * CALL         title = caller · subtitle = "mobile" / label · meta = call timer "02:14" ·
 *              items[0].value = missed count (MISSED). INCOMING · BANNER · VIDEO (video call
 *              tiles + controls) · MISSED.
 * PHONE_APP    NOTES (title heading, items = lines, state = checkbox) · REMINDERS (items tick
 *              off in turn: state DONE gets checked) · INBOX (items: text = sender, sub =
 *              subject, meta = time, state TODO = unread) · EMAIL (title = subject, subtitle =
 *              sender, meta = time, body = message) · INVITE (title = event, subtitle = when,
 *              meta = where, items = attendees).
 * CLOCK_TIMER  ALARM (title = "6:00 AM", subtitle = label) · TIMER (items[0].value = seconds
 *              counted down to items[1].value ?? 0) · STOPWATCH (0 → items[0].value seconds) ·
 *              CLOCK (analog time-lapse from items[0].value to items[1].value hours; title label).
 * STATUS_ALERT BATTERY (items[0].value %, title, body) · SIGNAL (no connection) · ALERT (system
 *              dialog: title, body, items = buttons, state DONE = the default button) · TOAST
 *              (a pill: items[0].icon + title).
 * APP_GRID     GRID / DOCK: items = apps (text name, icon, color, value = badge count) ·
 *              STORE: app listing (title name, subtitle tagline, items[0].icon + value = rating
 *              0–5, items[1].value = ratings count).
 * KEYNOTE      clean stage typography (PLAIN black/white backdrop when full screen): NUMBER
 *              (items[0].value, uses `format`; title = label under) · TITLE (title + subtitle) ·
 *              SPECS (items: value + text) · REVEAL (one word, light sweep).
 */
export const PHONE_SPECS = {
  DM_CHAT: spec("DM_CHAT", "Text conversation", "Messages in and out, typing dots, read receipt", "PHONE", [["MESSAGES", "Messages"], ["DM", "Direct message"], ["GROUP", "Group chat"], ["BUBBLES", "Bubbles only"]], {
    title: true,
    subtitle: true,
    meta: "Receipt",
    tone: true,
    quick: "CHAT",
    items: { count: [1, 8], side: true, sub: true, icon: true },
    labels: { title: "Contact name", subtitle: "Status", text: "Message", sub: "Sender (group)", entries: "Messages" },
  }, { preferY: 0.4, toneDefault: "LIGHT" }),
  NOTIFICATION: spec("NOTIFICATION", "Notifications", "Push notifications stacking, lock screen, one big banner", "PHONE", [["STACK", "Stack"], ["LOCK", "Lock screen"], ["BANNER", "Banner"]], {
    title: true,
    subtitle: true,
    meta: "Time",
    tone: true,
    items: { count: [1, 5], sub: true, icon: true, meta: "App name" },
    labels: { title: "Clock (lock screen)", subtitle: "Date (lock screen)", text: "Notification title", sub: "Message", entries: "Notifications" },
  }, { preferY: 0.3, toneDefault: "LIGHT" }),
  CALL: spec("CALL", "Phone call", "Incoming call, call banner, video call, missed calls", "PHONE", [["INCOMING", "Incoming"], ["BANNER", "Banner"], ["VIDEO", "Video call"], ["MISSED", "Missed"]], {
    title: true,
    subtitle: true,
    meta: "Timer",
    tone: true,
    ownFormat: true,
    items: { count: [0, 1], value: true },
    labels: { title: "Caller", subtitle: "Label", value: "Missed calls", entries: "Count" },
  }, { preferY: 0.36 }),
  PHONE_APP: spec("PHONE_APP", "Phone app", "Notes, reminders, inbox, an email, a calendar invite", "PHONE", [["NOTES", "Notes"], ["REMINDERS", "Reminders"], ["INBOX", "Inbox"], ["EMAIL", "Email"], ["INVITE", "Invite"]], {
    title: true,
    subtitle: true,
    body: true,
    meta: "Time / place",
    tone: true,
    items: { count: [0, 7], sub: true, state: true, meta: "Time" },
    labels: { title: "Heading / subject / event", subtitle: "Sender / when", body: "Email text", text: "Line", sub: "Second line", entries: "Lines" },
  }, { preferY: 0.38, toneDefault: "LIGHT" }),
  CLOCK_TIMER: spec("CLOCK_TIMER", "Clock & timer", "Alarm, countdown timer, stopwatch, time-lapse clock", "PHONE", [["ALARM", "Alarm"], ["TIMER", "Timer"], ["STOPWATCH", "Stopwatch"], ["CLOCK", "Clock"]], {
    title: true,
    subtitle: true,
    tone: true,
    ownFormat: true,
    items: { count: [0, 2], value: true },
    labels: { title: "Time / label", subtitle: "Label", value: "Seconds / hour", entries: "Times" },
  }, { preferY: 0.36 }),
  STATUS_ALERT: spec("STATUS_ALERT", "System alert", "Battery low, no signal, an alert dialog, a toast", "PHONE", [["BATTERY", "Battery"], ["SIGNAL", "No signal"], ["ALERT", "Alert"], ["TOAST", "Toast"]], {
    title: true,
    body: true,
    tone: true,
    ownFormat: true,
    items: { count: [0, 3], value: true, icon: true, state: true },
    labels: { title: "Title", body: "Message", text: "Button", value: "Percent", entries: "Buttons" },
  }, { preferY: 0.34, toneDefault: "LIGHT" }),
  APP_GRID: spec("APP_GRID", "App icons", "Home-screen icons with badge counts, a dock, an app listing", "PHONE", [["GRID", "Grid"], ["DOCK", "Dock"], ["STORE", "App listing"]], {
    title: true,
    subtitle: true,
    tone: true,
    ownFormat: true,
    items: { count: [1, 12], value: true, icon: true },
    labels: { title: "App name (listing)", subtitle: "Tagline (listing)", text: "App name", value: "Badge / rating", entries: "Apps" },
  }, { preferY: 0.38 }),
  KEYNOTE: spec("KEYNOTE", "Keynote", "Stage-style big number, title, specs or one-word reveal", "TEXT", [["NUMBER", "Big number"], ["TITLE", "Title"], ["SPECS", "Specs"], ["REVEAL", "Reveal"]], {
    title: true,
    subtitle: true,
    tone: true,
    items: { count: [0, 4], value: true },
    labels: { title: "Title / label", subtitle: "Small line", text: "Label", value: "Number", entries: "Numbers" },
  }, { preferY: 0.4, backdrop: "PLAIN" }),
} satisfies Record<string, Spec>;

// ---------------------------------------------------------------------------------------
// Layout metrics. The component (packages/motion/src/remotion/graphics/phone.tsx) mirrors
// these numbers and the text measure below, so the design box is exactly what it draws —
// keep the two in sync when either changes.
// ---------------------------------------------------------------------------------------

/** Relative glyph advance (em) — mirror of packages/motion text.tsx `charW`. */
function cw(c: string): number {
  if (c === " " || c.charCodeAt(0) === 160) return 0.27;
  if ("iljI.,:;'!|’‘·".includes(c)) return 0.31;
  if ("ftr()-\"“”/".includes(c)) return 0.42;
  if (c === "m" || c === "w") return 0.86;
  if (c === "M" || c === "W") return 0.98;
  if (c === "—" || c === "–") return 0.9;
  if (/[A-Z]/.test(c)) return 0.72;
  if (/[0-9$%€£−+]/.test(c)) return 0.64;
  return 0.58;
}
function tw(s: string, size: number, k: number): number {
  let w = 0;
  for (const c of s) w += cw(c);
  return w * size * k;
}
/** Inter SemiBold (UI text) runs a touch narrower than the Display Bold estimate. */
const TEXT_K = 0.95;
/** Greedy wrapped line count (≤ max; 0 for empty) — mirror of phone.tsx `wrap`. */
function wrapN(text: string | null | undefined, size: number, width: number, max: number, k = TEXT_K): number {
  const words = (text ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  let n = 1;
  let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && tw(t, size, k) > width) {
      n++;
      cur = w;
    } else cur = t;
  }
  return Math.min(max, n);
}

/** DM_CHAT metrics (mirrored in phone.tsx). */
const CHAT = { W: 900, FS: 36, LH: 48, PY: 17, BW: 548, GAP_SAME: 8, GAP_SIDE: 22, REACT: 32, SENDER: 40, RECEIPT: 46, TOP: 26, BOTTOM: 30 } as const;
function chatHead(v: string): number {
  return v === "BUBBLES" ? 0 : v === "DM" ? 132 : 172;
}
function chatHeight(p: GraphicProps, v: string): number {
  let y = v === "BUBBLES" ? 12 : CHAT.TOP + chatHead(v) + 22;
  p.items.forEach((it, i) => {
    const prev = i > 0 ? p.items[i - 1]! : null;
    const me = it.side === "ME";
    if (prev) y += (prev.side === "ME") === me ? CHAT.GAP_SAME : CHAT.GAP_SIDE;
    if (v === "GROUP" && !me && it.sub && (!prev || prev.side === "ME" || prev.sub !== it.sub)) y += CHAT.SENDER;
    if (it.icon) y += CHAT.REACT;
    y += Math.max(1, wrapN(it.text, CHAT.FS, CHAT.BW, 6)) * CHAT.LH + 2 * CHAT.PY;
  });
  if (p.meta) y += CHAT.RECEIPT;
  return y + (v === "BUBBLES" ? 12 : CHAT.BOTTOM);
}

/** KEYNOTE TITLE: the size + line count the title fits at (≤ 3 lines in 940 px). */
function keynoteTitleFit(title: string | null | undefined): { size: number; lines: number } {
  for (let s = 150; s >= 84; s -= 6) {
    const n = wrapN(title || " ", s, 940, 99, 1);
    if (n <= 3) return { size: s, lines: n };
  }
  return { size: 84, lines: 3 };
}

export const phoneSize: FamilySizer = (p, v, head) => {
  const nI = p.items.length;
  switch (p.component) {
    case "DM_CHAT":
      return { width: CHAT.W, height: chatHeight(p, v) };
    case "NOTIFICATION":
      if (v === "LOCK") return { width: 940, height: 400 + Math.max(1, nI) * 192 - 16 + 40 };
      if (v === "BANNER") {
        const it = p.items[0];
        const tl = Math.max(1, wrapN(it?.text, 40, 768, 2, 1));
        const ml = wrapN(it?.sub, 34, 768, 3);
        return { width: 960, height: 34 + 38 + 6 + tl * 50 + (ml ? 6 + ml * 44 : 0) + 34 };
      }
      return { width: 960, height: Math.max(1, nI) * 194 - 18 };
    case "CALL":
      if (v === "BANNER") return { width: 960, height: 200 };
      if (v === "MISSED") return { width: 940, height: 200 };
      if (v === "VIDEO") return { width: 760, height: 1240 };
      return { width: 760, height: 1100 };
    case "PHONE_APP":
      if (v === "EMAIL") {
        const tl = Math.max(1, wrapN(p.title, 44, 852, 2, 1));
        const bl = Math.max(1, wrapN(p.body, 34, 852, 9));
        return { width: 940, height: 44 + tl * 54 + 26 + 88 + 26 + 24 + bl * 48 + 44 };
      }
      if (v === "INVITE") {
        const tl = Math.max(1, wrapN(p.title, 46, 840, 2, 1));
        return { width: 920, height: 40 + 56 + 18 + tl * 56 + 16 + (p.subtitle ? 52 : 0) + (p.meta ? 52 : 0) + (nI ? 92 : 0) + 28 + 96 + 40 };
      }
      if (v === "INBOX") return { width: 960, height: 36 + 92 + Math.max(1, nI) * 144 + 16 };
      if (v === "REMINDERS") return { width: 880, height: 40 + (p.title ? 84 : 0) + p.items.reduce((a, it) => a + (it.sub ? 104 : 80), 0) + 30 };
      return { width: 880, height: 40 + (p.meta ? 44 : 0) + (p.title ? 84 : 0) + Math.max(1, nI) * 76 + 36 };
    case "CLOCK_TIMER":
      if (v === "ALARM") return { width: 900, height: 400 };
      if (v === "STOPWATCH") return { width: 860, height: 380 };
      if (v === "CLOCK") return { width: 640, height: 40 + 520 + (p.title ? 90 : 0) + 30 };
      return { width: 640, height: 40 + 500 + (p.title ? 72 : 0) + (p.subtitle ? 48 : 0) + 30 };
    case "STATUS_ALERT":
      if (v === "TOAST") return { width: 820, height: 132 };
      if (v === "ALERT") {
        const tl = Math.max(1, wrapN(p.title, 40, 624, 2, 1));
        const bl = wrapN(p.body, 34, 624, 5);
        return { width: 720, height: 44 + tl * 48 + (bl ? 12 + bl * 44 : 0) + 36 + (nI > 2 ? nI * 94 : 96) };
      }
      {
        const bl = wrapN(p.body, 34, 672, 3);
        return { width: 760, height: 44 + 132 + 30 + (p.title ? 52 : 0) + (bl ? 8 + bl * 44 : 0) + 44 };
      }
    case "APP_GRID":
      if (v === "STORE") return { width: 960, height: 430 };
      if (v === "DOCK") return { width: 960, height: 230 };
      return { width: 900, height: Math.ceil(Math.max(1, nI) / 4) * 240 + 36 };
    case "KEYNOTE":
      if (v === "SPECS") return { width: 1000, height: head + 330 };
      if (v === "TITLE") {
        const f = keynoteTitleFit(p.title);
        return { width: 1000, height: Math.round(50 + f.lines * f.size * 1.06 + (p.subtitle ? 96 : 0) + 50) };
      }
      if (v === "REVEAL") return { width: 1000, height: p.subtitle ? 520 : 440 };
      return { width: 1000, height: p.subtitle ? 600 : 540 };
    default:
      return null;
  }
};

