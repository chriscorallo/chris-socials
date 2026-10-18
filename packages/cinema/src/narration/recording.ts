import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Film } from "../dsl/schema";
import { normalizeWord, tokenizeLine, type LineToken } from "../dsl/words";
import { alignTokenMatches, interpolateGaps } from "../timing";
import { runFfmpeg, probeDurationSeconds } from "../audio/ffmpeg";
import { defaultTranscriber, type NarratedLine, type WordTranscriber } from "./narrate";

/**
 * Chris's own voice: narration from ONE uploaded recording of the whole script (engine "CHRIS").
 *
 * The recording is transcribed by the local Whisper; every shot's line (the `line`, as written)
 * is aligned against what was actually heard (Needleman–Wunsch on normalized words, digits by
 * value), so small deviations — an extra "so", a skipped "just", a re-take of a phrase — are
 * tolerated and reported instead of breaking the film. Each shot's clip is cut from the real
 * recording (with a little air around the words) and its word times drive the picture exactly
 * like synthesized narration does. Pure alignment is `alignRecordingWords` (tested); the I/O
 * wrapper is `narrationFromRecording`.
 */

export interface RecordingAlignmentReport {
  ok: boolean;
  /** Script words found in the recording / all script words. */
  matchedRatio: number;
  /** Script words not heard (by shot). */
  missedWords: Array<{ shotId: string; word: string }>;
  /** Heard words that aren't in the script (ad-libs, repeats, filler). */
  extraWords: Array<{ word: string; at: number }>;
  shots: Array<{ shotId: string; start: number; end: number; matched: number; total: number }>;
  /** Plain-English problems (why ok is false, or warnings). */
  problems: string[];
}

export interface AlignedShot {
  shotId: string;
  /** Clip window in the recording (seconds). */
  start: number;
  end: number;
  /** Word times relative to the clip start. */
  words: Array<{ word: string; start: number; end: number }>;
}

const PAD_BEFORE = 0.12;
const PAD_AFTER = 0.18;
/** Below this share of matched script words the recording is treated as the wrong take. */
export const MIN_MATCHED_RATIO = 0.6;

