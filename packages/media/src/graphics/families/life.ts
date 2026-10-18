import type { GraphicProps } from "../contract";
import { lines, spec, type FamilySizer, type Spec } from "./types";

/**
 * LIFE & PLACES family — maps, weather, screen time, payments, rides/deliveries/boarding,
 * dates, trackers, two-column lists (generic, original UI; no real map tiles, brand colours or
 * app layouts). Field mapping:
 *
 * MAP_NAV      ROUTE (items[0] = from, items[1] = to (text, sub); title = destination card,
 *              subtitle = "18 min · 6.2 mi") · PIN (title = place, subtitle = region; a pin
 *              drops with a ripple) · FLIGHT (items[0..1]: text = city, sub = code; an arc + a
 *              plane) · CITIES (items = 2–5 stops connected in order).
 * WEATHER      CARD (title = place, items[0]: value = temperature, text = condition, icon,
 *              sub = "H:78° L:61°"; items[1..] = hourly: text hour, value, icon) · WEEK (items
 *              = days: text day, icon, value = high, sub = low).
 * SCREEN_TIME  title = total ("6h 42m") · subtitle = "Daily average" · series[0] = hours per
 *              day + categories (days) · items = top apps (text, value = minutes, icon).
 *              REPORT · APPS (just the app list).
 * PAYMENT      uses `format` (currency). RECEIVED (title = "You received", subtitle = from,
 *              items[0].value = amount, body = memo) · FEED (items: text = "You paid Alex",
 *              sub = memo, value = amount (negative = paid), meta = time) · RECEIPT (title =
 *              store, items = line items text/value, showTotal) · DECLINED (title, items[0].value).
 * TRAVEL       RIDE (title = driver, subtitle = car + plate, meta = "3 min away", items[0].value
 *              = rating) · DELIVERY (title = "Arriving by 8 PM", items = stages, state DONE =
 *              reached) · BOARDING (items[0] = from: text code, sub city; items[1] = to;
 *              items[2..] = details text label / sub value; title = passenger, meta = flight) ·
 *              TICKET (title = event, subtitle = date, meta = venue, items = details).
 * DATE         FLIP (title = month "MAR", subtitle = weekday, items[0].value → items[1].value =
 *              day numbers flipping) · MONTH (title = month, items[0].value = days crossed off,
 *              subtitle = caption) · YEARS (items[0].value → items[1].value odometer, title) ·
 *              UNTIL (items[0].value = days, title = "days until payday").
 * TRACKER      HABIT (contribution grid: items[0].value = days done of 35, title, subtitle) ·
 *              SETS (title = exercise, items = sets: text, value = reps, state DONE) · MOOD
 *              (faces scale, needle at items[0].value 0–100, title).
 * LIST_SPLIT   two columns: categories[0..1] = headers (defaults per layout) · items: text +
 *              state DONE (left / pro / do / fact) or NO (right / con / don't / myth).
 *              PROS_CONS · DOS_DONTS · MYTH_FACT (rows: myth struck → fact).
 */
