import { z } from "zod";
import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";

/**
 * AI edit, step 1: choose which of the Full edit's hook candidates (sentences Chris actually
 * said) opens the video. Semantic judgment (does it stand alone? does it make a cold viewer
 * stay?) — the free heuristic only counts keywords. Picks among candidates; never writes words.
 * Prompt: /prompts/agents/HOOK_PICKER.md.
 */
export const HookPickSchema = z.object({
  chosenIndex: z.number().int(),
  reason: z.string(),
  ranking: z.array(z.number().int()),
});
export type HookPick = z.infer<typeof HookPickSchema>;

export interface HookPickCandidate {
  index: number;
  text: string;
  score: number;
  reason: string;
}

export class HookPickInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookPickInvalidError";
  }
}

export async function runHookPickerAgent(
  provider: ModelProvider,
  input: { candidates: HookPickCandidate[]; transcript: string; brandContext: string },
): Promise<HookPick> {
  if (input.candidates.length === 0) throw new HookPickInvalidError("There are no hook options to choose from.");
  const { systemPrompt, modelClass } = buildSystemPrompt("HOOK_PICKER");
  const userPrompt = `${input.brandContext}

## What Chris said in the full take

${input.transcript}

## Candidates (sentences he said; the chosen one opens the video)

${input.candidates.map((c) => `[${c.index}] "${c.text}" — heuristic score ${c.score.toFixed(2)}: ${c.reason}`).join("\n")}

## Task

Pick the opening line per your instructions. chosenIndex must be one of: ${input.candidates.map((c) => c.index).join(", ")}.`;
  const result = await provider.completeStructured({ modelClass, systemPrompt, userPrompt, schema: HookPickSchema, promptId: "HOOK_PICKER" });
  const valid = new Set(input.candidates.map((c) => c.index));
  if (!valid.has(result.output.chosenIndex)) throw new HookPickInvalidError(`The AI picked a hook that isn't one of the options (${result.output.chosenIndex}).`);
  return { ...result.output, ranking: result.output.ranking.filter((i) => valid.has(i)) };
}
