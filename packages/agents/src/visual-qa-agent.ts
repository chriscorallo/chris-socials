import type { ModelProvider, ModelImageInput } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { VisualQAReportSchema, type VisualQAReport } from "./schemas";

/** One sampled frame from the actual rendered file (packages/media's frame extractor —
 * deterministic code, not this agent's concern) plus the timestamp it was pulled from, so the
 * prompt can label each image and the model can cite a real timestamp back. */
export interface SampledFrame {
  atSeconds: number;
  base64: string;
  mediaType: "image/png" | "image/jpeg";
}

function buildUserPrompt(input: {
  frameCount: number;
  durationSeconds: number;
  productionTier: string;
  textOverlaySummary: string;
  brandContext: string;
}): string {
  return `${input.brandContext}

## Render Under Review

- Total duration: ${input.durationSeconds}s
- Production tier: ${input.productionTier}
- Sampled frames attached below, in chronological order, each labelled with its timestamp
  (${input.frameCount} frames total — these are NOT every frame, only meaningful sample
  points; a defect between samples may not be visible to you, note that limitation rather than
  guessing).
- Planned text overlays (for cross-checking collision/duration/typography — the renderer
  executed this plan; you're confirming what actually landed on screen matches it):
${input.textOverlaySummary}

## Task

Inspect the attached frames per your instructions above and return every machine-actionable
issue you can support from what you actually see. Do not invent a defect from a category you
cannot verify from a still frame (e.g. don't claim "black frame" bleed you cannot see, don't
guess at audio-only issues). If you found nothing wrong, return an empty issues array and say
so plainly in overallImpression — do not manufacture minor findings to seem thorough.`;
}

/** Visual QA never issues a hard BLOCK itself (see /docs/AGENT_CONTRACTS.md — its `BLOCKING`
 * findings feed the TECHNICAL/BRAND hard gate via packages/domain's aggregateHardGates, they
 * don't short-circuit anything here). This function's only job is producing the structured
 * report; the gate decision is deterministic code, one layer up. */
export async function runVisualQAAgent(
  provider: ModelProvider,
  input: {
    frames: SampledFrame[];
    durationSeconds: number;
    productionTier: string;
    textOverlaySummary: string;
    brandContext: string;
  },
): Promise<VisualQAReport> {
  if (input.frames.length === 0) {
    throw new Error("runVisualQAAgent requires at least one sampled frame.");
  }

  const { systemPrompt, modelClass } = buildSystemPrompt("VISUAL_QA");

  const images: ModelImageInput[] = input.frames.map((frame) => ({
    base64: frame.base64,
    mediaType: frame.mediaType,
    label: `t=${frame.atSeconds.toFixed(2)}s`,
  }));

  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt({
      frameCount: input.frames.length,
      durationSeconds: input.durationSeconds,
      productionTier: input.productionTier,
      textOverlaySummary: input.textOverlaySummary,
      brandContext: input.brandContext,
    }),
    images,
    schema: VisualQAReportSchema,
    promptId: "VISUAL_QA",
  });

  return result.output;
}
