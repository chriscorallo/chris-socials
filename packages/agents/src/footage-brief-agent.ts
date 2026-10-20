import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { ScriptCreativeBriefSchema, type ScriptCreativeBrief } from "./schemas";

/**
 * Footage brief: recovers the Creative Brief from a filmed take that has none on record (an
 * older video, or one filmed from a script that never went through the system), so every
 * downstream bot — the free Full edit's hook/story protection, hook picker, visual strategist,
 * captions, viewer check — can follow the playbook. Hooks and beats are sentences he said;
 * nothing is invented. Prompt: /prompts/agents/FOOTAGE_BRIEF.md.
 */
export async function runFootageBriefAgent(
  provider: ModelProvider,
  input: { transcript: string; title: string | null; durationS: number | null; brandContext: string },
): Promise<ScriptCreativeBrief> {
  const { systemPrompt, modelClass } = buildSystemPrompt("FOOTAGE_BRIEF");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext,
    userPrompt: `## The take as filmed

Title: ${input.title ?? "(untitled)"}
Length: ${input.durationS != null ? `${input.durationS.toFixed(0)} s` : "(unknown)"}

## Transcript (what Chris said, in order)

${input.transcript}

## Task

Write the Creative Brief this take was evidently made to, per your instructions. Every hook and story beat must be something he said in the transcript above.`,
    schema: ScriptCreativeBriefSchema,
    promptId: "FOOTAGE_BRIEF",
  });
  const b = result.output;
  const hooks = b.hooks.length ? b.hooks : [{ text: "", mechanism: "IMPOSSIBLE_QUESTION" as const, onScreenText: "", openingVisual: "" }];
  return { ...b, hooks, chosenHookIndex: Math.min(Math.max(0, b.chosenHookIndex), hooks.length - 1) };
}
