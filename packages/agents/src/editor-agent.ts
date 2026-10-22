import { EditorPlanSchema, editorPlanChecklist, EDITOR_CHECKS, type EditorPlan, type EditorChecklistFinding } from "@chris/media/timeline";
import { z } from "zod";
import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";

/**
 * The Editor (2026-10-21; v2 the same evening): writes the cut of a filmed take — the lean
 * transcript in story order (hook → setup → tension → turn → payoff → ending) from lines Chris
 * said, what was cut and why, a headline per beat, emphasis words, what each beat needs the
 * viewer to see. Editor v2 is write → critique → revise once: the draft is read against the
 * checklist by the deterministic half (`editorPlanChecklist`) and by a MEDIUM critique pass
 * (EDITOR_CRITIQUE); when either finds something the Editor revises once with the findings. The
 * deterministic Full edit executes the plan exactly (packages/media full-edit/editor-plan.ts).
 * Prompts: /prompts/agents/EDITOR.md, /prompts/agents/EDITOR_CRITIQUE.md. Runs automatically on
 * upload (worker) and in the AI edit.
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
  /** The StyleModel digest (editorDigest): what his references and his own edits do, ≤ 10 lines. */
  styleDigest?: string[] | null;
  /** Editor v2: run the critique + revise pass (default true). False = the one-shot v1 call. */
  critique?: boolean;
}

export class EditorPlanInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditorPlanInvalidError";
  }
}

export const EditorCritiqueSchema = z.object({
  verdict: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : v), z.enum(["ACCEPT", "REVISE"])),
  findings: z
    .array(
      z.object({
        check: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase().replace(/[^A-Z]+/g, "_") : v), z.enum(EDITOR_CHECKS)),
        sentenceId: z.number().int().nullable().optional(),
        problem: z.string(),
        fix: z.string(),
      }),
    )
    .max(8)
    .default([]),
  /** Deterministic findings the critique dismissed, with why (shown in the editor). */
  dismissed: z.array(z.object({ check: z.string(), why: z.string() })).max(8).default([]),
});
export type EditorCritique = z.infer<typeof EditorCritiqueSchema>;

function formatLines(lines: EditorLine[]): string {
  return lines.map((l) => `[${l.id}] ${l.start.toFixed(1)}–${l.end.toFixed(1)}s (${l.words} words): ${l.text}`).join("\n");
}

