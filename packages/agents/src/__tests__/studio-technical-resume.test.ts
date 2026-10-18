import { describe, it, expect } from "vitest";
import { isTechnicalOnlyBlock } from "../studio/pipeline";

describe("studio: technical blocks are retryable, gate blocks are not", () => {
  it("only all-technical reasons count", () => {
    expect(isTechnicalOnlyBlock(["Technical: the storyboard renderer failed (ffmpeg exited 8)."])).toBe(true);
    expect(isTechnicalOnlyBlock(["Technical: render failed.", "FACTUAL: a number on screen isn't in the script."])).toBe(false);
    expect(isTechnicalOnlyBlock([])).toBe(false);
    expect(isTechnicalOnlyBlock(null)).toBe(false);
  });
});
