import type { Anchor, Film, Shot } from "./dsl/schema";
import { findWordIndex, normalizeWord, tokenizeLine, type LineToken } from "./dsl/words";

/**
 * Timing: turns a validated film + the narration's real word timings into absolute shot
 * windows and anchor times. Pure and deterministic — the same inputs always give the same
 * frames (tested), so the picture is locked to the voice to the frame.
 */

/** One synthesized (or recorded) narration line, times relative to the clip's own start. */
export interface LineClip {
  durationSeconds: number;
  /** Spoken words as the recognizer heard them (Whisper), clip-relative seconds. */
  words: Array<{ word: string; start: number; end: number }>;
}

export interface TimedWord extends LineToken {
  /** Absolute film seconds. */
  start: number;
  end: number;
  /** True when this word's time was interpolated (not matched to a recognized word). */
  interpolated: boolean;
}

export interface ResolvedShot {
  shot: Shot;
  index: number;
  sceneIndex: number;
  sceneId: string;
  startSec: number;
  endSec: number;
  startFrame: number;
  /** Exclusive. */
  endFrame: number;
  /** Absolute seconds where the line's audio clip is placed (null = no line). */
  lineStartSec: number | null;
  lineEndSec: number | null;
  words: TimedWord[];
}

export interface ResolvedFilm {
  film: Film;
  fps: number;
  durationSeconds: number;
  totalFrames: number;
  shots: ResolvedShot[];
  /** Was timing measured from real narration audio (vs. estimated at a reading pace)? */
  measured: boolean;
}

/** Reading pace used before narration exists (storyboards / previews). ~156 wpm. */
export const ESTIMATED_WORDS_PER_SECOND = 2.6;
export const DEFAULT_LINE_GAP = 0.18;

/** A line clip estimated from text alone (words spread by character weight). */
export function estimateLineClip(line: string): LineClip {
  const tokens = tokenizeLine(line);
  const dur = Math.max(0.6, tokens.length / ESTIMATED_WORDS_PER_SECOND);
  const weights = tokens.map((t) => 1 + t.norm.length * 0.18);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = 0.05;
  const span = dur - 0.1;
  const words = tokens.map((tok, i) => {
    const w = (weights[i]! / total) * span;
    const out = { word: tok.raw, start: t, end: t + w * 0.92 };
    t += w;
    return out;
  });
  return { durationSeconds: dur, words };
}

/**
 * Aligns the script's tokens to the recognizer's words (Needleman–Wunsch on normalized
 * strings; digits compare by value so "$10,000" ↔ "10,000"). Unmatched script tokens get
 * times interpolated between their matched neighbors — a word anchor always resolves.
 */
export function alignWords(tokens: LineToken[], heard: LineClip["words"], clipDuration: number): Array<{ start: number; end: number; interpolated: boolean }> {
  const h = heard.map((w) => ({ ...w, norm: normalizeWord(w.word) })).filter((w) => w.norm.length > 0);
  const match = alignTokenMatches(tokens, h);
  const out: Array<{ start: number; end: number; interpolated: boolean }> = new Array(tokens.length);
  for (let k = 0; k < tokens.length; k++) {
    const mk = match[k];
    if (mk !== null && mk !== undefined) out[k] = { start: h[mk]!.start, end: h[mk]!.end, interpolated: false };
  }
  return interpolateGaps(out, clipDuration);
}

/**
 * Needleman–Wunsch alignment of script tokens to recognized words (already filtered to words
 * with a non-empty norm). Returns, per token, the index of the heard word it matched (or null).
 */
export function alignTokenMatches(tokens: LineToken[], h: Array<{ norm: string }>): Array<number | null> {
  const n = tokens.length;
  const m = h.length;
  const sim = (a: string, b: string): number => {
    if (a === b) return 2;
    const da = a.replace(/\D/g, "");
    const db = b.replace(/\D/g, "");
    if (da && da === db) return 2;
    if (a.length > 3 && b.length > 3 && (a.startsWith(b) || b.startsWith(a))) return 1;
    return -1;
  };
  const GAP = -0.6;
  const score: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) score[i]![0] = i * GAP;
  for (let j = 1; j <= m; j++) score[0]![j] = j * GAP;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      score[i]![j] = Math.max(score[i - 1]![j - 1]! + sim(tokens[i - 1]!.norm, h[j - 1]!.norm), score[i - 1]![j]! + GAP, score[i]![j - 1]! + GAP);
    }
  }
  const match: Array<number | null> = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const s = score[i]![j]!;
    const d = sim(tokens[i - 1]!.norm, h[j - 1]!.norm);
    if (s === score[i - 1]![j - 1]! + d && d > 0) {
      match[i - 1] = j - 1;
      i--;
      j--;
    } else if (s === score[i - 1]![j]! + GAP) i--;
    else j--;
  }
  return match;
}

