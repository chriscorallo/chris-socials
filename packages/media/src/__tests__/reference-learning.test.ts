import { describe, it, expect } from "vitest";
import { classifyTextEvents, summariseText, textEvents, type OcrFrame, type OcrWord } from "../reference/text-events";
import { detectReferenceZooms } from "../reference/zooms";
import { referencePads } from "../reference/splice-pads";
import type { SubjectTrack } from "../subject-track-core";
import type { SpliceAnalysis } from "../splice/analysis";

/** Frames at 4 fps with a headline held in the top band and caption chunks changing in the low band. */
function reel(durationS: number): OcrFrame[] {
  const frames: OcrFrame[] = [];
  const word = (text: string, x: number, y: number, h = 0.04, conf = 90): OcrWord => ({ text, conf, x, y, w: text.length * h * 0.5, h });
  const captions = ["TWO", "PEOPLE", "BOTH", "MAKE", "ONE", "HUNDRED", "GRAND", "A", "YEAR", "SAME", "CITY", "SAME", "AGE"];
  for (let i = 0; i * 0.25 < durationS; i++) {
    const t = i * 0.25;
    const words: OcrWord[] = [];
    // headline 1 from 0.5–6 s, headline 2 from 6.5–12 s (two lines)
    if (t >= 0.5 && t < 6) words.push(word("SAME", 0.3, 0.12, 0.05), word("SALARY", 0.5, 0.12, 0.05));
    if (t >= 6.5 && t < 12) words.push(word("$733", 0.25, 0.11, 0.05), word("VS", 0.45, 0.11, 0.05), word("$4,133", 0.55, 0.11, 0.05), word("A", 0.35, 0.17, 0.05), word("MONTH", 0.45, 0.17, 0.05));
    // captions: one word every 0.5 s in the low band, from 1 s to 8 s
    if (t >= 1 && t < 8) words.push(word(captions[Math.floor((t - 1) / 0.5) % captions.length]!, 0.45, 0.7, 0.035));
    // OCR noise: low confidence junk
    if (i % 7 === 0) words.push(word("|||", 0.9, 0.5, 0.02, 20));
    frames.push({ t, words });
  }
  return frames;
}

describe("reference learning — on-screen text events", () => {
  it("tracks held blocks across frames into events, splits caption chunks, classifies headline vs caption", () => {
    const frames = reel(14);
    const events = classifyTextEvents(textEvents(frames));
    const heads = events.filter((e) => e.role === "HEADLINE");
    expect(heads.map((h) => h.text)).toEqual(["SAME SALARY", "$733 VS $4,133 A MONTH"]);
    expect(heads[0]!.start).toBeCloseTo(0.5, 2);
    expect(heads[0]!.end).toBeCloseTo(6, 2);
    expect(heads.every((h) => h.band === "TOP" && h.uppercase)).toBe(true);
    const caps = events.filter((e) => e.role === "CAPTION");
    expect(caps.length).toBeGreaterThanOrEqual(10);
    expect(caps.every((c) => c.band === "LOW" && c.words === 1)).toBe(true);
    // the low-confidence junk never becomes an event
    expect(events.some((e) => e.text.includes("|"))).toBe(false);
  });

  it("summarises headline cadence, caption style, the hook text and bare stretches", () => {
    const s = summariseText(reel(14), 14, { startS: 0.8, endS: 13 });
    expect(s.headlines.count).toBe(2);
    expect(s.headlines.per10s).toBeCloseTo(1.43, 1);
    expect(s.headlines.holdMedianS).toBeGreaterThanOrEqual(5.4);
    expect(s.headlines.band).toBe("TOP");
    expect(s.captions.present).toBe(true);
    expect(s.captions.wordsPerChunk).toBe(1);
    expect(s.captions.oneWordShare).toBe(1);
    expect(s.captions.band).toBe("LOW");
    expect(s.captions.coverage).toBeGreaterThan(0.5);
    expect(s.hook).toEqual({ text: "SAME SALARY", byS: 0.5 });
    // nothing on screen 12–14 s
    expect(s.longestBareS).toBeCloseTo(2, 1);
  });
});

describe("reference learning — zoom usage from the head size", () => {
  it("a push-in inside a shot is a zoom with its amount, ramp and hold; a cut is not", () => {
    const track: SubjectTrack = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 3;
      let w = 0.4;
      if (t >= 5 && t < 5.6) w = 0.4 + ((t - 5) / 0.6) * 0.06; // 15 % push-in over 0.6 s
      else if (t >= 5.6 && t < 10) w = 0.46;
      else if (t >= 10) w = 0.5; // after the cut at 10 s a new framing
      track.push({ t, box: { x: 0.3, y: 0.2, w, h: w * 0.9 } });
    }
    const z = detectReferenceZooms(track, [10], 20);
    expect(z.count).toBe(1);
    expect(z.amountMedian).toBeCloseTo(1.15, 1);
    expect(z.rampMedianS).toBeLessThanOrEqual(1);
    expect(z.holdMedianS).toBeGreaterThanOrEqual(3);
    expect(z.per10s).toBeCloseTo(0.5, 2);
  });
  it("detector jitter is not a zoom", () => {
    const track: SubjectTrack = Array.from({ length: 60 }, (_, i) => ({ t: i / 3, box: { x: 0.3, y: 0.2, w: 0.4 + (i % 2 ? 0.01 : -0.01), h: 0.36 } }));
    expect(detectReferenceZooms(track, [], 20).count).toBe(0);
  });
});

describe("reference learning — the pads a reference leaves at its cuts", () => {
  it("measures offset→cut and cut→onset at cuts with voice on both sides only", () => {
    const a: SpliceAnalysis = {
      version: 1,
      durationS: 20,
      floorDb: -60,
      speechDb: -20,
      voice: [
        { start: 0.5, end: 4.9, db: -20 },
        { start: 5.08, end: 9.85, db: -20 },
        { start: 10.1, end: 14, db: -20 },
        { start: 16, end: 19, db: -20 },
      ],
      bursts: [],
    };
    // cut at 5.0 (tail 100 ms, lead 80 ms), at 9.95 (100 / 150), at 15 (scene change: 1 s each side → ignored)
    const p = referencePads(a, [5.0, 9.95, 15]);
    expect(p.n).toBe(2);
    expect(p.tailMedianMs).toBe(100);
    expect(p.leadMedianMs).toBe(150);
    expect(p.airMedianMs).toBe(250);
  });
});
