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

/**
 * Provider-hosted retrieval tools a call may use. Vendor-neutral on purpose: the Anthropic
 * provider maps these to its server-side web search / web fetch tools; a provider without
 * retrieval simply ignores them (and the agent's prompt still forbids inventing sources).
 * `maxUses` is a hard per-call budget — retrieval is billed per use.
 */
export interface ModelToolOptions {
  webSearch?: { maxUses: number; allowedDomains?: string[] };
  webFetch?: { maxUses: number };
}

export interface StructuredCompletionRequest<T> {
  /** Which routing tier this call belongs to — see /docs/ARCHITECTURE.md. */
  modelClass: LlmModelClass;
  systemPrompt: string;
  /**
   * Large, stable context shared across many calls (Brand Constitution, Chris Brain, voice
   * samples). Kept separate from `userPrompt` so a provider can prompt-cache it — it renders
   * before the per-call prompt, never after. Optional: omit for agents with no shared context.
   */
  stableContext?: string;
  userPrompt: string;
  /** Images to attach after the text prompt, in order — omit entirely for text-only agents. */
  images?: ModelImageInput[];
  schema: z.ZodType<T>;
  /** The prompt_id this call is executing, for observability (see AuditLog "MODEL_RUN"). */
  promptId: string;
  tools?: ModelToolOptions;
}

/** Everything billable about one call. Token counts are the provider's own report. */
export interface ModelUsage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
}

export interface StructuredCompletionResult<T> {
  output: T;
  model: string;
  /** Total input tokens processed (uncached + cache write + cache read) — kept for callers
   * that only need a single number; `usage` carries the billable breakdown. */
  inputTokens?: number;
  outputTokens?: number;
  usage?: ModelUsage;
  latencyMs: number;
}

/** Per-call attribution a decorator (CostTrackingModelProvider) can record. */
export interface ModelCallContext {
  contentItemId?: string;
}

export interface ModelProvider {
  completeStructured<T>(
    request: StructuredCompletionRequest<T>,
  ): Promise<StructuredCompletionResult<T>>;
  /** Returns a provider that attributes every call to this context (e.g. ModelCallLog
   * .contentItemId). Optional — providers with nothing to attribute just omit it. */
  withContext?(context: ModelCallContext): ModelProvider;
}

/** `provider.withContext(ctx)` when supported, else the provider unchanged. */
export function scopeProvider(provider: ModelProvider, context: ModelCallContext): ModelProvider {
  return provider.withContext ? provider.withContext(context) : provider;
}

/**
 * Base class for failures that happened AFTER the provider spent tokens. Carrying `usage`
 * lets the cost governor log (and count toward the spend cap) calls that were billed but
 * produced nothing usable — a truncated or refused call still costs money.
 */
export class BilledModelCallError extends Error {
  constructor(
    message: string,
    public readonly model: string,
    public readonly usage: ModelUsage | undefined,
    public readonly latencyMs: number,
  ) {
    super(message);
    this.name = "BilledModelCallError";
  }
}

export class ModelOutputParseError extends BilledModelCallError {
  constructor(promptId: string, model: string, usage?: ModelUsage, latencyMs = 0, detail?: string) {
    super(
      `Model output for prompt "${promptId}" (model ${model}) did not parse against the expected schema.${detail ? ` ${detail}` : ""}`,
      model,
      usage,
      latencyMs,
    );
    this.name = "ModelOutputParseError";
  }
}

/** stop_reason "max_tokens": the output was cut off, so it can't be trusted even if a prefix
 * happens to parse. */
export class ModelOutputTruncatedError extends BilledModelCallError {
  constructor(promptId: string, model: string, maxTokens: number, usage?: ModelUsage, latencyMs = 0) {
    super(
      `Model output for prompt "${promptId}" (model ${model}) hit max_tokens (${maxTokens}) and was truncated.`,
      model,
      usage,
      latencyMs,
    );
    this.name = "ModelOutputTruncatedError";
  }
}

/** stop_reason "refusal": the provider's safety layer declined (after any configured
 * fallback model also declined). */
export class ModelRefusalError extends BilledModelCallError {
  constructor(
    promptId: string,
    model: string,
    public readonly category: string | null,
    usage?: ModelUsage,
    latencyMs = 0,
  ) {
    super(
      `Model declined prompt "${promptId}" (model ${model}${category ? `, category ${category}` : ""}).`,
      model,
      usage,
      latencyMs,
    );
    this.name = "ModelRefusalError";
  }
}
