import { diffDaysYmd, ymdInTz } from "../tz";

/**
 * Batch upload: which planned video is each picked clip for? Pure and deterministic.
 *
 * Signals, strongest first:
 *  1. Filename ↔ title similarity ("money-myths take 2.mov" ↔ "5 Money Myths Nobody Tells
 *     You"): token overlap + Jaro-Winkler on the joined words. Camera names (IMG_1234,
 *     VID_20261018_…, "Copy", "trim") carry no information and score 0.
 *  2. Capture date (File.lastModified, in the app's time zone) vs the planned day — filming
 *     happens on or a few days before the post date.
 *     iOS caveat: Safari's Photos picker hands over an exported copy whose lastModified can be
 *     the *pick* time, not the capture time. A timestamp within `pickWindowMinutes` of `now`
 *     is therefore treated as unknown rather than as "filmed today". (docs/decisions-pending/
 *     plan-import.md)
 *  3. Order within a day: clips with no name signal, sorted by capture time, take the planned
 *     videos near that day in order (first clip → earliest planned video).
 * Several clips may map to the same video (takes). Unmatched clips come back with no target —
 * the UI offers "New video" or "Skip".
 */

export interface ClipFile {
  name: string;
  lastModified: number;
  size: number;
}

export interface PlannedTarget {
  id: string;
  title: string;
  /** Planned post day, "YYYY-MM-DD". */
  ymd: string;
}

export type MatchConfidence = "high" | "medium" | "low" | "none";

export interface ClipMatch {
  fileIndex: number;
  contentItemId: string | null;
  confidence: MatchConfidence;
  /** Plain-English why ("Name matches", "Filmed 2 days before"). */
  reason: string;
  score: number;
}

export interface MatchOptions {
  tz: string;
  now: number;
  /** Clip dates within this many minutes of `now` are treated as unknown (see iOS caveat). */
  pickWindowMinutes?: number;
  /** How many days before the post date filming may happen. */
  maxDaysBefore?: number;
  /** How many days after the post date a (late) clip may still match. */
  maxDaysAfter?: number;
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "my", "your", "you", "i", "is", "it", "this", "that",
  "how", "why", "what", "do", "does", "are", "be", "at", "from", "by", "me", "we", "our", "not", "no", "nobody", "about",
  // filename noise
  "img", "vid", "mov", "mp4", "m4v", "hevc", "copy", "trim", "trimmed", "final", "edit", "edited", "take", "takes", "tk", "clip",
  "video", "raw", "export", "v1", "v2", "v3", "part", "pt", "full", "new", "fixed",
]);

