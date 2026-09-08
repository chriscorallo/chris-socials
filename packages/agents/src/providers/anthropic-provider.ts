import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  ModelProvider,
  StructuredCompletionRequest,
  StructuredCompletionResult,
  LlmModelClass,
} from "../model-provider";
import { ModelOutputParseError } from "../model-provider";

/**
 * Model-class -> concrete model ID. Overridable via env so a provider swap or a model
 * generation change never requires touching agent code — see /docs/ARCHITECTURE.md §16.
 */
const DEFAULT_MODEL_BY_CLASS: Record<LlmModelClass, string> = {
  HIGH: "claude-opus-5",
  MEDIUM: "claude-sonnet-5",
  LOW: "claude-haiku-4-5-20251001",
};

function resolveModel(modelClass: LlmModelClass): string {
  const envKey = `MODEL_${modelClass}` as const;
  return process.env[envKey] ?? DEFAULT_MODEL_BY_CLASS[modelClass];
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
    const model = resolveModel(request.modelClass);
    const startedAt = Date.now();

    // Text-only agents keep the plain-string content shape; vision calls (Visual QA) attach
    // each sampled frame as its own image block, labelled so the model can cite a timestamp
    // without guessing frame order — see model-provider.ts's ModelImageInput.
    const content: Anthropic.MessageParam["content"] =
      request.images && request.images.length > 0
        ? [
            ...request.images.flatMap((image): Anthropic.ContentBlockParam[] => [
              ...(image.label ? [{ type: "text" as const, text: image.label }] : []),
              {
                type: "image",
                source: { type: "base64", media_type: image.mediaType, data: image.base64 },
              },
            ]),
            { type: "text", text: request.userPrompt },
          ]
        : request.userPrompt;

    const response = await this.client.messages.parse({
      model,
      max_tokens: 16000,
      system: request.systemPrompt,
      messages: [{ role: "user", content }],
      output_config: {
        format: zodOutputFormat(request.schema),
      },
    });

    const latencyMs = Date.now() - startedAt;

    if (response.parsed_output === null || response.parsed_output === undefined) {
      throw new ModelOutputParseError(request.promptId, model);
    }

    return {
      output: response.parsed_output,
      model,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      latencyMs,
    };
  }
}
