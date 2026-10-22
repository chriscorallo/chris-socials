/**
 * On-screen text events (reference learning, docs/PREMIUM_EDITOR_PLAN.md round 4): OCR frames
 * sampled through a reference video → what a viewer SEES as a sequence in time. A block of text
 * that appears, holds and leaves is one event; text that holds ≥ 2 s is a headline, text that
 * changes with speech is a caption. From the events: headline cadence, caption style, the hook
 * text and when it is on screen. PURE — the OCR adapter (ocr.ts, node) produces the frames; this
 * module never reads a file, so it is tested on synthetic frames.
 */
export interface OcrWord {
  text: string;
  /** 0–100. */
  conf: number;
  /** Frame fractions (0–1), top-left origin. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrFrame {
  t: number;
  words: OcrWord[];
}

export type TextBand = "TOP" | "MID" | "LOW";
export type TextRole = "HEADLINE" | "CAPTION" | "OTHER";

export interface TextEvent {
  start: number;
  end: number;
  text: string;
  words: number;
  band: TextBand;
  /** Centre y (0–1) and text height as a fraction of the frame height (median over its life). */
  y: number;
  height: number;
  uppercase: boolean;
  role: TextRole;
}

export interface TextEventOptions {
  minConf: number;
  /** Two blocks on consecutive frames with at least this word overlap are the same block. */
  sameBlockJaccard: number;
  /** A block must be seen for at least this long (s) to count. */
  minLifeS: number;
  /** Holds at least this long → headline. */
  headlineHoldS: number;
  /** Lines closer than this (fraction of frame height) belong to one block. */
  lineGap: number;
}

export const DEFAULT_TEXT_EVENT_OPTIONS: TextEventOptions = {
  minConf: 55,
  sameBlockJaccard: 0.5,
  minLifeS: 0.3,
  headlineHoldS: 2.0,
  lineGap: 0.035,
};

export interface TextStyleSummary {
  /** Frames OCR looked at; events found. */
  frames: number;
  events: TextEvent[];
  headlines: {
    count: number;
    per10s: number;
    holdMedianS: number | null;
    wordsMedian: number | null;
    band: TextBand | null;
    uppercaseShare: number | null;
  };
  captions: {
    present: boolean;
    /** Words per caption chunk (median), the band they sit in, how often they are a single word. */
    wordsPerChunk: number | null;
    band: TextBand | null;
    oneWordShare: number | null;
    uppercaseShare: number | null;
    /** Share of the video's talking time with a caption on screen. */
    coverage: number | null;
  };
  /** The first text on screen and when it appeared (the hook text test: by 1.5 s). */
  hook: { text: string; byS: number } | null;
  /** Longest stretch (s) with no text on screen at all. */
  longestBareS: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9$%'’.,\- ]+/g, " ").replace(/\s+/g, " ").trim();
const tokens = (s: string) => norm(s).split(" ").filter((w) => w.length > 1 || /\d|\$/.test(w));

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function bandOf(y: number): TextBand {
  return y < 0.33 ? "TOP" : y < 0.62 ? "MID" : "LOW";
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)]!;
}

interface Block {
  text: string;
  toks: string[];
  y: number;
  height: number;
  words: number;
  upper: boolean;
}

/** One frame's words → text blocks (lines close in y, merged). */
export function blocksOf(frame: OcrFrame, o: TextEventOptions = DEFAULT_TEXT_EVENT_OPTIONS): Block[] {
  const ws = frame.words
    .filter((w) => w.conf >= o.minConf && norm(w.text).length > 0 && w.h > 0.008 && w.h < 0.3)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: OcrWord[][] = [];
  for (const w of ws) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0]!.y - w.y) < Math.max(last[0]!.h, w.h) * 0.6) last.push(w);
    else lines.push([w]);
  }
  const blocks: Block[] = [];
  for (const line of lines.map((l) => l.sort((a, b) => a.x - b.x))) {
    const text = norm(line.map((w) => w.text).join(" "));
    if (!text) continue;
    const y = line.reduce((s, w) => s + w.y + w.h / 2, 0) / line.length;
    const h = Math.max(...line.map((w) => w.h));
    const raw = line.map((w) => w.text).join(" ");
    const letters = raw.replace(/[^A-Za-z]/g, "");
    const upper = letters.length > 0 && letters === letters.toUpperCase();
    const prev = blocks[blocks.length - 1];
    if (prev && y - prev.y < prev.height + o.lineGap * 2 && Math.abs(h - prev.height) < Math.max(h, prev.height) * 0.5) {
      prev.text = `${prev.text} ${text}`;
      prev.toks = tokens(prev.text);
      prev.y = (prev.y + y) / 2;
      prev.height = Math.max(prev.height, h);
      prev.words = prev.toks.length;
      prev.upper = prev.upper && upper;
    } else blocks.push({ text, toks: tokens(text), y, height: h, words: tokens(text).length, upper });
  }
  return blocks.filter((b) => b.toks.length > 0);
}

/**
 * Frames → events: a block tracked across consecutive frames (same words, same band) is one
 * event; it ends on the first frame it is no longer seen. Caption chunks change text from
 * frame to frame and become separate short events; a headline holds.
 */
