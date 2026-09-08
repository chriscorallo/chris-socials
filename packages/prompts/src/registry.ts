import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Loads and validates /prompts/shared/*.md and /prompts/agents/*.md against the registry
 * format in /prompts/README.md. This is the one place that format is enforced in code —
 * if a prompt file doesn't match, this throws with a specific reason, never a silent skip.
 */

export const PromptFrontmatterSchema = z.object({
  prompt_id: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver (x.y.z)"),
  role: z.string().min(1),
  required_context: z.array(z.string()).optional(),
  output_schema: z.string().optional(),
  model_class: z.enum(["HIGH", "MEDIUM", "LOW", "DETERMINISTIC"]),
  active: z.boolean(),
  eval_status: z.enum(["unevaluated", "passed", "failed"]),
  rollback_version: z.string().nullable(),
});

export type PromptFrontmatter = z.infer<typeof PromptFrontmatterSchema>;

export interface LoadedPrompt {
  frontmatter: PromptFrontmatter;
  body: string;
  filePath: string;
}

export class PromptRegistryError extends Error {}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function parsePromptFile(filePath: string): LoadedPrompt {
  const raw = readFileSync(filePath, "utf8");
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new PromptRegistryError(
      `${filePath}: missing YAML frontmatter (expected a leading "---" block).`,
    );
  }
  const [, frontmatterRaw, body] = match;

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(frontmatterRaw ?? "");
  } catch (err) {
    throw new PromptRegistryError(
      `${filePath}: frontmatter is not valid YAML — ${(err as Error).message}`,
    );
  }

  const result = PromptFrontmatterSchema.safeParse(parsedYaml);
  if (!result.success) {
    throw new PromptRegistryError(
      `${filePath}: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return { frontmatter: result.data, body: (body ?? "").trim(), filePath };
}

function listMarkdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(dir, entry.name));
}

/**
 * Loads every prompt file under the given directories, validates each, and enforces the
 * registry invariant: exactly one `active: true` version per prompt_id.
 */
export function loadPromptRegistry(dirs: string[]): LoadedPrompt[] {
  const files = dirs.flatMap((dir) => listMarkdownFiles(dir));
  const prompts = files.map(parsePromptFile);

  const activeByPromptId = new Map<string, LoadedPrompt[]>();
  for (const prompt of prompts) {
    if (!prompt.frontmatter.active) continue;
    const id = prompt.frontmatter.prompt_id;
    const list = activeByPromptId.get(id) ?? [];
    list.push(prompt);
    activeByPromptId.set(id, list);
  }

  for (const [id, actives] of activeByPromptId) {
    if (actives.length > 1) {
      throw new PromptRegistryError(
        `Duplicate active prompt_id "${id}" found in: ${actives
          .map((p) => p.filePath)
          .join(", ")}`,
      );
    }
  }

  const seenIds = new Set(prompts.map((p) => p.frontmatter.prompt_id));
  for (const id of seenIds) {
    if (!activeByPromptId.has(id)) {
      throw new PromptRegistryError(`prompt_id "${id}" has no active version.`);
    }
  }

  return prompts;
}

export function getActivePrompt(
  prompts: LoadedPrompt[],
  promptId: string,
): LoadedPrompt | undefined {
  return prompts.find((p) => p.frontmatter.prompt_id === promptId && p.frontmatter.active);
}
