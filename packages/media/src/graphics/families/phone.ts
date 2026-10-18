import { lines, spec, type FamilySizer, type Spec } from "./types";

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
 *              subtitle = date. STACK · LOCK (lock screen) · BANNER (one big banner).
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

export const phoneSize: FamilySizer = (p, v, head) => {
  const nI = p.items.length;
  switch (p.component) {
    case "DM_CHAT": {
      const bubbles = p.items.reduce((a, it) => a + Math.max(1, lines(it.text, 22, 6)) * 50 + 46 + (v === "GROUP" && it.side === "THEM" && it.sub ? 36 : 0) + (it.icon ? 18 : 0), 0);
      const chrome = v === "BUBBLES" ? 40 : 190;
      return { width: 900, height: chrome + bubbles + (p.meta ? 46 : 0) + 30 };
    }
    case "NOTIFICATION":
      if (v === "LOCK") return { width: 940, height: 470 + Math.max(1, nI) * 176 + 40 };
      if (v === "BANNER") return { width: 960, height: 230 + Math.max(0, lines(p.items[0]?.sub, 34, 3) - 1) * 44 };
      return { width: 960, height: Math.max(1, nI) * 186 + 30 };
    case "CALL":
      if (v === "BANNER") return { width: 960, height: 220 };
      if (v === "MISSED") return { width: 940, height: 220 };
      if (v === "VIDEO") return { width: 760, height: 1240 };
      return { width: 760, height: 1100 };
    case "PHONE_APP":
      if (v === "EMAIL") return { width: 940, height: 300 + Math.max(2, lines(p.body, 34, 9)) * 48 + 40 };
      if (v === "INVITE") return { width: 920, height: 420 + (nI ? 110 : 0) };
      if (v === "INBOX") return { width: 960, height: 130 + Math.max(1, nI) * 150 + 20 };
      return { width: 880, height: (p.title ? 150 : 60) + Math.max(1, nI) * 96 + 50 };
    case "CLOCK_TIMER":
      if (v === "ALARM") return { width: 900, height: 300 };
      if (v === "CLOCK") return { width: 640, height: p.title ? 760 : 680 };
      if (v === "STOPWATCH") return { width: 860, height: 340 };
      return { width: 640, height: 700 };
    case "STATUS_ALERT":
      if (v === "TOAST") return { width: 820, height: 150 };
      if (v === "ALERT") return { width: 760, height: 220 + lines(p.body, 30, 5) * 46 + (nI > 2 ? nI * 100 : 100) };
      return { width: 760, height: 330 + lines(p.body, 30, 3) * 44 };
    case "APP_GRID":
      if (v === "STORE") return { width: 960, height: 400 };
      if (v === "DOCK") return { width: 960, height: 240 };
      return { width: 900, height: Math.ceil(Math.max(1, nI) / 4) * 250 + 60 };
    case "KEYNOTE":
      if (v === "SPECS") return { width: 1000, height: head + 420 };
      if (v === "TITLE") return { width: 1000, height: 260 + lines(p.title, 14, 3) * 130 + (p.subtitle ? 90 : 0) };
      if (v === "REVEAL") return { width: 1000, height: 520 };
      return { width: 1000, height: 560 + (p.subtitle ? 60 : 0) };
    default:
      return null;
  }
};
