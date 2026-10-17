import { z } from "zod";
import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";

/**
 * Plan Importer — the OPTIONAL "Clean up with AI" step of plan import
 * (/prompts/agents/PLAN_IMPORTER.md). The deterministic parser in
 * @chris/domain/plan-import is always the first pass and works with no model at all; this only
 * restructures messy pasted text it couldn't read. MEDIUM class, strict schema.
 *
 * Provenance guard (code, not trust): a row whose title doesn't come from the pasted text is
 * dropped, and a hook that isn't in the text is cleared — the model may reformat Chris's plan,
 * never add to it.
 */

export const PlanImporterRowSchema = z.object({
  title: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  dateText: z.string(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  platforms: z.array(z.enum(["TIKTOK", "INSTAGRAM", "YOUTUBE"])),
  hook: z.string().nullable(),
  notes: z.string().nullable(),
  format: z.string().nullable(),
  pillar: z.enum(["SKILL", "MINDSET", "LIFESTYLE", "PASSIONS"]).nullable(),
});
export const PlanImporterResultSchema = z.object({
  rows: z.array(PlanImporterRowSchema).max(500),
  warnings: z.array(z.string()),
});
export type PlanImporterRow = z.infer<typeof PlanImporterRowSchema>;
export type PlanImporterResult = z.infer<typeof PlanImporterResultSchema>;

export interface PlanImporterInput {
  text: string;
  today: string;
  startDate: string;
  enabledPlatforms: ("TIKTOK" | "INSTAGRAM" | "YOUTUBE")[];
}

export const PLAN_IMPORTER_MAX_CHARS = 20_000;

function words(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9$%]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1);
}

/** Share of the candidate's words that appear in the source text (0..1). */
export function sourceCoverage(candidate: string, source: string): number {
  const cand = words(candidate);
  if (cand.length === 0) return 0;
  const src = new Set(words(source));
  return cand.filter((w) => src.has(w)).length / cand.length;
}

/** Drops invented rows/hooks. Exported for tests. */
export function enforcePlanProvenance(result: PlanImporterResult, source: string): PlanImporterResult {
  const warnings = [...result.warnings];
  const rows: PlanImporterRow[] = [];
  for (const r of result.rows) {
    if (sourceCoverage(r.title, source) < 0.6) {
      warnings.push(`Dropped "${r.title}" — it isn't in your plan text`);
      continue;
    }
    const hook = r.hook && sourceCoverage(r.hook, source) >= 0.6 ? r.hook : null;
    const notes = r.notes && sourceCoverage(r.notes, source) >= 0.6 ? r.notes : null;
    rows.push({ ...r, hook, notes });
  }
  return { rows, warnings };
}

export async function runPlanImporterAgent(provider: ModelProvider, input: PlanImporterInput): Promise<PlanImporterResult> {
  const text = input.text.slice(0, PLAN_IMPORTER_MAX_CHARS);
  const { systemPrompt, modelClass } = buildSystemPrompt("PLAN_IMPORTER");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: `Today: ${input.today}
Plan start date (Day 1 / Week 1): ${input.startDate}
Enabled platforms ("all" means these): ${input.enabledPlatforms.join(", ")}

## Chris's plan (verbatim)

${text}

## Task

Return every planned video in the text as rows, per your instructions. Copy titles as written.`,
    schema: PlanImporterResultSchema,
    promptId: "PLAN_IMPORTER",
  });
  return enforcePlanProvenance(result.output, text);
}
