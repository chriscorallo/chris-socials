/**
 * Voice audition: speaks the same two-sentence narration with every English Kokoro voice (or a
 * given list), then measures what can be measured without ears:
 *   - intelligibility: the local Whisper transcribes it back → word error rate vs the script;
 *   - expressiveness: F0 (pitch) spread in semitones over voiced frames (monotone ↔ lively);
 *   - pace: words per second; synthesis speed (× real time);
 *   - noise/hiss: energy above 7 kHz relative to the whole (q8 artifacts show up here).
 * Writes <out>/<voice>.wav, report.json. Listening is still Chris's call; this ranks candidates.
 *   pnpm --filter @chris/cinema exec tsx scripts/voice-audition.ts <outDir> [--voices a,b] [--dtype q8|fp32] [--speed 0.95]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalWhisperTranscriptionProvider } from "@chris/media/transcription";
import { encodeWav, loadKokoro, trimSilence } from "../src/narration/kokoro";
import { KOKORO_ENGLISH_VOICES } from "../src/narration/voices";
import { normalizeWord } from "../src/dsl/words";
import { levenshtein } from "../src/dsl/words";

const out = process.argv[2] ?? join(process.cwd(), ".cache", "voice-audition");
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const voices = arg("voices")?.split(",") ?? KOKORO_ENGLISH_VOICES.map((v) => v.id);
const dtype = (arg("dtype") ?? "q8") as "q8" | "fp32";
const speed = Number(arg("speed") ?? 0.95);
export const AUDITION_LINE = "Your ten thousand dollar raise is already gone. But here's the part nobody tells you: you didn't just spend it.";

function wordErrorRate(ref: string, hyp: string): number {
  const r = ref.split(/\s+/).map(normalizeWord).filter(Boolean);
  const h = hyp.split(/\s+/).map(normalizeWord).filter(Boolean);
  // word-level edit distance via the char levenshtein on mapped symbols
  const vocab = new Map<string, string>();
  const sym = (w: string) => {
    if (!vocab.has(w)) vocab.set(w, String.fromCharCode(0x4e00 + vocab.size));
    return vocab.get(w)!;
  };
  return levenshtein(r.map(sym).join(""), h.map(sym).join("")) / Math.max(1, r.length);
}

function pitchStats(x: Float32Array, sr: number): { medianHz: number; spreadSemitones: number; voicedShare: number } {
  const frame = Math.round(sr * 0.04);
  const hop = Math.round(sr * 0.02);
  const minLag = Math.round(sr / 400);
  const maxLag = Math.round(sr / 70);
  const f0: number[] = [];
  let frames = 0;
  for (let s = 0; s + frame + maxLag < x.length; s += hop) {
    frames++;
    let e = 0;
    for (let i = 0; i < frame; i++) e += x[s + i]! * x[s + i]!;
    if (Math.sqrt(e / frame) < 0.02) continue;
    let best = 0;
    let bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      let e2 = 0;
      for (let i = 0; i < frame; i++) {
        c += x[s + i]! * x[s + i + lag]!;
        e2 += x[s + i + lag]! * x[s + i + lag]!;
      }
      const r = c / Math.sqrt(e * e2 + 1e-12);
      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }
    if (best > 0.6) f0.push(sr / bestLag);
  }
  f0.sort((a, b) => a - b);
  const med = f0[Math.floor(f0.length / 2)] ?? 0;
  const st = f0.map((f) => 12 * Math.log2(f / med));
  const p10 = st[Math.floor(st.length * 0.1)] ?? 0;
  const p90 = st[Math.floor(st.length * 0.9)] ?? 0;
  return { medianHz: Math.round(med), spreadSemitones: Math.round((p90 - p10) * 10) / 10, voicedShare: Math.round((f0.length / Math.max(1, frames)) * 100) / 100 };
}

/** Share of energy above 7 kHz (first-difference proxy: a 1-pole high-pass). */
function hissShare(x: Float32Array, sr: number): number {
  const a = Math.exp((-2 * Math.PI * 7000) / sr);
  let prev = 0;
  let prevIn = 0;
  let hi = 0;
  let all = 0;
  for (let i = 0; i < x.length; i++) {
    const y = a * (prev + x[i]! - prevIn);
    prev = y;
    prevIn = x[i]!;
    hi += y * y;
    all += x[i]! * x[i]!;
  }
  return Math.round((hi / Math.max(1e-9, all)) * 10000) / 10000;
}

await mkdir(out, { recursive: true });
const tts = await loadKokoro({ dtype });
const whisper = new LocalWhisperTranscriptionProvider();
const words = AUDITION_LINE.split(/\s+/).length;
const rows: unknown[] = [];
for (const v of voices) {
  const t0 = Date.now();
  const raw = await tts.generate(AUDITION_LINE, { voice: v, speed });
  const synthMs = Date.now() - t0;
  const audio = trimSilence(raw.audio, raw.sampling_rate);
  const seconds = audio.length / raw.sampling_rate;
  const file = join(out, `${v}${dtype === "q8" ? "" : `-${dtype}`}.wav`);
  await writeFile(file, encodeWav(audio, raw.sampling_rate));
  const tr = await whisper.transcribe(file);
  const row = { voice: v, dtype, seconds: Math.round(seconds * 100) / 100, wordsPerSecond: Math.round((words / seconds) * 100) / 100, realtime: Math.round((seconds / (synthMs / 1000)) * 100) / 100, wer: Math.round(wordErrorRate(AUDITION_LINE, tr.text) * 1000) / 1000, ...pitchStats(audio, raw.sampling_rate), hiss: hissShare(audio, raw.sampling_rate), heard: tr.text.trim() };
  rows.push(row);
  console.log(JSON.stringify(row));
}
await writeFile(join(out, `report-${dtype}.json`), JSON.stringify(rows, null, 2));
