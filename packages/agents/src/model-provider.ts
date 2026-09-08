import type { z } from "zod";

/**
 * Provider/model abstraction — spec §16: "Do not hardcode the architecture to one model
 * vendor." Every agent function in this package depends on this interface, never on a
 * concrete SDK. DETERMINISTIC work (per /docs/ARCHITECTURE.md's routing table) doesn't call
 * a model at all and has no representation here — it's just a plain function.
 */
export type LlmModelClass = "HIGH" | "MEDIUM" | "LOW";

/** A single sampled frame or reference image attached to a call — see Visual QA
 * (packages/agents/src/visual-qa-agent.ts), the first agent in this system that needs vision
 * input. Frame extraction itself is deterministic code (packages/media); this is just the
 * wire shape for handing the resulting image bytes to a vision-capable model. */
export interface ModelImageInput {
  base64: string;
  mediaType: "image/png" | "image/jpeg";
  /** Optional caption rendered immediately before the image (e.g. "t=2.0s") so the model can
   * tie a finding back to a timestamp without guessing frame order. */
  label?: string;
}

export interface StructuredCompletionRequest<T> {
  /** Which routing tier this call belongs to — see /docs/ARCHITECTURE.md. */
  modelClass: LlmModelClass;
  systemPrompt: string;
  userPrompt: string;
  /** Images to attach after the text prompt, in order — omit entirely for text-only agents. */
  images?: ModelImageInput[];
  schema: z.ZodType<T>;
  /** The prompt_id this call is executing, for observability (see AuditLog "MODEL_RUN"). */
  promptId: string;
}

export interface StructuredCompletionResult<T> {
  output: T;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
}

export class ModelOutputParseError extends Error {
  constructor(promptId: string, model: string) {
    super(`Model output for prompt "${promptId}" (model ${model}) did not parse against the expected schema.`);
    this.name = "ModelOutputParseError";
  }
}

export interface ModelProvider {
  completeStructured<T>(
    request: StructuredCompletionRequest<T>,
  ): Promise<StructuredCompletionResult<T>>;
}