/** Aligns the film's lines against the recognized words of one recording (pure). */
export function alignRecordingWords(film: Film, heard: Array<{ word: string; start: number; end: number }>, recordingDuration: number): { shots: AlignedShot[]; report: RecordingAlignmentReport } {
  const lines: Array<{ shotId: string; tokens: LineToken[] }> = [];
  for (const sc of film.scenes) for (const sh of sc.shots) if (sh.line) lines.push({ shotId: sh.id, tokens: tokenizeLine(sh.line) });
  const all = lines.flatMap((l, li) => l.tokens.map((t) => ({ ...t, li })));
  const h = heard.map((w) => ({ ...w, norm: normalizeWord(w.word) })).filter((w) => w.norm.length > 0);
  const match = alignTokenMatches(all, h);
  const used = new Set<number>();
  match.forEach((m) => m !== null && used.add(m));
  const missedWords: RecordingAlignmentReport["missedWords"] = [];
  const shots: AlignedShot[] = [];
  const reportShots: RecordingAlignmentReport["shots"] = [];
  const problems: string[] = [];
  let offset = 0;
  let prevEnd = 0;
  lines.forEach((l, li) => {
    const n = l.tokens.length;
    const idx = match.slice(offset, offset + n);
    const timed = idx.map((m) => (m === null ? undefined : { start: h[m]!.start, end: h[m]!.end, interpolated: false }));
    const matched = timed.filter(Boolean).length;
    idx.forEach((m, k) => m === null && missedWords.push({ shotId: l.shotId, word: l.tokens[k]!.raw }));
    const firstT = timed.find(Boolean);
    const lastT = [...timed].reverse().find(Boolean);
    // the next line's first heard word bounds this clip's end (never bleed into the next line)
    let nextStart = recordingDuration;
    for (let q = offset + n; q < match.length; q++) {
      if (match[q] !== null) {
        nextStart = h[match[q]!]!.start;
        break;
      }
    }
    if (!firstT || !lastT) {
      problems.push(`Couldn't find the line for shot "${l.shotId}" ("${film.scenes.flatMap((s) => s.shots).find((s) => s.id === l.shotId)?.line}") in the recording.`);
      shots.push({ shotId: l.shotId, start: prevEnd, end: prevEnd, words: [] });
      reportShots.push({ shotId: l.shotId, start: prevEnd, end: prevEnd, matched: 0, total: n });
      offset += n;
      return;
    }
    const start = Math.max(prevEnd, firstT.start - PAD_BEFORE);
    const end = Math.min(nextStart - 0.02, lastT.end + PAD_AFTER, recordingDuration);
    // unmatched words inside the clip get interpolated times; relative to the clip start
    const rel = timed.map((x) => (x ? { start: x.start - start, end: x.end - start, interpolated: false } : undefined));
    const filled = interpolateGaps(rel, end - start);
    shots.push({ shotId: l.shotId, start, end, words: filled.map((w, k) => ({ word: l.tokens[k]!.raw, start: Math.max(0, w.start), end: Math.max(0, w.end) })) });
    reportShots.push({ shotId: l.shotId, start: round(start), end: round(end), matched, total: n });
    prevEnd = end;
    offset += n;
    void li;
  });
  const extraWords = h.map((w, i) => ({ w, i })).filter(({ i }) => !used.has(i)).map(({ w }) => ({ word: w.word.trim(), at: round(w.start) }));
  const matchedRatio = all.length ? (all.length - missedWords.length) / all.length : 1;
  if (matchedRatio < MIN_MATCHED_RATIO) problems.unshift(`Only ${Math.round(matchedRatio * 100)}% of the script was found in the recording — is this the right take?`);
  if (missedWords.length && matchedRatio >= MIN_MATCHED_RATIO) problems.push(`${missedWords.length} script word(s) weren't heard (timed by interpolation): ${missedWords.slice(0, 8).map((m) => `"${m.word}"`).join(", ")}${missedWords.length > 8 ? "…" : ""}.`);
  if (extraWords.length) problems.push(`${extraWords.length} extra word(s) in the recording that aren't in the script (kept in the audio): ${extraWords.slice(0, 8).map((e) => `"${e.word}"`).join(", ")}${extraWords.length > 8 ? "…" : ""}.`);
  const ok = matchedRatio >= MIN_MATCHED_RATIO && shots.every((s) => s.words.length > 0);
  return { shots, report: { ok, matchedRatio: round(matchedRatio), missedWords, extraWords, shots: reportShots, problems } };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Chris recorded each line separately (the studio's per-shot recorder: shot id → file). Each take
 * is trimmed of leading/trailing silence, transcribed and aligned to its own line; the same report
 * as the one-take path (missing shots, unheard and extra words). A shot with a line but no take
 * is an error (report.ok false) — nothing is silently synthesized in his place.
 */
export async function narrationFromShotRecordings(input: { film: Film; recordings: Record<string, string>; outDir: string; transcriber?: WordTranscriber }): Promise<{ lines: Record<string, NarratedLine>; report: RecordingAlignmentReport }> {
  const transcriber = input.transcriber ?? (await defaultTranscriber());
  const dir = join(input.outDir, "chris-lines");
  await mkdir(dir, { recursive: true });
  const lines: Record<string, NarratedLine> = {};
  const missedWords: RecordingAlignmentReport["missedWords"] = [];
  const extraWords: RecordingAlignmentReport["extraWords"] = [];
  const shots: RecordingAlignmentReport["shots"] = [];
  const problems: string[] = [];
  let total = 0;
  for (const sc of input.film.scenes) {
    for (const sh of sc.shots) {
      if (!sh.line) continue;
      const tokens = tokenizeLine(sh.line);
      total += tokens.length;
      const src = input.recordings[sh.id];
      if (!src) {
        problems.push(`No recording for shot "${sh.id}" ("${sh.line}").`);
        missedWords.push(...tokens.map((t) => ({ shotId: sh.id, word: t.raw })));
        shots.push({ shotId: sh.id, start: 0, end: 0, matched: 0, total: tokens.length });
        continue;
      }
      const wav = join(dir, `${sh.id}.wav`);
      await runFfmpeg(["-i", src, "-vn", "-ac", "1", "-ar", "24000", "-af", "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.12,areverse", "-c:a", "pcm_s16le", wav]);
      const duration = await probeDurationSeconds(wav);
      const tr = await transcriber.transcribe(wav);
      const h = tr.words.map((w) => ({ ...w, norm: normalizeWord(w.word) })).filter((w) => w.norm.length > 0);
      const match = alignTokenMatches(tokens, h);
      const used = new Set(match.filter((m): m is number => m !== null));
      const timed = match.map((m) => (m === null ? undefined : { start: h[m]!.start, end: h[m]!.end, interpolated: false }));
      match.forEach((m, k) => m === null && missedWords.push({ shotId: sh.id, word: tokens[k]!.raw }));
      h.forEach((w, i) => !used.has(i) && extraWords.push({ word: w.word.trim(), at: round(w.start) }));
      const filled = interpolateGaps(timed, duration);
      lines[sh.id] = { path: wav, durationSeconds: duration, words: filled.map((w, k) => ({ word: tokens[k]!.raw, start: w.start, end: w.end })), heard: tr.text.trim() };
      shots.push({ shotId: sh.id, start: 0, end: round(duration), matched: timed.filter(Boolean).length, total: tokens.length });
    }
  }
  const matchedRatio = total ? (total - missedWords.length) / total : 1;
  if (matchedRatio < MIN_MATCHED_RATIO) problems.unshift(`Only ${Math.round(matchedRatio * 100)}% of the script was heard in the recordings — re-record the lines that don't match.`);
  const ok = matchedRatio >= MIN_MATCHED_RATIO && shots.every((s) => s.matched > 0);
  return { lines: ok ? lines : {}, report: { ok, matchedRatio: round(matchedRatio), missedWords, extraWords, shots, problems } };
}

/**
 * The function the app calls after Chris uploads (or records) his narration: transcribe → align →
 * cut one clip per shot. Returns lines ready for `renderFilm({ narration })` / the film-render
 * job, plus the report to show him ("2 words weren't heard: …"). Never throws for a bad take —
 * `report.ok` is false with the reason.
 */
export async function narrationFromRecording(input: { film: Film; recordingPath: string; outDir: string; transcriber?: WordTranscriber }): Promise<{ lines: Record<string, NarratedLine>; report: RecordingAlignmentReport }> {
  const transcriber = input.transcriber ?? (await defaultTranscriber());
  // normalize to 24 kHz mono WAV first (any upload format: m4a, mp3, wav, a phone's .mov audio)
  await mkdir(join(input.outDir, "chris-lines"), { recursive: true });
  const wav = join(input.outDir, "chris-lines", "recording.wav");
  await runFfmpeg(["-i", input.recordingPath, "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", wav]);
  const duration = await probeDurationSeconds(wav);
  const tr = await transcriber.transcribe(wav);
  const { shots, report } = alignRecordingWords(input.film, tr.words, duration);
  const lines: Record<string, NarratedLine> = {};
  if (!report.ok) return { lines, report };
  for (const s of shots) {
    const path = join(input.outDir, "chris-lines", `${s.shotId}.wav`);
    await runFfmpeg(["-i", wav, "-ss", s.start.toFixed(3), "-to", s.end.toFixed(3), "-af", "afade=t=in:d=0.02,areverse,afade=t=in:d=0.04,areverse", "-c:a", "pcm_s16le", path]);
    lines[s.shotId] = { path, durationSeconds: s.end - s.start, words: s.words, heard: s.words.map((w) => w.word).join(" ") };
  }
  return { lines, report };
}
