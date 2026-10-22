import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  aspectLabel,
  audioMix,
  classifySpeech,
  isLexicalWord,
  listPendingReferenceVideos,
  recordReferenceAnalysis,
  shotMetrics,
  speechMetrics,
  REFERENCE_METRICS_VERSION,
  type PrismaClient,
  type ReferenceVideoMetrics,
  type TimedWord,
} from "@chris/domain";
import type { TranscriptionProvider } from "@chris/agents";
import {
  CUT_DETECTION_METHOD,
  analyzeSplicePcm,
  analyzeSubjectTrack,
  detectCuts,
  detectEndCard,
  detectReferenceZooms,
  measureAudioActivity,
  measureFrameChanges,
  measureStyleLoudness,
  measureTailFrames,
  measureVoiceBackground,
  probeVideo,
  referencePads,
  subjectBoxAt,
  summariseText,
  type OcrAdapter,
  type StorageAdapter,
  type SubjectTrack,
  type TailFrame,
} from "@chris/media";

/** extractAudioPcm16k's sample rate. */
const PCM_RATE = 16000;

/**
 * Reference-video style measurement — DETERMINISTIC, $0, no model calls: ffprobe, ffmpeg cut
 * detection + EBU R128 loudness, and the same local Whisper (word timings) that transcribes
 * Chris's takes. Runs as the `reference-analyze` heavy job (in-process locally, in the Vercel
 * Sandbox on the live site). Reference media is read here and nowhere else in the render path.
 */

type Provider = TranscriptionProvider & { model?: string };

async function defaultProvider(): Promise<Provider> {
  const { LocalWhisperTranscriptionProvider } = await import("@chris/media/transcription");
  return new LocalWhisperTranscriptionProvider();
}

export interface AnalyzeFileOptions {
  transcriptionProvider?: Provider;
  onStage?: (stage: "probe" | "cuts" | "speech" | "audio" | "screen" | "zooms") => void;
  /** v3 (reference learning): on-screen text. null = skip (the measurement says why). */
  ocr?: OcrAdapter | null;
  /** v3: the head through the video for zoom usage; default = the ONNX tracker, null = skip. */
  subjectTracker?: ((filePath: string) => Promise<SubjectTrack>) | null;
}

async function defaultOcr(): Promise<OcrAdapter | null> {
  try {
    const { TesseractJsOcr } = await import("@chris/media/ocr");
    return new TesseractJsOcr();
  } catch {
    return null;
  }
}

/** Cut rhythm as a sequence: cuts per 10 s in the opening, middle and closing third; and how
 * many cuts are jump cuts (the head barely moves across the cut) when a track exists. */
export function cutRhythm(cutTimes: number[], durationS: number, track: SubjectTrack | null): NonNullable<ReferenceVideoMetrics["rhythm"]> {
  const third = durationS / 3;
  const per = (k: number) => (third > 0 ? Math.round((cutTimes.filter((c) => c >= k * third && c < (k + 1) * third).length / third) * 1000) / 100 : 0);
  let jump: number | null = null;
  if (track && track.length && cutTimes.length) {
    let n = 0;
    let j = 0;
    for (const c of cutTimes) {
      const a = subjectBoxAt(track, c - 0.3);
      const b = subjectBoxAt(track, c + 0.3);
      if (!a || !b) continue;
      n++;
      const dx = Math.abs(a.x + a.w / 2 - (b.x + b.w / 2));
      const dw = Math.abs(a.w / b.w - 1);
      if (dx < 0.08 && dw < 0.15) j++;
    }
    jump = n ? Math.round((j / n) * 100) / 100 : null;
  }
  return { thirdsPer10s: [per(0), per(1), per(2)], jumpCutShare: jump };
}

/**
 * End of the last spoken word, for placing an end card after it. One or two stray words a
 * second or more after the rest (Whisper "hearing" the outro's sound) don't count.
 */
export function lastSpokenWordEnd(words: TimedWord[]): number | null {
  if (words.length === 0) return null;
  let k = words.length - 1;
  for (const strays of [1, 2]) {
    const i = words.length - strays;
    if (i >= 1 && words[i]!.start - words[i - 1]!.end >= 1) {
      k = i - 1;
      break;
    }
  }
  return words[k]!.end;
}

