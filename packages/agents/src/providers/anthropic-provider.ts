import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type {
  ModelProvider,
  ModelUsage,
  StructuredCompletionRequest,
  StructuredCompletionResult,
  LlmModelClass,
  ModelToolOptions,
} from "../model-provider";
import { ModelOutputParseError, ModelOutputTruncatedError, ModelRefusalError } from "../model-provider";

/**
 * Model-class -> concrete model ID. Overridable via env (MODEL_HIGH / MODEL_MEDIUM /
 * MODEL_LOW) so a provider swap or a model generation change never requires touching agent
 * code — see /docs/ARCHITECTURE.md §16. IDs verified live via models.retrieve on 2026-10-16.
 */
export const DEFAULT_MODEL_BY_CLASS: Record<LlmModelClass, string> = {
  HIGH: "claude-opus-5-5",
  MEDIUM: "claude-sonnet-5-5",
  LOW: "claude-haiku-5-5",
};

/**
 * Thinking is adaptive (on by default) on every default model above; `effort` is the only
 * depth control, and Opus 5.5 / Haiku 5.5 default to "medium" — so it is always set
 * explicitly. HIGH-judgment calls (Claims Gate, Creative Director, Weekly Strategist) get
 * "high"; routine tagging/formatting gets "low".
 */
const EFFORT_BY_CLASS: Record<LlmModelClass, "low" | "medium" | "high"> = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
};

/**
 * Generous output ceilings: thinking tokens count against max_tokens, so a tight cap would
 * truncate the structured answer after a long think. Calls are streamed (below), so a large
 * cap has no HTTP-timeout cost — and output is billed by tokens actually produced, not the cap.
 */
const MAX_TOKENS_BY_CLASS: Record<LlmModelClass, number> = {
  HIGH: 64_000,
  MEDIUM: 32_000,
  LOW: 16_000,
};

/** Server-side refusal fallback ("default" routing) is accepted for these models on the
 * Claude API — see the claude-api reference. Other models (or MODEL_REFUSAL_FALLBACK=off)
 * send no fallback and surface a refusal as ModelRefusalError. */
const FALLBACK_CAPABLE_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-1"]);

/** Models that accept the dynamic-filtering web tool versions (web_*_20260209). Others get
 * the basic versions. */
const DYNAMIC_WEB_TOOL_MODELS = /^claude-(opus-(5|4-[678])|sonnet-(5|4-6)|fable-5)/;

/** A server-side tool loop can pause after its iteration limit (stop_reason "pause_turn");
 * resuming is a bounded number of follow-up requests, never unbounded. */
const MAX_PAUSE_TURN_CONTINUATIONS = 3;

export function resolveModel(modelClass: LlmModelClass): string {
  const envKey = `MODEL_${modelClass}` as const;
  return process.env[envKey] || DEFAULT_MODEL_BY_CLASS[modelClass];
}

function buildTools(model: string, tools: ModelToolOptions | undefined): Anthropic.Beta.BetaToolUnion[] {
  if (!tools) return [];
  const dynamic = DYNAMIC_WEB_TOOL_MODELS.test(model);
  const out: Anthropic.Beta.BetaToolUnion[] = [];
  if (tools.webSearch && tools.webSearch.maxUses > 0) {
    const common = {
      name: "web_search" as const,
      max_uses: tools.webSearch.maxUses,
      ...(tools.webSearch.allowedDomains?.length ? { allowed_domains: tools.webSearch.allowedDomains } : {}),
    };
    out.push(
      dynamic
        ? { type: "web_search_20260209", ...common }
        : { type: "web_search_20250305", ...common },
    );
  }
  if (tools.webFetch && tools.webFetch.maxUses > 0) {
    const common = { name: "web_fetch" as const, max_uses: tools.webFetch.maxUses, max_content_tokens: 20_000 };
    out.push(dynamic ? { type: "web_fetch_20260209", ...common } : { type: "web_fetch_20250910", ...common });
  }
  return out;
}

function addUsage(total: ModelUsage, usage: Anthropic.Beta.BetaUsage | null | undefined): void {
  if (!usage) return;
  total.inputTokens += usage.input_tokens ?? 0;
  total.outputTokens += usage.output_tokens ?? 0;
  total.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
  total.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
  total.webSearchRequests += usage.server_tool_use?.web_search_requests ?? 0;
  total.webFetchRequests += usage.server_tool_use?.web_fetch_requests ?? 0;
}