export const LIFE_SPECS = {
  MAP_NAV: spec("MAP_NAV", "Map & route", "Route with ETA, pin drop, flight arc, multi-stop trip", "LIFE", [["ROUTE", "Route"], ["PIN", "Pin drop"], ["FLIGHT", "Flight"], ["CITIES", "Trip"]], {
    title: true,
    subtitle: true,
    tone: true,
    items: { count: [0, 5], sub: true },
    labels: { title: "Place / destination", subtitle: "Details", text: "Place", sub: "Code / note", entries: "Places" },
  }, { preferY: 0.38 }),
  WEATHER: spec("WEATHER", "Weather", "Temperature card with hourly strip, or a week forecast", "LIFE", [["CARD", "Now"], ["WEEK", "Week"]], {
    title: true,
    tone: true,
    ownFormat: true,
    items: { count: [1, 7], value: true, sub: true, icon: true },
    labels: { title: "Place", text: "Condition / hour / day", sub: "High-low / low", value: "Temperature", entries: "Hours / days" },
  }, { preferY: 0.34 }),
  SCREEN_TIME: spec("SCREEN_TIME", "Screen time", "Daily average, bars per day, top apps", "LIFE", [["REPORT", "Report"], ["APPS", "Apps"]], {
    title: true,
    subtitle: true,
    tone: true,
    ownFormat: true,
    series: { count: [0, 1], values: [0, 7], label: "SERIES" },
    categories: [0, 7],
    items: { count: [0, 5], value: true, icon: true },
    labels: { title: "Total", subtitle: "Caption", text: "App", value: "Minutes", entries: "Apps" },
  }, { preferY: 0.36 }),
  PAYMENT: spec("PAYMENT", "Payment", "Money received, a payment feed, a receipt printing, declined", "LIFE", [["RECEIVED", "Received"], ["FEED", "Feed"], ["RECEIPT", "Receipt"], ["DECLINED", "Declined"]], {
    title: true,
    subtitle: true,
    body: true,
    tone: true,
    items: { count: [0, 8], value: true, sub: true, meta: "Time" },
    total: true,
    labels: { title: "Title / store", subtitle: "From / line 2", body: "Memo", text: "Line", sub: "Note", value: "Amount", entries: "Lines" },
  }, { preferY: 0.36, toneDefault: "LIGHT" }),
  TRAVEL: spec("TRAVEL", "Ride, delivery & tickets", "Ride on the way, delivery tracker, boarding pass, event ticket", "LIFE", [["RIDE", "Ride"], ["DELIVERY", "Delivery"], ["BOARDING", "Boarding pass"], ["TICKET", "Ticket"]], {
    title: true,
    subtitle: true,
    meta: "Details",
    tone: true,
    ownFormat: true,
    items: { count: [0, 6], value: true, sub: true, state: true },
    labels: { title: "Name / title", subtitle: "Second line", text: "Label / stage", sub: "Value", value: "Number", entries: "Details" },
  }, { preferY: 0.36, toneDefault: "LIGHT" }),
  DATE: spec("DATE", "Date & calendar", "Calendar pages flipping, days crossed off, years ticking, days until", "LIFE", [["FLIP", "Page flip"], ["MONTH", "Month"], ["YEARS", "Years"], ["UNTIL", "Days until"]], {
    title: true,
    subtitle: true,
    tone: true,
    ownFormat: true,
    items: { count: [0, 2], value: true },
    labels: { title: "Month / label", subtitle: "Caption", value: "Day / year", entries: "Numbers" },
  }, { preferY: 0.36, toneDefault: "LIGHT" }),
  TRACKER: spec("TRACKER", "Tracker", "Habit grid, workout sets, mood meter", "LIFE", [["HABIT", "Habit grid"], ["SETS", "Workout sets"], ["MOOD", "Mood meter"]], {
    title: true,
    subtitle: true,
    tone: true,
    ownFormat: true,
    items: { count: [0, 8], value: true, state: true },
    labels: { title: "Habit / exercise", subtitle: "Caption", text: "Set", value: "Reps / days / level", entries: "Sets" },
  }, { preferY: 0.38 }),
  LIST_SPLIT: spec("LIST_SPLIT", "Two-column list", "Pros & cons, do's & don'ts, myth vs fact", "LISTS", [["PROS_CONS", "Pros & cons"], ["DOS_DONTS", "Do / don't"], ["MYTH_FACT", "Myth → fact"]], {
    title: true,
    categories: [0, 2],
    tone: true,
    items: { count: [2, 10], state: true },
    labels: { title: "Title", text: "Point", entries: "Points (✓ left · ✕ right)" },
  }, { preferY: 0.38 }),
} satisfies Record<string, Spec>;

/** Rows a month grid needs (2026 reference year; unknown month → 30 days from Sunday). */
const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_FIRST = [4, 0, 0, 3, 5, 1, 3, 6, 2, 4, 0, 2];
function monthRows(title: string | null): number {
  const t = (title ?? "").trim().toLowerCase();
  const i = MONTH_KEYS.findIndex((m) => t.startsWith(m) || t.includes(` ${m}`));
  return Math.ceil(((i >= 0 ? MONTH_FIRST[i]! : 0) + (i >= 0 ? MONTH_DAYS[i]! : 30)) / 7);
}

