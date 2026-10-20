import { z } from "zod";
import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";

/**
 * AI edit, read-through: a cold viewer hears only the kept lines in output order. The model
 * finds junctions that don't follow (a "so" pointing at a cut line, a reveal before its setup,
 * a fragment) and returns surgical fixes — restore a removed line or drop the dependent one —
 * which the editor applies as Full-edit choices (forceKeep / forceDrop) and re-cuts. Semantic
 * judgment, so a model; never the hook. Prompt: /prompts/agents/FLOW_CHECK.md.
 */
export const FlowCheckSchema = z.object({
  reads: z.enum(["CLEAN", "ISSUES"]),
  issues: z
    .array(
      z.object({
        /** The kept line the viewer is on when it stops making sense. */
        atSentenceId: z.number().int(),
        problem: z.string(),
        fix: z.enum(["RESTORE", "DROP", "NONE"]),
        /** The sentence to restore (from the removed list) or drop (from the kept list). */
        sentenceId: z.number().int().nullable(),
      }),
    )
    .max(12),
  hookProblem: z.string().nullable(),
  quotable: z.string().nullable(),
});
export type FlowCheck = z.infer<typeof FlowCheckSchema>;

export interface FlowCheckInput {
  kept: Array<{ sentenceId: number; text: string; beat: string }>;
  removed: Array<{ sentenceId: number; text: string; kind: string; why: string }>;
  hookSentenceIds: number[];
  brandContext: string;
  creativeBrief?: string | null;
}

/** The fixes the editor may apply: valid ids only, never the hook, at most `maxFixes`. */
export function flowFixes(check: FlowCheck, input: FlowCheckInput, maxFixes = 4): { forceKeep: number[]; forceDrop: number[] } {
  const kept = new Set(input.kept.map((k) => k.sentenceId));
  const removed = new Set(input.removed.map((r) => r.sentenceId));
  const hook = new Set(input.hookSentenceIds);
  const forceKeep: number[] = [];
  const forceDrop: number[] = [];
  for (const i of check.issues) {
    if (forceKeep.length + forceDrop.length >= maxFixes) break;
    if (i.fix === "RESTORE" && i.sentenceId != null && removed.has(i.sentenceId) && !forceKeep.includes(i.sentenceId)) forceKeep.push(i.sentenceId);
    else if (i.fix === "DROP" && i.sentenceId != null && kept.has(i.sentenceId) && !hook.has(i.sentenceId) && !forceDrop.includes(i.sentenceId)) forceDrop.push(i.sentenceId);
  }
  return { forceKeep, forceDrop };
}

export async function runFlowCheckAgent(provider: ModelProvider, input: FlowCheckInput): Promise<FlowCheck> {
  const { systemPrompt, modelClass } = buildSystemPrompt("FLOW_CHECK");
  const hook = new Set(input.hookSentenceIds);
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext,
    userPrompt: `${input.creativeBrief ? `## Creative brief (the plan this video was made to)\n\n${input.creativeBrief}\n\n` : ""}## What the viewer hears, in order (kept lines)

${input.kept.map((k) => `[${k.sentenceId}]${hook.has(k.sentenceId) ? " (HOOK)" : ""} ${k.text}`).join("\n")}

## Lines that were cut (restorable)

${input.removed.length ? input.removed.map((r) => `[${r.sentenceId}] (${r.kind.toLowerCase()}: ${r.why}) ${r.text}`).join("\n") : "(none)"}

## Task

Read the kept lines through as a cold viewer per your instructions. Return the junctions that don't hold and the one fix for each; never the hook.`,
    schema: FlowCheckSchema,
    promptId: "FLOW_CHECK",
  });
  return result.output;
}
