import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPromptRegistry, getActivePrompt, type LoadedPrompt } from "@chris/prompts";
import type { LlmModelClass } from "./model-provider";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/agents/src -> repo root is three levels up.
const REPO_ROOT = join(__dirname, "..", "..", "..");
const SHARED_DIR = join(REPO_ROOT, "prompts", "shared");
const AGENTS_DIR = join(REPO_ROOT, "prompts", "agents");

let cache: LoadedPrompt[] | null = null;

/** Loads and validates the whole registry once per process. Re-throws (doesn't cache) a
 * validation failure — a broken prompt file should never appear to "work" on retry. */
function getRegistry(): LoadedPrompt[] {
  if (!cache) {
    cache = loadPromptRegistry([SHARED_DIR, AGENTS_DIR]);
  }
  return cache;
}

export class PromptNotFoundError extends Error {
  constructor(promptId: string) {
    super(`No active prompt found for prompt_id "${promptId}".`);
    this.name = "PromptNotFoundError";
  }
}

export function getAgentPrompt(promptId: string): LoadedPrompt {
  const prompt = getActivePrompt(getRegistry(), promptId);
  if (!prompt) throw new PromptNotFoundError(promptId);
  return prompt;
}

export function getSystemBase(): string {
  return getAgentPrompt("SYSTEM_BASE").body;
}

/** Concatenates the shared system prompt with a specific agent's prompt — every specialist
 * receives both, per /prompts/README.md ("every specialist prompt is loaded together with
 * SYSTEM_BASE.md, not instead of it"). */
export function buildSystemPrompt(promptId: string): { systemPrompt: string; modelClass: LlmModelClass } {
  const agentPrompt = getAgentPrompt(promptId);
  const modelClass = agentPrompt.frontmatter.model_class;
  if (modelClass === "DETERMINISTIC") {
    throw new Error(
      `prompt_id "${promptId}" is model_class DETERMINISTIC — it should be plain code, not a model call.`,
    );
  }
  return {
    systemPrompt: `${getSystemBase()}\n\n---\n\n${agentPrompt.body}`,
    modelClass,
  };
}