/** Content height of the tone-aware title block (title 52 + subtitle 34). */
function hb(p: GraphicProps): number {
  return p.title ? (p.subtitle ? 104 : 62) : p.subtitle ? 40 : 0;
}

export const lifeSize: FamilySizer = (p, v) => {
  const nI = p.items.length;
  const h = hb(p);
  switch (p.component) {
    case "MAP_NAV":
      if (v === "PIN") return { width: 760, height: 760 };
      if (v === "FLIGHT") return { width: 940, height: (p.title ? 96 : 0) + 690 };
      if (v === "CITIES") return { width: 940, height: (h ? 40 + h + 24 : 24) + 520 + 24 };
      return { width: 940, height: 900 };
    case "WEATHER":
      if (v === "WEEK") return { width: 900, height: 40 + (p.title ? 90 : 0) + Math.max(1, nI) * 100 + 36 };
      return { width: 900, height: nI > 1 ? 700 : 480 };
    case "SCREEN_TIME": {
      const apps = Math.min(5, nI);
      if (v === "APPS") return { width: 900, height: 44 + (h ? h + 30 : 0) + Math.max(1, apps) * 110 + 30 };
      const bars = (p.series[0]?.values.length ?? 0) > 0;
      return { width: 940, height: 194 + (bars ? 354 : 0) + (apps ? 20 + apps * 100 : 0) + 34 };
    }
    case "PAYMENT":
      if (v === "FEED") return { width: 940, height: (h ? 40 + h + 16 : 30) + Math.max(1, Math.min(8, nI)) * 150 + 20 };
      if (v === "RECEIPT") return { width: 700, height: 38 + (p.subtitle ? 196 : 156) + Math.max(1, Math.min(8, nI)) * 62 + (p.showTotal ? 114 : 10) + 72 };
      if (v === "DECLINED") return { width: 820, height: 400 };
      return { width: 820, height: p.body?.trim() ? 609 + lines(p.body, 34, 2) * 44 : 550 };
    case "TRAVEL":
      if (v === "DELIVERY") return { width: 920, height: 44 + Math.max(h, 96) + 34 + 76 + Math.max(1, Math.min(6, nI)) * 96 + 30 };
      if (v === "BOARDING") return { width: 900, height: 760 };
      if (v === "TICKET") return { width: 900, height: 600 };
      return { width: 940, height: 600 };
    case "DATE":
      if (v === "MONTH") return { width: 860, height: 44 + h + 30 + 56 + monthRows(p.title) * 96 + 30 };
      if (v === "YEARS") return { width: 900, height: 44 + (p.title ? 70 : 0) + 18 + 195 + (p.subtitle ? 62 : 0) + 40 };
      if (v === "UNTIL") return { width: 760, height: 412 + lines(p.title, 25, 2) * 53 };
      return { width: 620, height: 720 };
    case "TRACKER":
      if (v === "SETS") return { width: 900, height: 44 + (h ? h + 26 : 0) + Math.max(1, Math.min(8, nI)) * 112 + 32 };
      if (v === "MOOD") return { width: 900, height: 44 + (h ? h + 24 : 0) + 270 + 74 + 38 + 134 };
      return { width: 940, height: 44 + h + 28 + 48 + 520 + 18 + 110 };
    case "LIST_SPLIT": {
      const top = 40 + (p.title ? 62 + 24 : 0);
      if (v === "MYTH_FACT") {
        const myths = p.items.filter((i) => i.state === "NO").length;
        const pairs = Math.max(1, myths, nI - myths);
        return { width: 960, height: top + pairs * 230 + (pairs - 1) * 18 + 40 };
      }
      const left = p.items.filter((i) => i.state !== "NO").length;
      const right = nI - left;
      const rows = p.items.reduce((a, it) => Math.max(a, lines(it.text, 16, 3)), 1);
      return { width: 1000, height: top + 112 + Math.max(1, left, right) * (24 + rows * 44) + 40 };
    }
    default:
      return null;
  }
};