function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function tokens(s: string): string[] {
  const spaced = s
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ");
  return spaced
    .split(" ")
    // Pure numbers (IMG_1234, dates, "take 2", "5 myths") carry no reliable signal.
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a ? 1 : 0;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aM = new Array<boolean>(a.length).fill(false);
  const bM = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(i + range + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bM[j] || a[i] !== b[j]) continue;
      aM[i] = bM[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aM[i]) continue;
    while (!bM[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** 0..1 — how much a filename looks like a title. 0 when the name has no meaningful words. */
export function nameSimilarity(fileName: string, title: string): number {
  const f = tokens(fileName);
  const t = tokens(title);
  if (f.length === 0 || t.length === 0) return 0;
  const tset = new Set(t);
  let hits = 0;
  for (const w of new Set(f)) {
    if (tset.has(w)) hits += 1;
    else if (w.length >= 4 && t.some((x) => x.length >= 4 && (x.startsWith(w) || w.startsWith(x) || jaroWinkler(w, x) >= 0.92))) hits += 0.8;
  }
  const overlap = hits / Math.min(new Set(f).size, tset.size);
  const jw = jaroWinkler(f.join(" "), t.join(" "));
  // Overlap is the main signal; JW rescues near-spellings ("moneymyths" vs "money myths").
  return Math.min(1, Math.max(overlap * 0.9 + (overlap > 0 ? 0.1 * jw : 0), jw >= 0.9 ? jw * 0.85 : 0));
}

/** 0..1 — filmed on/just before the planned day scores high; after it, lower; outside the window 0. */
export function dateCloseness(fileYmd: string | null, plannedYmd: string, maxBefore: number, maxAfter: number): number {
  if (!fileYmd) return 0;
  const before = diffDaysYmd(fileYmd, plannedYmd); // >0 = filmed before the post date
  if (before >= 0 && before <= maxBefore) return 1 - before * (0.5 / Math.max(1, maxBefore));
  if (before < 0 && -before <= maxAfter) return 0.4 - (-before - 1) * 0.1;
  return 0;
}

export function matchClipsToPlan(files: ClipFile[], planned: PlannedTarget[], opts: MatchOptions): ClipMatch[] {
  const maxBefore = opts.maxDaysBefore ?? 5;
  const maxAfter = opts.maxDaysAfter ?? 2;
  const pickWindow = (opts.pickWindowMinutes ?? 10) * 60_000;
  const fileYmd = files.map((f) => (f.lastModified > 0 && Math.abs(opts.now - f.lastModified) > pickWindow ? ymdInTz(new Date(f.lastModified), opts.tz) : null));
  const out: (ClipMatch | null)[] = files.map(() => null);
  const used = new Map<string, number>();
  const use = (id: string) => used.set(id, (used.get(id) ?? 0) + 1);

  // 1) Name matches (date as a tie-breaker / confidence booster).
  files.forEach((f, i) => {
    const scored = planned
      .map((p) => {
        const name = nameSimilarity(f.name, p.title);
        const date = dateCloseness(fileYmd[i]!, p.ymd, maxBefore, maxAfter);
        return { p, name, date, total: name + 0.25 * date };
      })
      .filter((s) => s.name >= 0.5)
      .sort((a, b) => b.total - a.total || a.p.ymd.localeCompare(b.p.ymd));
    const best = scored[0];
    if (!best) return;
    const second = scored[1];
    const clear = !second || best.total - second.total >= 0.15;
    // A strong, unambiguous name is enough on its own (people film a week+ ahead).
    const high = best.name >= 0.75 && clear;
    out[i] = {
      fileIndex: i,
      contentItemId: best.p.id,
      confidence: high ? "high" : clear ? "medium" : "low",
      reason: best.date > 0 ? `Name matches · ${dayPhrase(fileYmd[i]!, best.p.ymd)}` : "Name matches",
      score: Math.round(best.total * 100) / 100,
    };
    use(best.p.id);
  });

  // 2) Date + order for the rest: walk clips in capture order; each takes the closest planned
  //    video in its window that nothing else has claimed yet (else shares one as an extra take).
  const rest = files
    .map((f, i) => ({ f, i }))
    .filter(({ i }) => !out[i] && fileYmd[i])
    .sort((a, b) => a.f.lastModified - b.f.lastModified || a.i - b.i);
  for (const { i } of rest) {
    const cands = planned
      .map((p) => ({ p, date: dateCloseness(fileYmd[i]!, p.ymd, maxBefore, maxAfter) }))
      .filter((c) => c.date > 0)
      .sort((a, b) => a.p.ymd.localeCompare(b.p.ymd) || b.date - a.date);
    if (cands.length === 0) continue;
    const fresh = cands.filter((c) => !used.has(c.p.id));
    // Earliest unclaimed planned day first = "order within a day"; prefer one on/after the clip.
    const pick = fresh.find((c) => c.p.ymd >= fileYmd[i]!) ?? fresh[0] ?? cands.sort((a, b) => b.date - a.date)[0]!;
    const only = cands.length === 1;
    out[i] = {
      fileIndex: i,
      contentItemId: pick.p.id,
      confidence: only ? "medium" : "low",
      reason: `${dayPhrase(fileYmd[i]!, pick.p.ymd)}${only ? "" : " · by order"}`,
      score: Math.round(pick.date * 0.5 * 100) / 100,
    };
    use(pick.p.id);
  }

  return out.map(
    (m, i) =>
      m ?? {
        fileIndex: i,
        contentItemId: null,
        confidence: "none" as const,
        reason: fileYmd[i] ? "No planned video near its date" : "No name or date to go on",
        score: 0,
      },
  );
}

function dayPhrase(fileYmd: string, plannedYmd: string): string {
  const d = diffDaysYmd(fileYmd, plannedYmd);
  if (d === 0) return "Filmed on its day";
  if (d > 0) return `Filmed ${d} day${d === 1 ? "" : "s"} before`;
  return `Filmed ${-d} day${d === -1 ? "" : "s"} after`;
}
