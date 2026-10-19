import { describe, it, expect } from "vitest";
import { isSchemaTooComplexError, parseJsonAnswer } from "../providers/anthropic-provider";

describe("strict-schema fallback (Anthropic refuses schemas with >16 union params)", () => {
  it("recognises the API's refusal (seen live 2026-10-19 on the Motion Designer)", () => {
    const live = new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Schemas contains too many parameters with union types (32 parameters with type arrays or anyOf). This causes exponential compilation cost. Reduce the number of nullable or union-typed parameters (limit: 16 parameters with unions)."}}');
    expect(isSchemaTooComplexError(live)).toBe(true);
    expect(isSchemaTooComplexError(new Error("400 credit balance is too low"))).toBe(false);
  });

  it("reads a prompt-mode answer: plain, fenced, or with stray prose", () => {
    expect(parseJsonAnswer('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonAnswer('```json\n{"a":{"b":[1,2]}}\n```')).toEqual({ a: { b: [1, 2] } });
    expect(parseJsonAnswer('Here you go: {"a":null} hope that helps')).toEqual({ a: null });
    expect(parseJsonAnswer("no json here")).toBeUndefined();
    expect(parseJsonAnswer(undefined)).toBeUndefined();
  });
});