/** Fills unmatched slots by spreading them evenly between their matched neighbors (or the clip edges). */
export function interpolateGaps(out: Array<{ start: number; end: number; interpolated: boolean } | undefined>, clipDuration: number): Array<{ start: number; end: number; interpolated: boolean }> {
  const n = out.length;
  let k = 0;
  while (k < n) {
    if (out[k]) {
      k++;
      continue;
    }
    let e = k;
    while (e < n && !out[e]) e++;
    const left = k > 0 ? out[k - 1]!.end : 0;
    const right = e < n ? out[e]!.start : clipDuration;
    const span = Math.max(0.01, right - left);
    const cnt = e - k;
    for (let q = 0; q < cnt; q++) {
      const s = left + (span * q) / cnt;
      out[k + q] = { start: s, end: s + (span / cnt) * 0.9, interpolated: true };
    }
    k = e;
  }
  return out as Array<{ start: number; end: number; interpolated: boolean }>;
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * Lays the shots end to end. A shot = leadIn + line + hold (gap), or its fixed duration (never
 * shorter than its line — a too-short duration is stretched so no word is cut off).
 * `clips` = per-shot narration (by shot id); missing clips are estimated from the text.
 */
export function resolveFilm(film: Film, clips: Record<string, LineClip> | null = null): ResolvedFilm {
  const fps = film.format.fps;
  const gap = film.narration?.gapSeconds ?? DEFAULT_LINE_GAP;
  const shots: ResolvedShot[] = [];
  let t = 0;
  let index = 0;
  let measured = !!clips;
  film.scenes.forEach((scene, sceneIndex) => {
    for (const shot of scene.shots) {
      let lineStart: number | null = null;
      let lineEnd: number | null = null;
      let words: TimedWord[] = [];
      let natural = 0;
      if (shot.line) {
        const real = clips?.[shot.id];
        if (!real) measured = false;
        const clip = real ?? estimateLineClip(shot.say ?? shot.line);
        const tokens = tokenizeLine(shot.line);
        const aligned = alignWords(tokens, clip.words, clip.durationSeconds);
        lineStart = t + (shot.leadIn ?? 0);
        lineEnd = lineStart + clip.durationSeconds;
        const ls = lineStart;
        words = tokens.map((tok, i) => ({ ...tok, start: round(ls + aligned[i]!.start), end: round(ls + aligned[i]!.end), interpolated: aligned[i]!.interpolated }));
        natural = (shot.leadIn ?? 0) + clip.durationSeconds + (shot.hold ?? gap);
      }
      const dur = Math.max(shot.duration ?? 0, natural, 0.3);
      // Frame-quantize shot boundaries (start of every shot is an exact frame).
      const startFrame = Math.round(t * fps);
      const endFrame = Math.max(startFrame + 1, Math.round((t + dur) * fps));
      shots.push({
        shot,
        index: index++,
        sceneIndex,
        sceneId: scene.id,
        startSec: startFrame / fps,
        endSec: endFrame / fps,
        startFrame,
        endFrame,
        lineStartSec: lineStart === null ? null : round(lineStart),
        lineEndSec: lineEnd === null ? null : round(lineEnd),
        words,
      });
      t = endFrame / fps;
    }
  });
  const totalFrames = shots.length ? shots[shots.length - 1]!.endFrame : 1;
  return { film, fps, durationSeconds: totalFrames / fps, totalFrames, shots, measured };
}

/** Absolute seconds of an anchor inside a resolved shot. Unknown words fall back to the shot start. */
export function resolveAnchor(rs: ResolvedShot, anchor: Anchor | undefined, fallback: "start" | "end" = "start"): number {
  const len = rs.endSec - rs.startSec;
  if (anchor === undefined) return fallback === "start" ? rs.startSec : rs.endSec;
  if (typeof anchor === "number") return rs.startSec + Math.min(anchor, len);
  if (anchor === "start") return rs.startSec;
  if (anchor === "end") return rs.endSec;
  if ("fraction" in anchor) return rs.startSec + len * anchor.fraction;
  const idx = findWordIndex(rs.words, anchor.word, anchor.occurrence ?? 1);
  if (idx < 0) return rs.startSec;
  const w = rs.words[idx]!;
  return (anchor.edge === "end" ? w.end : w.start) + (anchor.offset ?? 0);
}

export function anchorFrame(rf: ResolvedFilm, rs: ResolvedShot, anchor: Anchor | undefined, fallback: "start" | "end" = "start"): number {
  return Math.round(resolveAnchor(rs, anchor, fallback) * rf.fps);
}

export function shotAtFrame(rf: ResolvedFilm, frame: number): ResolvedShot {
  // binary search
  let lo = 0;
  let hi = rf.shots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rf.shots[mid]!.startFrame <= frame) lo = mid;
    else hi = mid - 1;
  }
  return rf.shots[lo]!;
}
