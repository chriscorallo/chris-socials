import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileFilm, evaluateFrame } from "../evaluate";
import { PROOF_FILM } from "../films/the-raise";
import { alignWords, anchorFrame, resolveAnchor, resolveFilm, type LineClip } from "../timing";
import { tokenizeLine } from "../dsl/words";

function fakeClips(): Record<string, LineClip> {
  // Every line "spoken" at 3 words/s with a 0.1 s lead — like a real TTS clip + Whisper words.
  const out: Record<string, LineClip> = {};
  for (const sc of PROOF_FILM.scenes)
    for (const sh of sc.shots) {
      if (!sh.line) continue;
      const words = tokenizeLine(sh.line).map((t, i) => ({ word: t.raw.replace(/[“”]/g, ""), start: 0.1 + i / 3, end: 0.1 + i / 3 + 0.28 }));
      out[sh.id] = { durationSeconds: 0.2 + words.length / 3, words };
    }
  return out;
}

describe("timing", () => {
  it("lays shots end to end on exact frames", () => {
    const rf = resolveFilm(PROOF_FILM, fakeClips());
    expect(rf.measured).toBe(true);
    for (let i = 1; i < rf.shots.length; i++) expect(rf.shots[i]!.startFrame).toBe(rf.shots[i - 1]!.endFrame);
    expect(rf.totalFrames).toBe(rf.shots.at(-1)!.endFrame);
    expect(rf.durationSeconds).toBeGreaterThan(25);
  });

  it("resolves word anchors to the frame the word is spoken", () => {
    const rf = resolveFilm(PROOF_FILM, fakeClips());
    const taxes = rf.shots.find((s) => s.shot.id === "taxes")!;
    // "Taxes take thirty- five percent." -> "thirty" is word index 2 -> 0.1 + 2/3 s into the line
    const t = resolveAnchor(taxes, { word: "thirty" });
    expect(t).toBeCloseTo(taxes.lineStartSec! + 0.1 + 2 / 3, 5);
    expect(anchorFrame(rf, taxes, { word: "thirty" })).toBe(Math.round(t * 30));
    expect(resolveAnchor(taxes, { word: "thirty", edge: "end", offset: 0.1 })).toBeCloseTo(taxes.lineStartSec! + 0.1 + 2 / 3 + 0.28 + 0.1, 5);
    expect(resolveAnchor(taxes, { fraction: 0.5 })).toBeCloseTo((taxes.startSec + taxes.endSec) / 2, 5);
  });

  it("aligns script tokens to what Whisper heard (digits, missing words interpolate)", () => {
    const tokens = tokenizeLine("Your $10,000 raise is gone.");
    const heard = [
      { word: "Your", start: 0.0, end: 0.2 },
      { word: "10,000", start: 0.25, end: 0.9 },
      { word: "is", start: 1.4, end: 1.5 },
      { word: "gone.", start: 1.6, end: 2.0 },
    ];
    const a = alignWords(tokens, heard, 2.1);
    expect(a[1]).toMatchObject({ start: 0.25, interpolated: false });
    expect(a[2]!.interpolated).toBe(true); // "raise" wasn't heard -> placed between 0.9 and 1.4
    expect(a[2]!.start).toBeGreaterThanOrEqual(0.9);
    expect(a[2]!.end).toBeLessThanOrEqual(1.4);
    expect(a[4]).toMatchObject({ start: 1.6, end: 2.0 });
  });

  it("estimates timing without narration (storyboards)", () => {
    const rf = resolveFilm(PROOF_FILM, null);
    expect(rf.measured).toBe(false);
    expect(rf.shots.every((s) => s.endFrame > s.startFrame)).toBe(true);
  });

  it("is deterministic: same film + timing -> identical frame state", () => {
    const hash = (f: number) => {
      const cf = compileFilm(resolveFilm(PROOF_FILM, fakeClips()));
      return createHash("sha256").update(JSON.stringify(evaluateFrame(cf, f))).digest("hex");
    };
    for (const f of [0, 45, 200, 611, 900]) expect(hash(f)).toBe(hash(f));
  });
});