/** The structured answer is the final text block (earlier text blocks, if any, are preamble
 * between server-tool calls). */
function extractJsonText(content: Anthropic.Beta.BetaContentBlock[]): string | undefined {
  const texts = content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text");
  return texts.at(-1)?.text;
}

export class AnthropicModelProvider implements ModelProvider {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    // new Anthropic() with no args resolves ANTHROPIC_API_KEY from the environment.
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  }

  async completeStructured<T>(
    request: StructuredCompletionRequest<T>,
  ): Promise<StructuredCompletionResult<T>> {
    const requestedModel = resolveModel(request.modelClass);
    const maxTokens = MAX_TOKENS_BY_CLASS[request.modelClass];
    const startedAt = Date.now();

    // Prompt caching: the system prompt (SYSTEM_BASE + agent prompt) and the shared stable
    // context (brand docs) are byte-identical across calls, so each gets a breakpoint. Render
    // order is tools -> system -> messages, and the tool list is deterministic per agent.
    const userContent: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (request.stableContext) {
      userContent.push({ type: "text", text: request.stableContext, cache_control: { type: "ephemeral" } });
    }
    for (const image of request.images ?? []) {
      if (image.label) userContent.push({ type: "text", text: image.label });
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: image.mediaType, data: image.base64 },
      });
    }
    userContent.push({ type: "text", text: request.userPrompt });

    // The SDK helper converts the zod schema to the API's JSON-schema subset; we strip its
    // auto-parse hook and validate ourselves below so truncation/refusal are reported as
    // typed errors (with usage attached) rather than a generic parse exception.
    const { parse: _autoParse, ...format } = betaZodOutputFormat(request.schema);
    void _autoParse;
    const tools = buildTools(requestedModel, request.tools);
    const useFallback =
      FALLBACK_CAPABLE_MODELS.has(requestedModel) && process.env.MODEL_REFUSAL_FALLBACK !== "off";

    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: userContent }];
    const usage: ModelUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
    };

    let final: Anthropic.Beta.BetaMessage | undefined;
    for (let attempt = 0; attempt <= MAX_PAUSE_TURN_CONTINUATIONS; attempt += 1) {
      // Streamed so large max_tokens never trips the SDK's non-streaming timeout guard.
      const stream = this.client.beta.messages.stream({
        model: requestedModel,
        max_tokens: maxTokens,
        system: [{ type: "text", text: request.systemPrompt, cache_control: { type: "ephemeral" } }],
        messages,
        output_config: { effort: EFFORT_BY_CLASS[request.modelClass], format },
        ...(tools.length > 0 ? { tools } : {}),
        ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      final = await stream.finalMessage();
      addUsage(usage, final.usage);
      if (final.stop_reason !== "pause_turn") break;
      // Resume a paused server-tool loop: echo the assistant turn back unchanged; the API
      // detects the trailing server_tool_use block and continues.
      messages.push({ role: "assistant", content: final.content as Anthropic.Beta.BetaContentBlockParam[] });
    }

    const latencyMs = Date.now() - startedAt;
    const model = final?.model ?? requestedModel;

    if (!final || final.stop_reason === "pause_turn") {
      throw new ModelOutputTruncatedError(request.promptId, model, maxTokens, usage, latencyMs);
    }
    if (final.stop_reason === "refusal") {
      throw new ModelRefusalError(request.promptId, model, final.stop_details?.category ?? null, usage, latencyMs);
    }
    if (final.stop_reason === "max_tokens") {
      throw new ModelOutputTruncatedError(request.promptId, model, maxTokens, usage, latencyMs);
    }

    const text = extractJsonText(final.content);
    let parsedJson: unknown;
    try {
      parsedJson = text === undefined ? undefined : JSON.parse(text);
    } catch {
      parsedJson = undefined;
    }
    const validated = request.schema.safeParse(parsedJson);
    if (!validated.success) {
      throw new ModelOutputParseError(request.promptId, model, usage, latencyMs);
    }

    return {
      output: validated.data,
      model,
      inputTokens: usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens,
      outputTokens: usage.outputTokens,
      usage,
      latencyMs,
    };
  }
}
