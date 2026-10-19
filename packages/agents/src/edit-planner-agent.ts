import type { ProductionContract } from "@chris/domain";
import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import {
  EditPlanOutputSchema,
  type EditPlanOutput,
  type EditPlanRepairContext,
} from "./schemas";
import {
  buildTranscriptPhrases,
  formatTimestampedTranscript,
  snapSegmentsToWordBoundaries,
} from "./transcript-timing";
import type { TranscriptWord } from "./transcription-provider";

export class EditPlanSegmentOutOfBoundsError extends Error {
  constructor(endSeconds: number, sourceDurationSeconds: number) {
    super(
      `Edit Planner returned a segment ending at ${endSeconds}s, past the source take's ` +
        `actual duration of ${sourceDurationSeconds}s.`,
    );
    this.name = "EditPlanSegmentOutOfBoundsError";
  }
}

export interface EditPlannerInput {
  contract: ProductionContract;
  scriptText: string;
  takeTranscript: string | null;
  /** Word timings for the selected take (MediaAsset.transcriptWords), source timeline. When
   * present the planner sees a timestamped phrase list and cut points are snapped to them. */
  takeWords?: TranscriptWord[] | null;
  sourceDurationSeconds: number | null;
  brandContext: string;
  /** The Creative Brief this video was made to (formatCreativeBrief), when one exists. */
  creativeBrief?: string | null;
  /** Present for a repair pass: revise `previousPlan` to fix exactly these QC issues. */
  repairContext?: EditPlanRepairContext | null;
}

function transcriptSection(input: EditPlannerInput): string {
  if (input.takeWords && input.takeWords.length > 0) {
    const phrases = buildTranscriptPhrases(input.takeWords);
    return `Timestamped transcript (source timeline, seconds; one spoken phrase per line —
these are the real speech boundaries, choose cut points from them):
${formatTimestampedTranscript(phrases)}`;
  }
  return `Transcript (no word timings available — cut points cannot be verified against speech):
${input.takeTranscript ?? "(no transcript available)"}`;
}

function repairSection(repair: EditPlannerInput["repairContext"]): string {
  if (!repair) return "";
  const issues = repair.qcIssues
    .map(
      (i, n) =>
        `${n + 1}. [${i.severity}] ${i.category}${
          i.timestampSeconds != null ? ` @ ${i.timestampSeconds}s` : ""
        }: ${i.description}${i.recommendedRepair ? ` — recommended: ${i.recommendedRepair}` : ""}`,
    )
    .join("\n");
  return `

## REPAIR PASS

The plan below was rendered and failed quality control. Return a REVISED plan that fixes every
listed issue with the minimum change necessary. Keep everything that was not implicated
(segments, overlay wording, captions, timings) exactly as it was. Do not use the revision as
an excuse to re-edit the video. In \`rationale\`, state per issue what you changed.

### Previous plan
${JSON.stringify(repair.previousPlan, null, 2)}

### QC issues to fix
${issues}`;
}

function buildUserPrompt(input: EditPlannerInput): string {
  const { contract, sourceDurationSeconds } = input;
  return `${input.brandContext}

## Production Contract

Purpose: ${contract.purpose}
Production tier: ${contract.productionTier}
Target length: ${contract.targetLengthMinSeconds}-${contract.targetLengthMaxSeconds} seconds

## Script

${input.scriptText}${input.creativeBrief ? `\n\n## Creative brief (the plan — keep the chosen hook first, protect the midpoint and payoff, land the ending's objective)\n\n${input.creativeBrief}` : ""}

## Selected Take

Source duration: ${sourceDurationSeconds ?? "unknown"} seconds
${transcriptSection(input)}

## What the renderer can execute

- segments (source timeline, hard cuts, concatenated in order)
- textOverlays (output timeline) with style HEADLINE | CAPTION | NUMBER_CALLOUT | LOWER_THIRD,
  position TOP | CENTER | BOTTOM — wrapping, sizing and safe-zone placement are automatic
- captions: word-level burned-in captions from the transcript timings
  ({enabled, style: CLEAN | BOLD_HIGHLIGHT, position: LOWER | CENTER}); captions are
  repositioned automatically around overlays
- punchIns (output timeline): hard zoom 1.0-1.3, focus CENTER | UPPER_THIRD
- normalizeAudio (to -14 LUFS)

NOT executed yet (leave empty/null): bRollRequests, musicTrack, sfxEvents, transitions.

## Task

Create a deterministic EditPlan per your instructions above. segments must fall within the
selected take's actual source duration (0 to ${sourceDurationSeconds ?? "the take's length"}
seconds) — never invent a cut point past the end of the actual footage. Start and end each
segment in the silence around a phrase boundary, never mid-word. For RAW/FAST tiers,
restraint is often correct: doNothingElse=true with minimal textOverlays is a valid, good
answer when the content doesn't need more.${repairSection(input.repairContext)}`;
}

export async function runEditPlannerAgent(
  provider: ModelProvider,
  input: EditPlannerInput,
): Promise<EditPlanOutput> {
  const { systemPrompt, modelClass } = buildSystemPrompt("EDIT_PLANNER");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input),
    schema: EditPlanOutputSchema,
    promptId: "EDIT_PLANNER",
  });

  const plan = result.output;

  if (input.sourceDurationSeconds != null) {
    for (const segment of plan.segments) {
      if (segment.endSeconds > input.sourceDurationSeconds) {
        throw new EditPlanSegmentOutOfBoundsError(
          segment.endSeconds,
          input.sourceDurationSeconds,
        );
      }
    }
  }

  if (input.takeWords && input.takeWords.length > 0) {
    const snapped = snapSegmentsToWordBoundaries(plan.segments, input.takeWords, {
      sourceDurationSeconds: input.sourceDurationSeconds,
    });
    if (snapped.adjustments.length > 0) {
      return {
        ...plan,
        segments: snapped.segments,
        rationale: `${plan.rationale}\n\n[deterministic] Cut points snapped to word boundaries: ${snapped.adjustments.join("; ")}.`,
      };
    }
  }

  return plan;
}
