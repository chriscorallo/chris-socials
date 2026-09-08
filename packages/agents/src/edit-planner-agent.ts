import type { ProductionContract } from "@chris/domain";
import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { EditPlanOutputSchema, type EditPlanOutput } from "./schemas";

export class EditPlanSegmentOutOfBoundsError extends Error {
  constructor(endSeconds: number, sourceDurationSeconds: number) {
    super(
      `Edit Planner returned a segment ending at ${endSeconds}s, past the source take's ` +
        `actual duration of ${sourceDurationSeconds}s.`,
    );
    this.name = "EditPlanSegmentOutOfBoundsError";
  }
}

function buildUserPrompt(
  contract: ProductionContract,
  scriptText: string,
  takeTranscript: string | null,
  sourceDurationSeconds: number | null,
  brandContext: string,
): string {
  return `${brandContext}

## Production Contract

Purpose: ${contract.purpose}
Production tier: ${contract.productionTier}
Target length: ${contract.targetLengthMinSeconds}-${contract.targetLengthMaxSeconds} seconds

## Script

${scriptText}

## Selected Take

Source duration: ${sourceDurationSeconds ?? "unknown"} seconds
Transcript: ${takeTranscript ?? "(no transcript available)"}

## Task

Create a deterministic EditPlan per your instructions above. segments must fall within the
selected take's actual source duration (0 to ${sourceDurationSeconds ?? "the take's length"}
seconds) — never invent a cut point past the end of the actual footage. For RAW/FAST tiers,
restraint is often correct: doNothingElse=true with minimal textOverlays is a valid, good
answer when the content doesn't need more.`;
}

export async function runEditPlannerAgent(
  provider: ModelProvider,
  input: {
    contract: ProductionContract;
    scriptText: string;
    takeTranscript: string | null;
    sourceDurationSeconds: number | null;
    brandContext: string;
  },
): Promise<EditPlanOutput> {
  const { systemPrompt, modelClass } = buildSystemPrompt("EDIT_PLANNER");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(
      input.contract,
      input.scriptText,
      input.takeTranscript,
      input.sourceDurationSeconds,
      input.brandContext,
    ),
    schema: EditPlanOutputSchema,
    promptId: "EDIT_PLANNER",
  });

  if (input.sourceDurationSeconds != null) {
    for (const segment of result.output.segments) {
      if (segment.endSeconds > input.sourceDurationSeconds) {
        throw new EditPlanSegmentOutOfBoundsError(
          segment.endSeconds,
          input.sourceDurationSeconds,
        );
      }
    }
  }

  return result.output;
}
