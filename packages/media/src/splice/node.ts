import { analyzeSplicePcm, type SpliceAnalysis, type SpliceAnalysisOptions } from "./analysis";

/** Node: decodes a take (16 kHz mono via ffmpeg) and runs the splice analysis. Kept out of
 * analysis.ts so the browser bundle (timeline-browser → style-cut → splice) never sees ffmpeg. */
export async function analyzeSpliceAudio(filePath: string, options: Partial<SpliceAnalysisOptions> = {}): Promise<SpliceAnalysis> {
  const { extractAudioPcm16k, WHISPER_SAMPLE_RATE } = await import("../transcription/local-whisper");
  return analyzeSplicePcm(await extractAudioPcm16k(filePath), WHISPER_SAMPLE_RATE, options);
}
