import { diffDaysYmd } from "../tz";
import { jaroWinkler, tokens } from "../plan-import/match";
import { normalizeTitleKey } from "../plan-import/rows";
import { straightenQuotes, type ParsedScriptBlock } from "./parse";

/**
 * Which planned video is each pasted ChatGPT script for? Pure and deterministic.
 *
 * Signals, strongest first:
 *  1. The 4-character video code the prompt gave every video ("K3F9") — only trusted when the
 *     title or date doesn't contradict it (a code collision or a code ChatGPT moved to the
 *     wrong block must not silently win).
 *  2. Title similarity (case / punctuation / emoji / smart quotes ignored; token overlap +
 *     Jaro-Winkler), with the hook as a second opinion.
 *  3. The planned day.
 *  4. Order within a day: the leftover scripts on a day take that day's leftover videos in
 *     posting order, by the VIDEO number (a weak hint — ChatGPT renumbers freely).
 * One script per video. Every match carries a confidence Chris sees: Exact / Likely / Pick one.
 */

export interface ScriptTarget {
  id: string;
  title: string;
  /** Planned post day "YYYY-MM-DD". */
  ymd: string;
  /** "HH:MM" — orders a day's videos. */
  time?: string | null;
  code: string;
  hook?: string | null;
}

export type ScriptMatchConfidence = "exact" | "likely" | "pick";

export interface ScriptBlockMatch {
  blockIndex: number;
  /** Chosen video, or null (Chris picks one, makes a new video, or skips). */
  targetId: string | null;
  confidence: ScriptMatchConfidence;
  /** Plain English ("Code and title match", "Same day, same order"). */
  reason: string;
  /** Best candidates first (for the "change video" picker). */
  suggestions: string[];
}

// ---------- video codes ----------

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I / O (look like 1 / 0)
const DIGITS = "23456789";

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Letter-digit-letter-digit, derived only from the video's id — so a prompt copied today still
 * matches next week, whatever else was planned since. ~37k codes: two videos can share one
 * (rare); the matcher then lets the title/date decide, never the code alone.
 */
export function videoCode(id: string): string {
  let h = fnv(id);
  let out = "";
  for (let i = 0; i < 4; i++) {
    const alphabet = i % 2 === 0 ? LETTERS : DIGITS;
    out += alphabet[h % alphabet.length];
    h = Math.floor(h / alphabet.length);
  }
  return out;
}

// ---------- similarity ----------

function words(s: string): string[] {
  // Emoji / symbols drop out in tokens(); numbers are kept here ("401k", "$100k" matter in titles).
  const t = tokens(straightenQuotes(s));
  const nums = (straightenQuotes(s).toLowerCase().match(/\$?\d[\d,.]*k?%?/g) ?? []).map((n) => n.replace(/[$,]/g, ""));
  return [...t, ...nums];
}

/** 0..1 — how alike two titles (or hooks) are. */
export function titleSimilarity(a: string, b: string): number {
  const ka = normalizeTitleKey(straightenQuotes(a));
  const kb = normalizeTitleKey(straightenQuotes(b));
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const wa = [...new Set(words(a))];
  const wb = [...new Set(words(b))];
  if (wa.length === 0 || wb.length === 0) return jaroWinkler(ka, kb) >= 0.95 ? 0.9 : 0;
  const setB = new Set(wb);
  let hits = 0;
  for (const w of wa) {
    if (setB.has(w)) hits += 1;
    else if (w.length >= 4 && wb.some((x) => x.length >= 4 && (x.startsWith(w) || w.startsWith(x) || jaroWinkler(w, x) >= 0.92))) hits += 0.8;
  }
  const dice = (2 * hits) / (wa.length + wb.length);
  const containment = hits / Math.min(wa.length, wb.length);
  // A shortened title ("Six figures, still broke") mostly contained in the real one still counts.
  const contained = (ka.includes(kb) || kb.includes(ka)) && Math.min(ka.length, kb.length) >= 12 ? 0.9 : 0;
  return Math.min(1, Math.max(contained, dice * 0.6 + containment * 0.4, jaroWinkler(ka, kb) >= 0.93 ? 0.85 : 0));
}

function dateScore(blockYmd: string | null, targetYmd: string): number | null {
  if (!blockYmd) return null;
  const d = Math.abs(diffDaysYmd(blockYmd, targetYmd));
  return d === 0 ? 1 : d === 1 ? 0.5 : d <= 3 ? 0.2 : 0;
}

interface Pair {
  b: number;
  t: number;
  score: number;
  confidence: ScriptMatchConfidence | null;
  reason: string;
}

