import { EditorPlanSchema, type EditorPlan } from "@chris/media/timeline";
import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";

/**
 * The Editor (2026-10-21): writes the cut of a filmed take — the lean transcript in story order
 * (hook → setup → tension → turn → payoff → ending) from lines Chris said, what was cut and why,
 * a headline per beat and what each beat needs the viewer to see. The deterministic Full edit
 * executes the plan exactly (packages/media full-edit/editor-plan.ts). Prompt:
 * /prompts/agents/EDITOR.md. Runs automatically on upload (worker) and in the AI edit.
 */
export interface EditorLine {
  id: number;
  text: string;
  start: number;
  end: number;
  words: number;
}

export interface EditorAgentInput {
  title: string | null;
  durationS: number;
  lines: EditorLine[];
  brandContext: string;
  creativeBrief?: string | null;
  /** What the references run, for the length note (never a quota). */
  referenceLengthS?: { targetS: number; minS: number; maxS: number } | null;
}

export class EditorPlanInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditorPlanInvalidError";
  }
}

export async function runEditorAgent(provider: ModelProvider, input: EditorAgentInput): Promise<EditorPlan> {
  if (input.lines.length === 0) throw new EditorPlanInvalidError("There are no lines to edit.");
  const { systemPrompt, modelClass } = buildSystemPrompt("EDITOR");
  const lines = input.lines.map((l) => `[${l.id}] ${l.start.toFixed(1)}–${l.end.toFixed(1)}s (${l.words} words): ${l.text}`).join("\n");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext,
    userPrompt: `## The take

Title: ${input.title ?? "(untitled)"}
Length: ${input.durationS.toFixed(0)} s${input.referenceLengthS ? ` · his references run ${Math.round(input.referenceLengthS.minS)}–${Math.round(input.referenceLengthS.maxS)} s (typical ${Math.round(input.referenceLengthS.targetS)} s)` : ""}
${input.creativeBrief ? `\n## Creative brief (the plan this video was made to)\n\n${input.creativeBrief}\n` : ""}
## Transcript, as numbered lines (id, source seconds, word count)

${lines}

## Task

Write the cut per your instructions: storyline (sentenceId, role, optional keepWords, headline, viewerNeeds), cut (with reasons), title, pacing, rationale, coldViewer. Only ids from the list above, each at most once, the hook first.`,
    schema: EditorPlanSchema,
    promptId: "EDITOR",
  });
  const plan = result.output;
  const known = new Set(input.lines.map((l) => l.id));
  const storyline = plan.storyline.filter((e, i, arr) => known.has(e.sentenceId) && arr.findIndex((x) => x.sentenceId === e.sentenceId) === i);
  if (storyline.length === 0) throw new EditorPlanInvalidError("The editor's plan used no line from the take.");
  return { ...plan, storyline, cut: plan.cut.filter((c) => known.has(c.sentenceId) && !storyline.some((e) => e.sentenceId === c.sentenceId)) };
}
