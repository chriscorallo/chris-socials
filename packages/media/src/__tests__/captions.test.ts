import { describe, it, expect } from "vitest";
import {
  buildAssDocument,
  buildCaptionChunks,
  layoutCaptionChunks,
  remapWordsToOutputTimeline,
  sanitizeAssText,
  type TranscriptWord,
} from "../captions";
import { layoutOverlays } from "../overlay-layout";
import { checkCaptionOverlayCollisions } from "../overlay-collision";
import { getSafeArea, rectInsideSafeArea, rectsIntersect } from "../safe-zones";

const canvas = { width: 1080, height: 1920 };

function words(spec: Array<[string, number, number]>): TranscriptWord[] {
  return spec.map(([word, start, end]) => ({ word, start, end }));
}

describe("remapWordsToOutputTimeline", () => {
  it("drops words in cut regions, shifts kept words, and offsets later segments", () => {
    const src = words([
      ["intro", 0.0, 0.4], // cut
      ["Most", 1.0, 1.2],
      ["people", 1.2, 1.5],
      ["um", 2.0, 2.2], // cut
      ["think", 3.0, 3.3],
    ]);
    const out = remapWordsToOutputTimeline(src, [
      { startSeconds: 0.9, endSeconds: 1.6 },
      { startSeconds: 2.9, endSeconds: 3.5 },
    ]);
    expect(out.map((w) => w.word)).toEqual(["Most", "people", "think"]);
    expect(out[0]!.start).toBeCloseTo(0.1, 3);
    expect(out[2]!.start).toBeCloseTo(0.7 + 0.1, 3);
  });

  it("clips a word straddling a cut, and drops it when too little survives", () => {
    const src = words([["long", 1.0, 2.0], ["tiny", 3.0, 3.5]]);
    const out = remapWordsToOutputTimeline(src, [
      { startSeconds: 1.4, endSeconds: 2.5 }, // keeps 0.6s of "long"
      { startSeconds: 3.45, endSeconds: 4 }, // keeps 0.05s of "tiny" -> dropped
    ]);
    expect(out.map((w) => w.word)).toEqual(["long"]);
    expect(out[0]).toMatchObject({ start: 0, end: 0.6 });
  });
});

describe("buildCaptionChunks", () => {
  it("chunks 2-4 words, breaking on sentence punctuation and pauses > 0.35s", () => {
    const ws = words([
      ["Most", 0, 0.2], ["people", 0.2, 0.4], ["think", 0.4, 0.8], ["a", 0.8, 0.9],
      ["credit", 0.9, 1.2], ["score", 1.2, 1.5], ["is", 1.5, 1.7], ["a", 1.7, 1.8], ["grade.", 1.8, 2.1],
      ["It", 2.6, 2.8], ["is", 2.8, 2.9], ["not.", 2.9, 3.1],
    ]);
    const chunks = buildCaptionChunks(ws);
    for (const c of chunks) expect(c.words.length).toBeLessThanOrEqual(4);
    expect(chunks[chunks.length - 1]!.text).toBe("It is not.");
    // No chunk spans the sentence boundary.
    expect(chunks.some((c) => c.text.includes("grade. It"))).toBe(false);
    // Chronological, non-overlapping.
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBeGreaterThanOrEqual(chunks[i - 1]!.end);
  });

  it("splits on a long pause even mid-sentence", () => {
    const chunks = buildCaptionChunks(words([["So", 0, 0.2], ["here's", 0.2, 0.5], ["the", 1.5, 1.7], ["thing", 1.7, 2.0]]));
    expect(chunks.map((c) => c.text)).toEqual(["So here's", "the thing"]);
  });
});

describe("caption layout + ASS document", () => {
  const ws = words([["Save", 0, 0.3], ["50%", 0.3, 0.8], ["more", 0.8, 1.1], ["today.", 1.1, 1.5]]);

  it("keeps captions inside the safe zone and emits a valid ASS script", () => {
    const layout = layoutCaptionChunks(buildCaptionChunks(ws), { enabled: true, style: "CLEAN", position: "LOWER" }, canvas);
    const safe = getSafeArea(1080, 1920);
    for (const l of layout.layouts) expect(rectInsideSafeArea(l.rect, safe)).toBe(true);
    const ass = buildAssDocument(layout, canvas);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("Style: Caption,Inter Display,");
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.00,.*\\an2\\pos\(540,\d+\)\}Save 50%/);
  });

  it("BOLD_HIGHLIGHT emits one event per word with the active word coloured", () => {
    const layout = layoutCaptionChunks(buildCaptionChunks(ws), { enabled: true, style: "BOLD_HIGHLIGHT", position: "LOWER" }, canvas);
    const ass = buildAssDocument(layout, canvas);
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(events).toHaveLength(4);
    expect(events[1]).toContain("{\\c&H4DD8FF&}50%{\\c&HFFFFFF&}");
  });

  it("neutralises ASS override syntax in transcript text", () => {
    expect(sanitizeAssText("a {\\b1} b \\N c")).toBe("a (/b1) b /N c");
  });

  it("moves a caption phrase out of the way of a same-band overlay instead of colliding", () => {
    const overlays = layoutOverlays(
      [{ text: "Chris Corallo — credit, explained", startSeconds: 0, endSeconds: 2, position: "BOTTOM", style: "LOWER_THIRD" }],
      canvas,
    );
    const layout = layoutCaptionChunks(buildCaptionChunks(ws), { enabled: true, style: "CLEAN", position: "LOWER" }, canvas, overlays);
    for (const l of layout.layouts) {
      expect(rectsIntersect(l.rect, overlays[0]!.rect)).toBe(false);
      expect(l.residualCollisionWith).toEqual([]);
    }
    expect(layout.layouts.some((l) => l.relocated)).toBe(true);
    expect(
      checkCaptionOverlayCollisions({
        overlays: [{ text: "Chris Corallo — credit, explained", startSeconds: 0, endSeconds: 2, position: "BOTTOM", style: "LOWER_THIRD" }],
        captions: { enabled: true, style: "CLEAN", position: "LOWER" },
        sourceWords: ws,
        segments: [{ startSeconds: 0, endSeconds: 2 }],
        canvas,
      }),
    ).toEqual([]);
  });
});
