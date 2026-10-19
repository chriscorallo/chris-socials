import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { TakeSelectionResultSchema, type TakeSelectionResult } from "./schemas";
import { buildTranscriptPhrases, formatTimestampedTranscript } from "./transcript-timing";
import type { TranscriptWord } from "./transcription-provider";

export interface CandidateTake {
  mediaAssetId: string;
  transcript: string | null;
  durationSeconds: number | null;
  /** MediaAsset.transcriptWords when available — lets the selector see real pacing, dead
   * air and restarts instead of guessing from plain text. */
  words?: TranscriptWord[] | null;
}

/** Deterministic delivery stats from word timings (no model call). */
export function summarizeDelivery(words: TranscriptWord[], durationSeconds: number | null) {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return null;
  const speechStart = sorted[0]!.start;
  const speechEnd = sorted[sorted.length - 1]!.end;
  const spoken = Math.max(0.001, speechEnd - speechStart);
  let longestPause = 0;
  let pausesOver1s = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]!.start - sorted[i - 1]!.end;
    longestPause = Math.max(longestPause, gap);
    if (gap > 1) pausesOver1s++;
  }
  return {
    wordsPerMinute: Math.round((sorted.length / spoken) * 60),
    leadingSilenceSeconds: Math.round(speechStart * 100) / 100,
    trailingSilenceSeconds:
      durationSeconds != null ? Math.round(Math.max(0, durationSeconds - speechEnd) * 100) / 100 : null,
    longestPauseSeconds: Math.round(longestPause * 100) / 100,
    pausesOver1s,
  };
}

function describeTake(t: CandidateTake): string {
  if (t.words && t.words.length > 0) {
    const stats = summarizeDelivery(t.words, t.durationSeconds);
    const phrases = formatTimestampedTranscript(buildTranscriptPhrases(t.words));
    return `Delivery (measured): ${stats?.wordsPerMinute} wpm, leading silence ${stats?.leadingSilenceSeconds}s, trailing silence ${
      stats?.trailingSilenceSeconds ?? "unknown"
    }s, longest pause ${stats?.longestPauseSeconds}s, pauses >1s: ${stats?.pausesOver1s}
Timestamped transcript (seconds):
${phrases}`;
  }
  return `Transcript: ${t.transcript ?? "(no transcript available)"}`;
}

export class TakeSelectionInvalidIdError extends Error {
  constructor(field: "selectedMediaAssetId" | "backupMediaAssetId", id: string) {
    super(`Take Selector returned ${field}="${id}", which is not one of the candidate takes.`);
    this.name = "TakeSelectionInvalidIdError";
  }
}

function buildUserPrompt(takes: CandidateTake[], brandContext: string, scriptText: string | null = null, creativeBrief: string | null = null): string {
  const list = takes
    .map(
      (t, i) =>
        `Take ${i + 1} [${t.mediaAssetId}] — duration ${t.durationSeconds ?? "unknown"}s\n${describeTake(t)}`,
    )
    .join("\n\n");

  return `${brandContext}${scriptText ? `\n\n## The script this was filmed from (judge each take against what was MEANT to be said)\n\n${scriptText}` : ""}${creativeBrief ? `\n\n## Creative brief\n\n${creativeBrief}\n\nPrefer the take that delivers the chosen hook and the payoff as planned.` : ""}

## Candidate Takes (reference each by its exact id in brackets)

${list}

## Task

Select the strongest usable take per your instructions above. selectedMediaAssetId and
backupMediaAssetId (if any) must be exact ids from the list above — never invent one.`;
}

export async function runTakeSelectorAgent(
  provider: ModelProvider,
  input: { takes: CandidateTake[]; brandContext: string; scriptText?: string | null; creativeBrief?: string | null },
): Promise<TakeSelectionResult> {
  if (input.takes.length === 0) {
    throw new Error("runTakeSelectorAgent requires at least one candidate take.");
  }

  const { systemPrompt, modelClass } = buildSystemPrompt("TAKE_SELECTOR");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input.takes, input.brandContext, input.scriptText ?? null, input.creativeBrief ?? null),
    schema: TakeSelectionResultSchema,
    promptId: "TAKE_SELECTOR",
  });

  const validIds = new Set(input.takes.map((t) => t.mediaAssetId));
  if (!validIds.has(result.output.selectedMediaAssetId)) {
    throw new TakeSelectionInvalidIdError(
      "selectedMediaAssetId",
      result.output.selectedMediaAssetId,
    );
  }
  if (
    result.output.backupMediaAssetId !== null &&
    !validIds.has(result.output.backupMediaAssetId)
  ) {
    throw new TakeSelectionInvalidIdError("backupMediaAssetId", result.output.backupMediaAssetId);
  }

  return result.output;
}
