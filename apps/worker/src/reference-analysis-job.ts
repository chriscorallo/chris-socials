import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  aspectLabel,
  listPendingReferenceVideos,
  recordReferenceAnalysis,
  shotMetrics,
  speechMetrics,
  REFERENCE_METRICS_VERSION,
  type PrismaClient,
  type ReferenceVideoMetrics,
} from "@chris/domain";
import type { TranscriptionProvider } from "@chris/agents";
import {
  CUT_DETECTION_METHOD,
  detectCuts,
  measureFrameChanges,
  measureStyleLoudness,
  measureVoiceBackground,
  probeVideo,
  type StorageAdapter,
} from "@chris/media";

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
  onStage?: (stage: "probe" | "cuts" | "speech" | "audio") => void;
}

/** Measures one local video file. Throws only when the file can't be read at all. */
export async function analyzeReferenceVideoFile(filePath: string, options: AnalyzeFileOptions = {}): Promise<ReferenceVideoMetrics> {
  options.onStage?.("probe");
  const probe = await probeVideo(filePath);
  if (!probe.hasVideo && !probe.hasAudio) throw new Error("This file has no video or audio we can read.");
  const notes: string[] = [];

  let cutTimes: number[] | null = null;
  let durationS = probe.durationS;
  if (probe.hasVideo) {
    options.onStage?.("cuts");
    const frames = await measureFrameChanges(filePath);
    if (frames.length > 1 && durationS <= 0) durationS = frames[frames.length - 1]!.t + (frames[1]!.t - frames[0]!.t);
    cutTimes = detectCuts(frames);
  }
  const cuts = cutTimes ? shotMetrics(cutTimes, durationS, CUT_DETECTION_METHOD) : null;
  if (cuts && cuts.count === 0 && durationS >= 5) notes.push("No cuts found — one continuous shot, or cuts too subtle to see.");

  let words: Array<{ word: string; start: number; end: number }> = [];
  let transcript: string | null = null;
  if (probe.hasAudio) {
    options.onStage?.("speech");
    const provider = options.transcriptionProvider ?? (await defaultProvider());
    const t = await provider.transcribe(filePath);
    words = (t.words ?? []).filter((w) => w.word.trim());
    transcript = (t.text ?? "").trim().slice(0, 6000) || null;
  }
  const speech = speechMetrics(words, durationS, cutTimes);
  if (probe.hasAudio && !speech) notes.push("No speech heard — speech numbers are missing.");
  else if (speech && speech.wordCount < 20) notes.push("Very few words — speech numbers are rough.");

  let audio: ReferenceVideoMetrics["audio"] = null;
  if (probe.hasAudio) {
    options.onStage?.("audio");
    const loud = await measureStyleLoudness(filePath);
    let vb: ReturnType<typeof measureVoiceBackground> = { voiceLevelDb: null, backgroundLevelDb: null, differenceDb: null, background: "unknown", method: "none" };
    if (words.length > 0) {
      const { extractAudioPcm16k } = await import("@chris/media/transcription");
      vb = measureVoiceBackground(await extractAudioPcm16k(filePath), 16000, words, durationS);
    }
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
      background: vb.background,
      backgroundMethod: vb.method,
    };
  }

  return {
    version: REFERENCE_METRICS_VERSION,
    video: {
      durationS: Math.round(durationS * 1000) / 1000,
      width: probe.width,
      height: probe.height,
      aspect: aspectLabel(probe.width, probe.height),
      fps: probe.fps,
    },
    cuts,
    speech,
    audio,
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
        const metrics = await analyzeReferenceVideoFile(file, { transcriptionProvider: provider });
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
