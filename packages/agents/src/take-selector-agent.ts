import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { TakeSelectionResultSchema, type TakeSelectionResult } from "./schemas";

export interface CandidateTake {
  mediaAssetId: string;
  transcript: string | null;
  durationSeconds: number | null;
}

export class TakeSelectionInvalidIdError extends Error {
  constructor(field: "selectedMediaAssetId" | "backupMediaAssetId", id: string) {
    super(`Take Selector returned ${field}="${id}", which is not one of the candidate takes.`);
    this.name = "TakeSelectionInvalidIdError";
  }
}

function buildUserPrompt(takes: CandidateTake[], brandContext: string): string {
  const list = takes
    .map(
      (t, i) =>
        `Take ${i + 1} [${t.mediaAssetId}] — duration ${t.durationSeconds ?? "unknown"}s\nTranscript: ${
          t.transcript ?? "(no transcript available)"
        }`,
    )
    .join("\n\n");

  return `${brandContext}

## Candidate Takes (reference each by its exact id in brackets)

${list}

## Task

Select the strongest usable take per your instructions above. selectedMediaAssetId and
backupMediaAssetId (if any) must be exact ids from the list above — never invent one.`;
}

export async function runTakeSelectorAgent(
  provider: ModelProvider,
  input: { takes: CandidateTake[]; brandContext: string },
): Promise<TakeSelectionResult> {
  if (input.takes.length === 0) {
    throw new Error("runTakeSelectorAgent requires at least one candidate take.");
  }

  const { systemPrompt, modelClass } = buildSystemPrompt("TAKE_SELECTOR");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input.takes, input.brandContext),
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
