import { describe, it, expect } from "vitest";
import { buildTextPlatesAss, textAlphaExpr, zoomFilter } from "../timeline-render";
import { EditTimelineSchema, textOpacityAt } from "../timeline";
import { layoutTimelineText } from "../timeline-layout";
import { timelineCaptionChunks } from "../timeline-captions";

const measure = (t: string, _f: string, px: number) => t.length * px * 0.56;
const canvas = { width: 1080, height: 1920 };

describe("preview = render — text fades", () => {
  const t = { start: 2, end: 6, fadeIn: 0.2, fadeOut: 0.12 };
  it("textOpacityAt is the curve the preview draws; drawtext's alpha expression is the same curve", () => {
    expect(textOpacityAt(t, 1.99)).toBe(0);
    expect(textOpacityAt(t, 2.1)).toBeCloseTo(0.5, 6);
    expect(textOpacityAt(t, 4)).toBe(1);
    expect(textOpacityAt(t, 5.94)).toBeCloseTo(0.5, 6);
    expect(textOpacityAt(t, 6)).toBe(0);
    expect(textAlphaExpr(t)).toBe("min(clip((t-2)/0.2,0,1),clip((6-t)/0.12,0,1))");
    expect(textAlphaExpr({ start: 0, end: 1, fadeIn: 0, fadeOut: 0 })).toBeNull();
  });
  it("the plate behind a fading text fades with it (ASS \\fad in ms)", () => {
    const layout = layoutTimelineText({ text: "HELLO", fontId: "inter-display-extrabold", fontSize: 60, backgroundColor: "#000000B3", strokeColor: null, align: "center", x: 0.5, y: 0.2, maxWidth: 0.8, uppercase: true }, canvas, measure);
    const ass = buildTextPlatesAss([{ start: 2, end: 6, layout, fadeIn: 0.2, fadeOut: 0.12 }], canvas)!;
    expect(ass).toContain("\\fad(200,120)");
    expect(buildTextPlatesAss([{ start: 2, end: 6, layout }], canvas)!).not.toContain("\\fad");
  });
  it("a zoom with an ease-out renders the in-hold-out curve", () => {
    const f = zoomFilter([{ id: "z", start: 1, end: 5, zoom: 1.08, x: 0.5, y: 0.4, mode: "EASE", easeSeconds: 0.4, easeOutSeconds: 0.4 }], canvas, 60)!;
    expect(f).toContain("min(");
    expect(f).toContain("(5-((in-1)/60))/0.4");
  });
});

describe("preview = render — adaptive caption windows", () => {
  const words = Array.from({ length: 12 }, (_, i) => ({ word: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 }));
  const base = EditTimelineSchema.parse({
    version: 2,
    clips: [{ id: "c", mediaAssetId: "take", sourceStart: 0, sourceEnd: 6 }],
    captions: { fontId: "inter-display-extrabold", fontSize: 44, color: "#FFFFFF", highlightColor: "#FFD84D", y: 0.72, preset: "QUIET", maxWordsPerChunk: 2, chunking: [{ start: 0, end: 2, maxWords: 1 }, { start: 4, end: 6, maxWords: 3 }] },
  });
  it("one word at a time inside a 1-word window, phrases inside a 3-word window, the default between, chunks never cross a window", () => {
    const chunks = timelineCaptionChunks(base, { take: words });
    const inWin = (a: number, b: number) => chunks.filter((c) => c.start >= a - 1e-6 && c.start < b);
    expect(inWin(0, 2).every((c) => c.words.length === 1)).toBe(true);
    expect(inWin(2, 4).every((c) => c.words.length <= 2)).toBe(true);
    expect(Math.max(...inWin(4, 6).map((c) => c.words.length))).toBe(3);
    for (const c of chunks) expect(c.words.every((w) => (w.start < 2) === (c.words[0]!.start < 2) && (w.start >= 4) === (c.words[0]!.start >= 4))).toBe(true);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBeGreaterThanOrEqual(chunks[i - 1]!.end - 1e-6);
  });
});
