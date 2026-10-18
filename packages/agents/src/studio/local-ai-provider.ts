import { z } from "zod";
import { ModelOutputParseError, type LlmModelClass, type ModelProvider, type StructuredCompletionRequest, type StructuredCompletionResult } from "../model-provider";
import { extractJsonObject } from "./packs";

/**
 * OPTIONAL local AI for the studio — free, but needs Chris's Mac on (Ollama running) and ~10 GB of
 * disk for the models. OFF by default (feature flag `studio.local_ai` + `STUDIO_LOCAL_AI_URL`).
 *
 * Talks to Ollama's OpenAI-compatible endpoint (`POST {base}/v1/chat/completions`) with a JSON
 * schema response format, so it answers the SAME packs (same prompt, same zod schema) that Chris
 * would otherwise paste into ChatGPT. Text packs go to a local text model (default
 * `qwen2.5:7b-instruct`), packs with a storyboard image to a local vision model (default
 * `qwen2.5vl:7b`). Never billed: the class carries `free: true`, and the studio's pipeline only
 * accepts a `FreeModelProvider` — the Anthropic provider can't be passed in (type error).
 *
 * Reachability: a phone using the Vercel deployment can't reach a Mac's localhost — local AI works
 * when the app runs on the Mac (local dev) or when STUDIO_LOCAL_AI_URL points at a tunnel Chris
 * set up himself. Documented in docs/decisions-pending/studio-crew.md.
 */

export interface FreeModelProvider extends ModelProvider {
  readonly free: true;
}

export interface LocalAiOptions {
  baseUrl: string;
  textModel?: string;
  visionModel?: string;
  /** Per-call timeout (local models are slow on CPU). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_LOCAL_TEXT_MODEL = "qwen2.5:7b-instruct";
export const DEFAULT_LOCAL_VISION_MODEL = "qwen2.5vl:7b";

export class LocalAiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalAiUnavailableError";
  }
}

export class OllamaModelProvider implements FreeModelProvider {
  readonly free = true as const;
  private readonly base: string;
  private readonly textModel: string;
  private readonly visionModel: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LocalAiOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.textModel = opts.textModel ?? DEFAULT_LOCAL_TEXT_MODEL;
    this.visionModel = opts.visionModel ?? DEFAULT_LOCAL_VISION_MODEL;
    this.timeoutMs = opts.timeoutMs ?? 15 * 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  modelFor(_cls: LlmModelClass, hasImages: boolean): string {
    return hasImages ? this.visionModel : this.textModel;
  }

  async completeStructured<T>(request: StructuredCompletionRequest<T>): Promise<StructuredCompletionResult<T>> {
    const model = this.modelFor(request.modelClass, !!request.images?.length);
    const started = Date.now();
    const user: Array<Record<string, unknown>> = [];
    if (request.stableContext) user.push({ type: "text", text: request.stableContext });
    user.push({ type: "text", text: request.userPrompt });
    for (const img of request.images ?? []) {
      if (img.label) user.push({ type: "text", text: img.label });
      user.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });
    }
    const schema: unknown = (() => {
      try {
        return z.toJSONSchema(request.schema, { unrepresentable: "any" });
      } catch {
        return null;
      }
    })();
    const body = {
      model,
      stream: false,
      temperature: 0.4,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: user },
      ],
      response_format: schema ? { type: "json_schema", json_schema: { name: request.promptId.toLowerCase(), schema } } : { type: "json_object" },
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (err) {
      throw new LocalAiUnavailableError(`Couldn't reach the local AI at ${this.base} (${err instanceof Error ? err.message : String(err)}). Is Ollama running on the Mac?`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new LocalAiUnavailableError(`Local AI answered ${res.status}${res.status === 404 ? ` — is the model "${model}" pulled (ollama pull ${model})?` : ""} ${txt.slice(0, 200)}`);
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const content = json.choices?.[0]?.message?.content ?? "";
    const extracted = extractJsonObject(content);
    const parsed = extracted ? request.schema.safeParse(extracted.value) : null;
    if (!parsed?.success) throw new ModelOutputParseError(request.promptId, `local:${model}`, undefined, Date.now() - started);
    return { output: parsed.data, model: `local:${model}`, inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens, latencyMs: Date.now() - started };
  }
}

/** Test/demo provider that is free by construction (wraps any responder). */
export class FreeMockProvider implements FreeModelProvider {
  readonly free = true as const;
  readonly calls: StructuredCompletionRequest<unknown>[] = [];
  constructor(private readonly responder: (req: StructuredCompletionRequest<unknown>) => unknown) {}
  async completeStructured<T>(request: StructuredCompletionRequest<T>): Promise<StructuredCompletionResult<T>> {
    this.calls.push(request as StructuredCompletionRequest<unknown>);
    const output = request.schema.parse(this.responder(request as StructuredCompletionRequest<unknown>));
    return { output, model: "mock-free", inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  }
}