export function textEvents(frames: OcrFrame[], options: Partial<TextEventOptions> = {}): TextEvent[] {
  const o = { ...DEFAULT_TEXT_EVENT_OPTIONS, ...options };
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  type Live = { block: Block; start: number; last: number; ys: number[]; hs: number[]; seen: number };
  let live: Live[] = [];
  const done: TextEvent[] = [];
  const step = sorted.length > 1 ? median(sorted.slice(1).map((f, i) => f.t - sorted[i]!.t)) ?? 0.25 : 0.25;
  const close = (l: Live, end: number) => {
    const life = end - l.start;
    if (life < o.minLifeS) return;
    const y = median(l.ys)!;
    done.push({ start: r3(l.start), end: r3(end), text: l.block.text, words: l.block.words, band: bandOf(y), y: r3(y), height: r3(median(l.hs)!), uppercase: l.block.upper, role: "OTHER" });
  };
  for (const f of sorted) {
    const blocks = blocksOf(f, o);
    const matched = new Set<number>();
    const next: Live[] = [];
    for (const l of live) {
      let best = -1;
      let bestJ = 0;
      blocks.forEach((b, i) => {
        if (matched.has(i)) return;
        const j = jaccard(l.block.toks, b.toks);
        if (j >= o.sameBlockJaccard && j > bestJ && Math.abs(b.y - l.block.y) < 0.12) {
          best = i;
          bestJ = j;
        }
      });
      if (best >= 0) {
        matched.add(best);
        const b = blocks[best]!;
        // OCR flickers on a held block: keep the longer reading, the words of the better frame.
        const block = b.toks.length >= l.block.toks.length ? b : l.block;
        next.push({ block, start: l.start, last: f.t, ys: [...l.ys, b.y], hs: [...l.hs, b.height], seen: l.seen + 1 });
      } else close(l, f.t);
    }
    blocks.forEach((b, i) => {
      if (!matched.has(i)) next.push({ block: b, start: f.t, last: f.t, ys: [b.y], hs: [b.height], seen: 1 });
    });
    live = next;
  }
  for (const l of live) close(l, l.last + step);
  return done.sort((a, b) => a.start - b.start);
}

/** Roles: a block that holds ≥ headlineHoldS with ≤ 8 words is a headline; a short block in a
 * chain of short blocks in the same band (text changing with speech) is a caption. */
export function classifyTextEvents(events: TextEvent[], o: TextEventOptions = DEFAULT_TEXT_EVENT_OPTIONS): TextEvent[] {
  const out = events.map((e) => ({ ...e }));
  for (const e of out) if (e.end - e.start >= o.headlineHoldS && e.words <= 8) e.role = "HEADLINE";
  // Caption chains: consecutive short events whose bands match and whose gaps are small.
  const shorts = out.filter((e) => e.role !== "HEADLINE").sort((a, b) => a.start - b.start);
  for (let i = 0; i < shorts.length; i++) {
    const e = shorts[i]!;
    const prev = shorts[i - 1];
    const next = shorts[i + 1];
    const chained = (a: TextEvent | undefined) => !!a && a.band === e.band && Math.abs(a.y - e.y) < 0.08 && Math.min(Math.abs(a.start - e.end), Math.abs(e.start - a.end)) < 0.6;
    if ((chained(prev) || chained(next)) && e.words <= 7) e.role = "CAPTION";
  }
  return out;
}

export function summariseText(frames: OcrFrame[], durationS: number, speech: { startS: number; endS: number } | null, options: Partial<TextEventOptions> = {}): TextStyleSummary {
  const o = { ...DEFAULT_TEXT_EVENT_OPTIONS, ...options };
  const events = classifyTextEvents(textEvents(frames, o), o);
  const heads = events.filter((e) => e.role === "HEADLINE");
  const caps = events.filter((e) => e.role === "CAPTION");
  const mode = (xs: TextBand[]): TextBand | null => {
    if (!xs.length) return null;
    const c = new Map<TextBand, number>();
    for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  };
  const share = (xs: boolean[]) => (xs.length ? r3(xs.filter(Boolean).length / xs.length) : null);
  let capCoverage: number | null = null;
  if (speech && speech.endS > speech.startS && caps.length) {
    const covered = caps.reduce((s, c) => s + Math.max(0, Math.min(c.end, speech.endS) - Math.max(c.start, speech.startS)), 0);
    capCoverage = r3(Math.min(1, covered / (speech.endS - speech.startS)));
  }
  // Bare stretches: nothing on screen.
  const pts = new Set<number>([0, durationS]);
  for (const e of events) pts.add(e.start).add(e.end);
  const sortedPts = [...pts].filter((x) => x >= 0 && x <= durationS).sort((a, b) => a - b);
  let longestBare = 0;
  for (let i = 1; i < sortedPts.length; i++) {
    const a = sortedPts[i - 1]!;
    const b = sortedPts[i]!;
    const mid = (a + b) / 2;
    if (!events.some((e) => e.start <= mid && mid < e.end)) longestBare = Math.max(longestBare, b - a);
  }
  // The hook text: the first headline up within 2 s, else whatever text came first.
  const first = heads.find((h) => h.start <= 2) ?? events[0] ?? null;
  return {
    frames: frames.length,
    events,
    headlines: {
      count: heads.length,
      per10s: durationS > 0 ? r3((heads.length / durationS) * 10) : 0,
      holdMedianS: median(heads.map((h) => r3(h.end - h.start))),
      wordsMedian: median(heads.map((h) => h.words)),
      band: mode(heads.map((h) => h.band)),
      uppercaseShare: share(heads.map((h) => h.uppercase)),
    },
    captions: {
      present: caps.length >= 3,
      wordsPerChunk: median(caps.map((c) => c.words)),
      band: mode(caps.map((c) => c.band)),
      oneWordShare: share(caps.map((c) => c.words === 1)),
      uppercaseShare: share(caps.map((c) => c.uppercase)),
      coverage: capCoverage,
    },
    hook: first ? { text: first.text.slice(0, 120), byS: first.start } : null,
    longestBareS: r3(longestBare),
  };
}