function judge(block: ParsedScriptBlock, target: ScriptTarget): Pair & { b: -1; t: -1 } {
  const tSim = block.title ? titleSimilarity(block.title, target.title) : 0;
  const hSim = block.hook && target.hook ? titleSimilarity(block.hook, target.hook) : 0;
  const d = dateScore(block.ymd, target.ymd);
  const codeHit = !!block.code && block.code === target.code;
  const textSim = Math.max(tSim, hSim * 0.85);
  const base = { b: -1 as const, t: -1 as const };
  if (codeHit) {
    const agrees = tSim >= 0.3 || hSim >= 0.5 || d === 1 || (!block.title && d == null);
    return {
      ...base,
      // A code the title/date contradict ranks below a real title + date match.
      score: agrees ? 3 + textSim + (d ?? 0) : 0.9,
      confidence: agrees ? "exact" : "likely",
      reason: agrees ? (tSim >= 0.3 ? "Code and title match" : d === 1 ? "Code and date match" : "Code matches") : "Code matches, but the title looks different",
    };
  }
  const score = textSim * 0.7 + (d ?? 0) * 0.3;
  if (tSim >= 0.9 && (d === 1 || d == null)) return { ...base, score: score + 1, confidence: "exact", reason: d === 1 ? "Title and date match" : "Title matches" };
  if (tSim >= 0.85 && d != null && d >= 0.5) return { ...base, score: score + 0.8, confidence: "likely", reason: "Title matches, date is a day off" };
  if (tSim >= 0.6 && (d == null || d >= 0.2)) return { ...base, score: score + 0.5, confidence: "likely", reason: "Title is close" };
  if (tSim >= 0.6) return { ...base, score: score + 0.3, confidence: "likely", reason: "Title is close, but the date is different" };
  if (d === 1 && (tSim >= 0.35 || hSim >= 0.6)) return { ...base, score: score + 0.4, confidence: "likely", reason: tSim >= 0.35 ? "Same day, similar title" : "Same day, same hook" };
  return { ...base, score, confidence: null, reason: "" };
}

export function matchScriptBlocks(blocks: readonly ParsedScriptBlock[], targets: readonly ScriptTarget[]): ScriptBlockMatch[] {
  const pairs: Pair[] = [];
  const scoreTable: number[][] = blocks.map(() => targets.map(() => 0));
  for (const [bi, block] of blocks.entries()) {
    for (const [ti, target] of targets.entries()) {
      const j = judge(block, target);
      scoreTable[bi]![ti] = j.score;
      if (j.confidence) pairs.push({ ...j, b: bi, t: ti });
    }
  }
  // Greedy one-to-one, best first (exact before likely at equal score).
  const rank = (c: ScriptMatchConfidence | null) => (c === "exact" ? 0 : 1);
  pairs.sort((x, y) => y.score - x.score || rank(x.confidence) - rank(y.confidence) || x.b - y.b || x.t - y.t);
  const byBlock = new Map<number, Pair>();
  const claimed = new Set<number>();
  for (const p of pairs) {
    if (byBlock.has(p.b) || claimed.has(p.t)) continue;
    byBlock.set(p.b, p);
    claimed.add(p.t);
  }

  // Order within a day for whatever is left.
  const orderPick = new Map<number, { t: number; sure: boolean }>();
  const leftoverByDay = new Map<string, number[]>();
  for (const [bi, block] of blocks.entries()) {
    if (byBlock.has(bi) || !block.ymd) continue;
    leftoverByDay.set(block.ymd, [...(leftoverByDay.get(block.ymd) ?? []), bi]);
  }
  for (const [ymd, bis] of leftoverByDay) {
    const free = targets
      .map((t, ti) => ({ t, ti }))
      .filter(({ t, ti }) => t.ymd === ymd && !claimed.has(ti))
      .sort((a, b) => (a.t.time ?? "").localeCompare(b.t.time ?? ""))
      .map(({ ti }) => ti);
    const ordered = [...bis].sort((a, b) => (blocks[a]!.number ?? a + 1000) - (blocks[b]!.number ?? b + 1000) || a - b);
    const sure = ordered.length === 1 && free.length === 1;
    ordered.forEach((bi, k) => {
      if (free[k] != null) orderPick.set(bi, { t: free[k]!, sure });
    });
    if (sure) claimed.add(free[0]!);
  }

  return blocks.map((block, bi) => {
    const ranked = targets
      .map((t, ti) => ({ ti, s: scoreTable[bi]![ti]! + (block.ymd && t.ymd === block.ymd ? 0.15 : 0) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 6)
      .map((x) => x.ti);
    const hit = byBlock.get(bi);
    if (hit) {
      return { blockIndex: bi, targetId: targets[hit.t]!.id, confidence: hit.confidence!, reason: hit.reason, suggestions: ranked.map((ti) => targets[ti]!.id) };
    }
    const ord = orderPick.get(bi);
    if (ord) {
      const suggestions = [ord.t, ...ranked.filter((ti) => ti !== ord.t)].map((ti) => targets[ti]!.id);
      return ord.sure
        ? { blockIndex: bi, targetId: targets[ord.t]!.id, confidence: "likely" as const, reason: "Only video left on that day", suggestions }
        : { blockIndex: bi, targetId: null, confidence: "pick" as const, reason: "Same day — check which one", suggestions };
    }
    return {
      blockIndex: bi,
      targetId: null,
      confidence: "pick" as const,
      reason: block.ymd ? "No planned video matches this title and day" : "No date and no matching title",
      suggestions: ranked.map((ti) => targets[ti]!.id),
    };
  });
}