/** Measures one local video file. Throws only when the file can't be read at all. */
export async function analyzeReferenceVideoFile(filePath: string, options: AnalyzeFileOptions = {}): Promise<ReferenceVideoMetrics> {
  options.onStage?.("probe");
  const probe = await probeVideo(filePath);
  if (!probe.hasVideo && !probe.hasAudio) throw new Error("This file has no video or audio we can read.");
  const notes: string[] = [];

  let allCuts: number[] | null = null;
  let sourceDurationS = probe.durationS;
  let tail: TailFrame[] = [];
  if (probe.hasVideo) {
    options.onStage?.("cuts");
    const frames = await measureFrameChanges(filePath);
    if (frames.length > 1 && sourceDurationS <= 0) sourceDurationS = frames[frames.length - 1]!.t + (frames[1]!.t - frames[0]!.t);
    allCuts = detectCuts(frames);
    // The end-card check is a bonus: a failure here must never cost the measurement.
    tail = await measureTailFrames(filePath).catch(() => []);
  }

  let rawWords: TimedWord[] = [];
  let transcript: string | null = null;
  let pcm: Float32Array | null = null;
  if (probe.hasAudio) {
    options.onStage?.("speech");
    const provider = options.transcriptionProvider ?? (await defaultProvider());
    const t = await provider.transcribe(filePath);
    rawWords = (t.words ?? []).filter((w) => w.word.trim());
    transcript = (t.text ?? "").trim().slice(0, 6000) || null;
    const { extractAudioPcm16k } = await import("@chris/media/transcription");
    pcm = await extractAudioPcm16k(filePath).catch(() => null);
  }
  const activityOf = (words: TimedWord[], d: number) => (pcm ? measureAudioActivity(pcm, PCM_RATE, words, d) : null);

  // 1. Is there talking (over the whole file)? Needed to place an end card after the last word.
  const lexical = rawWords.filter((w) => isLexicalWord(w.word));
  const first = classifySpeech(rawWords, sourceDurationS, activityOf(lexical, sourceDurationS)?.contrastDb ?? null);
  const lastWordEndS = first.present ? lastSpokenWordEnd(first.words) : null;

  // 2. A platform end card (Instagram / TikTok download outro) → the analyzed video ends where it starts.
  const card = tail.length ? detectEndCard(tail, { durationS: sourceDurationS, lastWordEndS }) : null;
  const endCardS = card?.startS != null ? Math.max(0, sourceDurationS - card.startS) : null;
  const durationS = card?.startS != null ? card.startS : sourceDurationS;
  if (endCardS != null) notes.push(`The app's end card (logo + @name, ${endCardS.toFixed(1)} s) is left out of every number.`);

  // 3. Everything below is measured on [0, durationS].
  const cutTimes = allCuts ? allCuts.filter((t) => t < durationS - 0.05) : null;
  const cuts = cutTimes ? shotMetrics(cutTimes, durationS, CUT_DETECTION_METHOD) : null;
  if (cuts && cuts.count === 0 && durationS >= 5) notes.push("No cuts found — one continuous shot, or cuts too subtle to see.");

  const inRange = rawWords.filter((w) => w.start < durationS);
  const activity = activityOf(inRange.filter((w) => isLexicalWord(w.word)), durationS);
  const voice = classifySpeech(inRange, durationS, activity?.contrastDb ?? null);
  const speech = voice.present ? speechMetrics(voice.words, durationS, cutTimes) : null;
  if (probe.hasAudio && !speech) {
    notes.push(rawWords.length ? `No talking — ${voice.reason.charAt(0).toLowerCase()}${voice.reason.slice(1)}. Speech numbers don't apply.` : "No talking heard — speech numbers don't apply.");
    // Words Whisper invented over music aren't a transcript.
    if (rawWords.length) transcript = null;
  } else if (speech && speech.wordCount < 20) notes.push("Very few words — speech numbers are rough.");

  let audio: ReferenceVideoMetrics["audio"] = null;
  if (probe.hasAudio) {
    options.onStage?.("audio");
    const loud = await measureStyleLoudness(filePath, { endS: endCardS != null ? durationS : null });
    let vb: ReturnType<typeof measureVoiceBackground> = { voiceLevelDb: null, backgroundLevelDb: null, differenceDb: null, background: "unknown", method: "none" };
    if (speech && pcm) vb = measureVoiceBackground(pcm.subarray(0, Math.floor(durationS * PCM_RATE)), PCM_RATE, voice.words, durationS);
    const mix = audioMix(!!speech, vb.background, { activeShare: activity?.activeShare ?? null, integratedLufs: loud.integratedLufs });
    if (loud.clipping) notes.push("The audio clips (distorts) at its loudest moments.");
    audio = {
      integratedLufs: loud.integratedLufs,
      loudnessRangeLu: loud.loudnessRangeLu,
      truePeakDbtp: loud.truePeakDbtp,
      samplePeakDb: loud.samplePeakDb,
      clipping: loud.clipping,
      voiceLevelDb: vb.voiceLevelDb,
      backgroundLevelDb: vb.backgroundLevelDb,
      backgroundUnderVoiceDb: vb.differenceDb,
      // No voice: "background" is the whole soundtrack — present when it's music-led.
      background: speech ? vb.background : mix === "music-led" ? "present" : mix === "quiet" ? "none" : "unknown",
      backgroundMethod: vb.method,
      mix,
      activeShare: activity?.activeShare ?? null,
    };
  }

  // v3 — what a viewer SEES: on-screen text events (OCR), punch-ins (head size within shots),
  // the reference's own splice pads (its voice around its cuts), cut rhythm by thirds. Each is
  // a bonus on top of v2: a failure leaves it null with a note, never the whole measurement.
  let screen: ReferenceVideoMetrics["screen"] = null;
  let zooms: ReferenceVideoMetrics["zooms"] = null;
  let pads: ReferenceVideoMetrics["pads"] = null;
  let rhythm: ReferenceVideoMetrics["rhythm"] = null;
  let track: SubjectTrack | null = null;
  if (probe.hasVideo) {
    options.onStage?.("zooms");
    const tracker = options.subjectTracker === undefined ? (f: string) => analyzeSubjectTrack(f, { fps: 3 }) : options.subjectTracker;
    if (tracker) {
      track = await tracker(filePath).catch((err: unknown) => {
        notes.push(`Head tracking failed (${err instanceof Error ? err.message.slice(0, 80) : "error"}) — punch-ins not measured.`);
        return null;
      });
    }
    if (track && track.some((s) => s.box)) {
      const z = detectReferenceZooms(track, cutTimes ?? [], durationS);
      zooms = { method: "head width within shots (ultraface 3 fps)", count: z.count, per10s: z.per10s, amountMedian: z.amountMedian, rampMedianS: z.rampMedianS, holdMedianS: z.holdMedianS, inOutShare: z.inOutShare };
    }
    if (cutTimes) rhythm = cutRhythm(cutTimes, durationS, track);
    options.onStage?.("screen");
    const ocr = options.ocr === undefined ? await defaultOcr() : options.ocr;
    const avail = ocr ? await ocr.available() : { ok: false as const, reason: options.ocr === null ? "" : "no OCR adapter" };
    if (ocr && avail.ok) {
      try {
        const frames = await ocr.recognizeFrames(filePath, { fps: 3, maxFrames: 360, durationS });
        const t = summariseText(frames, durationS, speech ? { startS: speech.speechStartS, endS: speech.speechEndS } : null);
        screen = {
          method: ocr.method,
          frames: t.frames,
          headlines: t.headlines,
          captions: t.captions,
          hook: t.hook,
          longestBareS: t.longestBareS,
          events: t.events.slice(0, 400).map((e) => ({ start: e.start, end: e.end, text: e.text.slice(0, 120), words: e.words, band: e.band, role: e.role })),
        };
      } catch (err) {
        notes.push(`On-screen text not read (${err instanceof Error ? err.message.slice(0, 80) : "error"}).`);
      }
    } else if (!avail.ok && avail.reason) notes.push(`On-screen text not read (${avail.reason}).`);
  }
  if (pcm && cutTimes && cutTimes.length && speech) {
    const analysis = analyzeSplicePcm(pcm.subarray(0, Math.floor(durationS * PCM_RATE)), PCM_RATE);
    const p = referencePads(analysis, cutTimes);
    pads = { n: p.n, tailMedianMs: p.tailMedianMs, leadMedianMs: p.leadMedianMs, tailP75Ms: p.tailP75Ms, leadP75Ms: p.leadP75Ms, airMedianMs: p.airMedianMs };
  }

  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    version: REFERENCE_METRICS_VERSION,
    video: {
      durationS: r3(durationS),
      sourceDurationS: r3(sourceDurationS),
      endCardS: endCardS != null ? r3(endCardS) : null,
      width: probe.width,
      height: probe.height,
      aspect: aspectLabel(probe.width, probe.height),
      fps: probe.fps,
    },
    cuts,
    speech,
    audio,
    voice: probe.hasAudio ? { present: voice.present, wordCount: voice.wordCount, coverage: voice.coverage, contrastDb: voice.contrastDb, reason: voice.reason } : null,
    screen,
    zooms,
    pads,
    rhythm,
    transcript,
    notes,
  };
}