function takeHeader(input: EditorAgentInput): string {
  return `## The take

Title: ${input.title ?? "(untitled)"}
Length: ${input.durationS.toFixed(0)} s${input.referenceLengthS ? ` · his references run ${Math.round(input.referenceLengthS.minS)}–${Math.round(input.referenceLengthS.maxS)} s (typical ${Math.round(input.referenceLengthS.targetS)} s)` : ""}
${input.creativeBrief ? `\n## Creative brief (the plan this video was made to)\n\n${input.creativeBrief}\n` : ""}${input.styleDigest?.length ? `\n## What his references do (measured — a range to work inside, never a quota)\n\n${input.styleDigest.map((l) => `- ${l}`).join("\n")}\n` : ""}
## Transcript, as numbered lines (id, source seconds, word count)

${formatLines(input.lines)}`;
}

/** The plan as the critique and the revise pass read it. */
export function formatEditorPlan(plan: EditorPlan, lines: EditorLine[]): string {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const story = plan.storyline
    .map((e) => {
      const l = byId.get(e.sentenceId);
      const trim = e.keepWords ? ` · words ${e.keepWords.from}–${e.keepWords.to}` : "";
      const emph = e.emphasisWords?.length ? ` · emphasis: ${e.emphasisWords.map((w) => `"${w}"`).join(", ")}` : "";
      return `- [${e.sentenceId}] ${e.role} · headline: ${e.headline ? `"${e.headline}"` : "(none)"}${trim}${emph}${e.viewerNeeds ? ` · viewer needs: ${e.viewerNeeds}` : ""}\n    ${l?.text ?? "(unknown line)"}`;
    })
    .join("\n");
  const cut = plan.cut.map((c) => `- [${c.sentenceId}] ${c.why} — "${(byId.get(c.sentenceId)?.text ?? "").slice(0, 100)}"`).join("\n");
  return `Title: ${plan.title ?? "(none)"}
Pacing: ${plan.pacing}

Storyline (what the viewer hears, in order):
${story}

Cut:
${cut || "(nothing cut)"}

Rationale: ${plan.rationale || "(none)"}
Cold viewer: ${plan.coldViewer ?? "(none)"}`;
}

function keepKnownLines(plan: EditorPlan, input: EditorAgentInput): EditorPlan {
  const known = new Set(input.lines.map((l) => l.id));
  const storyline = plan.storyline.filter((e, i, arr) => known.has(e.sentenceId) && arr.findIndex((x) => x.sentenceId === e.sentenceId) === i);
  if (storyline.length === 0) throw new EditorPlanInvalidError("The editor's plan used no line from the take.");
  return { ...plan, storyline, cut: plan.cut.filter((c) => known.has(c.sentenceId) && !storyline.some((e) => e.sentenceId === c.sentenceId)) };
}

async function write(provider: ModelProvider, input: EditorAgentInput, revision: { draft: EditorPlan; findings: string[] } | null): Promise<EditorPlan> {
  const { systemPrompt, modelClass } = buildSystemPrompt("EDITOR");
  const task = revision
    ? `## Your first draft

${formatEditorPlan(revision.draft, input.lines)}

## The critique (fix each at the line it names; keep everything else)

${revision.findings.map((f) => `- ${f}`).join("\n")}

## Task

Revise the cut once per your instructions and return the complete plan: storyline (sentenceId, role, optional keepWords, headline on every entry, viewerNeeds, emphasisWords), cut (with reasons), title, pacing, rationale, coldViewer (at least two sentences). Only ids from the numbered lines, each at most once, the hook first.`
    : `## Task

Write the cut per your instructions: storyline (sentenceId, role, optional keepWords, headline on every entry, viewerNeeds, emphasisWords), cut (with reasons), title, pacing, rationale, coldViewer (at least two sentences). Only ids from the list above, each at most once, the hook first.`;
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext,
    userPrompt: `${takeHeader(input)}

${task}`,
    schema: EditorPlanSchema,
    promptId: "EDITOR",
  });
  return keepKnownLines(result.output, input);
}

/** The critique pass (MEDIUM): the plan + the deterministic findings → verdict and findings. */
export async function critiqueEditorPlan(provider: ModelProvider, input: EditorAgentInput, plan: EditorPlan, found: EditorChecklistFinding[]): Promise<EditorCritique> {
  const { systemPrompt, modelClass } = buildSystemPrompt("EDITOR_CRITIQUE");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext,
    userPrompt: `${takeHeader(input)}

## The Editor's cut

${formatEditorPlan(plan, input.lines)}

## What the deterministic checklist already found

${found.length ? found.map((f) => `- ${f.check}${f.sentenceId != null ? ` (line ${f.sentenceId})` : ""}: ${f.problem} → ${f.fix}`).join("\n") : "(nothing)"}

## Task

Read the cut against the checklist and return the verdict with findings (check, sentenceId, problem, fix). Confirm or dismiss each deterministic finding.`,
    schema: EditorCritiqueSchema,
    promptId: "EDITOR_CRITIQUE",
  });
  return result.output;
}

/** One finding as the revise pass reads it. */
function describe(f: { check: string; sentenceId?: number | null; problem: string; fix: string }): string {
  return `${f.check}${f.sentenceId != null ? ` (line ${f.sentenceId})` : ""}: ${f.problem} → ${f.fix}`;
}

/**
 * Editor v2: write → deterministic checklist + critique → revise once when anything was found.
 * Returns the plan with its `review` (verdict, the findings, whether it was revised) so the
 * stored plan carries its own provenance. One HIGH call when the draft is clean; HIGH + MEDIUM +
 * HIGH at most.
 */
export async function runEditorAgent(provider: ModelProvider, input: EditorAgentInput): Promise<EditorPlan> {
  if (input.lines.length === 0) throw new EditorPlanInvalidError("There are no lines to edit.");
  const draft = await write(provider, input, null);
  if (input.critique === false) return draft;
  const found = editorPlanChecklist(draft, input.lines);
  let critique: EditorCritique;
  try {
    critique = await critiqueEditorPlan(provider, input, draft, found);
  } catch {
    // The critique must never cost the cut: a failed pass leaves the draft with its own findings.
    critique = { verdict: found.length ? "REVISE" : "ACCEPT", findings: [], dismissed: [] };
  }
  const dismissed = new Set(critique.dismissed.map((d) => d.check.toUpperCase()));
  const findings = [
    ...found.filter((f) => !dismissed.has(f.check)).map(describe),
    ...critique.findings.map(describe).filter((f, i, arr) => arr.indexOf(f) === i),
  ];
  if (critique.verdict === "ACCEPT" && findings.length === 0) return { ...draft, review: { verdict: "ACCEPT", findings: [], revised: false } };
  let revised: EditorPlan;
  try {
    revised = await write(provider, input, { draft, findings });
  } catch {
    return { ...draft, review: { verdict: "REVISE", findings, revised: false } };
  }
  // A revision that lost the take is worse than the draft: keep the draft when it kept more of
  // the story and cleared nothing.
  const before = found.length;
  const after = editorPlanChecklist(revised, input.lines).length;
  if (revised.storyline.length < Math.ceil(draft.storyline.length / 2) && after >= before) return { ...draft, review: { verdict: "REVISE", findings, revised: false } };
  return { ...revised, review: { verdict: "REVISE", findings, revised: true } };
}
