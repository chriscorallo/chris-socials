import { z } from "zod";
import { parseDirectorAnswer, type DirectorParse } from "@chris/media/director";
import { scopeProvider, type ModelImageInput, type ModelProvider, type StructuredCompletionResult } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { PRICE_PER_MTOK_BY_MODEL, CONSERVATIVE_FALLBACK_PRICE } from "./pricing";
import { resolveModel } from "./providers/anthropic-provider";

/**
 * Director chat — the PAID brain (/prompts/agents/DIRECTOR_CHAT.md). Exactly the pack Chris
 * would send to ChatGPT (same text, same frames image), sent to Claude with vision when he has
 * AI credit and taps it. MEDIUM class. The structured output is a thin wire shape (`reply` +
 * `operations_json`) so the API's JSON-schema subset never has to express the open-ended graphic
 * props; the operations then go through the SAME tolerant parser + strict validator as a ChatGPT
 * paste (one code path, one set of guarantees). Never called in tests (MockModelProvider).
 */

export const DIRECTOR_PROMPT_ID = "DIRECTOR_CHAT";

export const DirectorWireSchema = z.object({
  reply: z.string().describe("1–2 sentences to Chris"),
  operations_json: z.string().describe("the operations array as JSON text, exactly per the SHAPE in the message"),
});
export type DirectorWire = z.infer<typeof DirectorWireSchema>;

export interface DirectorAgentInput {
  pack: string;
  image: { base64: string; mediaType: "image/jpeg" | "image/png" } | null;
  contentItemId: string;
}

export interface DirectorAgentResult {
  parse: DirectorParse;
  /** The raw answer (stored on the ANSWER message). */
  raw: string;
  model: string;
  call: Pick<StructuredCompletionResult<DirectorWire>, "inputTokens" | "outputTokens" | "usage" | "latencyMs">;
}

/** Wire answer → the same text a ChatGPT paste would be (then the shared parser runs). */
export function wireToAnswerText(w: DirectorWire): string {
  let ops: unknown;
  try {
    ops = JSON.parse(w.operations_json);
  } catch {
    // leave it to the tolerant parser
    return `{"reply": ${JSON.stringify(w.reply)}, "operations": ${w.operations_json}}`;
  }
  return JSON.stringify({ reply: w.reply, operations: ops });
}

export async function runDirectorAgent(provider: ModelProvider, input: DirectorAgentInput): Promise<DirectorAgentResult> {
  const { systemPrompt, modelClass } = buildSystemPrompt(DIRECTOR_PROMPT_ID);
  const images: ModelImageInput[] = input.image ? [{ ...input.image, label: "FRAMES IMAGE (labelled with time + detected expression):" }] : [];
  const res = await scopeProvider(provider, { contentItemId: input.contentItemId }).completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: input.pack,
    images,
    schema: DirectorWireSchema,
    promptId: DIRECTOR_PROMPT_ID,
  });
  const raw = wireToAnswerText(res.output);
  return { parse: parseDirectorAnswer(raw), raw, model: res.model, call: { inputTokens: res.inputTokens, outputTokens: res.outputTokens, usage: res.usage, latencyMs: res.latencyMs } };
}

/**
 * What one Director message will roughly cost on the paid path (shown on the button). Input =
 * system (~1.6k tokens) + pack (chars / 3.5) + image (~1.6k tokens); output incl. thinking ≈ 4k
 * tokens at MEDIUM effort. An estimate — the real cost is logged per call.
 */
export function estimateDirectorCostUsd(packChars: number, withImage: boolean): { usd: number; model: string } {
  const model = resolveModel("MEDIUM");
  const price = PRICE_PER_MTOK_BY_MODEL[model] ?? CONSERVATIVE_FALLBACK_PRICE;
  const inTok = 1600 + packChars / 3.5 + (withImage ? 1600 : 0);
  const outTok = 4000;
  return { usd: Math.round(((inTok * price.input + outTok * price.output) / 1e6) * 1000) / 1000, model };
}