export interface ReferenceAnalysisResult {
  measured: Array<{ id: string; ok: boolean; error?: string }>;
  /** Still waiting (time budget reached). */
  remaining: number;
}

async function fetchToFile(storage: StorageAdapter, key: string, filePath: string): Promise<void> {
  const s = storage as StorageAdapter & { downloadToFile?: (k: string, p: string) => Promise<void> };
  if (typeof s.downloadToFile === "function") return s.downloadToFile(key, filePath);
  await writeFile(filePath, await storage.get(key));
}

/**
 * Measures every reference video waiting for it (or just `ids`), oldest first. Re-reads the
 * queue until a pass finds nothing new, so videos uploaded while this runs are included.
 * One video failing never stops the rest. Stops starting new videos once `timeBudgetMs` is
 * spent (the rest stay PENDING for the next run).
 */
export async function analyzePendingReferenceVideos(
  db: PrismaClient,
  storage: StorageAdapter,
  options: {
    ids?: string[];
    transcriptionProvider?: Provider;
    timeBudgetMs?: number;
    onProgress?: (p: { done: number; total: number; message: string }) => void;
    ocr?: OcrAdapter | null;
    subjectTracker?: AnalyzeFileOptions["subjectTracker"];
  },
  actor: { actorId: string },
): Promise<ReferenceAnalysisResult> {
  const started = Date.now();
  const budget = options.timeBudgetMs ?? 30 * 60_000;
  const attempted = new Set<string>();
  const measured: ReferenceAnalysisResult["measured"] = [];
  let provider = options.transcriptionProvider;
  for (let pass = 0; pass < 20; pass++) {
    const pending = (await listPendingReferenceVideos(db, { ids: options.ids })).filter((r) => !attempted.has(r.id));
    if (pending.length === 0) break;
    const total = attempted.size + pending.length;
    for (const row of pending) {
      if (Date.now() - started >= budget) {
        const remaining = (await listPendingReferenceVideos(db, { ids: options.ids })).filter((r) => !attempted.has(r.id)).length;
        return { measured, remaining };
      }
      attempted.add(row.id);
      const label = row.mediaFilename ?? "video";
      const n = attempted.size;
      options.onProgress?.({ done: n - 1, total, message: `Measuring video ${n} of ${total} (${label})…` });
      const dir = await mkdtemp(join(tmpdir(), "chris-ref-"));
      try {
        const file = join(dir, `ref${extname(label) || ".mp4"}`);
        await fetchToFile(storage, row.mediaStorageKey!, file);
        provider ??= await defaultProvider();
        const metrics = await analyzeReferenceVideoFile(file, { transcriptionProvider: provider, ocr: options.ocr, subjectTracker: options.subjectTracker });
        const saved = await recordReferenceAnalysis(db, row.id, { metrics }, actor);
        measured.push(saved.analysisStatus === "DONE" ? { id: row.id, ok: true } : { id: row.id, ok: false, error: saved.analysisError ?? "unknown error" });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await recordReferenceAnalysis(db, row.id, { error }, actor).catch(() => undefined);
        measured.push({ id: row.id, ok: false, error });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
  return { measured, remaining: 0 };
}
