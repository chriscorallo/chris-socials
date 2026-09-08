import type {
  ModelProvider,
  StructuredCompletionRequest,
  StructuredCompletionResult,
} from "../model-provider";

/**
 * Deterministic, zero-cost provider for tests. Responses still go through the real Zod
 * schema (`request.schema.parse`), so a test fixture that doesn't match the agent's actual
 * output contract fails loudly — this isn't a rubber stamp, it's a stand-in for the network
 * call only.
 */
export class MockModelProvider implements ModelProvider {
  private readonly responder: (request: StructuredCompletionRequest<unknown>) => unknown;
  public readonly calls: StructuredCompletionRequest<unknown>[] = [];

  constructor(responder: (request: StructuredCompletionRequest<unknown>) => unknown) {
    this.responder = responder;
  }

  async completeStructured<T>(
    request: StructuredCompletionRequest<T>,
  ): Promise<StructuredCompletionResult<T>> {
    this.calls.push(request as StructuredCompletionRequest<unknown>);
    const raw = this.responder(request as StructuredCompletionRequest<unknown>);
    const output = request.schema.parse(raw);
    return {
      output,
      model: "mock",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    };
  }
}
