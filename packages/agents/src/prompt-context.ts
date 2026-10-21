import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPromptRegistry, getActivePrompt, type LoadedPrompt } from "@chris/prompts";
import type { LlmModelClass } from "./model-provider";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/agents/src -> repo root is three levels up.
export const REPO_ROOT = join(__dirname, "..", "..", "..");
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
    systemPrompt: `${getSystemBase()}${contentIntelligenceFor(promptId)}\n\n---\n\n${agentPrompt.body}`,
    modelClass,
  };
}

/** The shared creative layers an agent declared (frontmatter `content_intelligence`), as
 * "\n\n---\n\n…" blocks — empty for NONE/absent. FULL = the Operator persona (the creator who
 * built the brand from videos alone: attention, interest, engagement, trust, weak material,
 * coherence) + the whole playbook; CORE = both in short. Same text every call, so it caches
 * with the system prompt. */
const SCREEN_AGENTS = new Set(["EDITOR", "VISUAL_STRATEGIST", "MOTION_DESIGNER", "VIEWER_PANEL", "FLOW_CHECK"]);

export function contentIntelligenceFor(promptId: string): string {
  const level = getAgentPrompt(promptId).frontmatter.content_intelligence ?? "NONE";
  if (level === "NONE") return "";
  const operator = getAgentPrompt(level === "FULL" ? "CREATOR_OPERATOR" : "CREATOR_OPERATOR_CORE").body.trim();
  const playbook = getAgentPrompt(level === "FULL" ? "CONTENT_INTELLIGENCE" : "CONTENT_INTELLIGENCE_CORE").body.trim();
  // The agents that own the screen also get the Editor's orchestration rules (one lead at a
  // time, fixed anchors, timing tied to words and held for the idea, motion felt not seen).
  const orchestration = SCREEN_AGENTS.has(promptId) ? `\n\n---\n\n${getAgentPrompt("EDITOR_ORCHESTRATION").body.trim()}` : "";
  return `\n\n---\n\n${operator}\n\n---\n\n${playbook}${orchestration}`;
}
