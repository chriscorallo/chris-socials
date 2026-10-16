import { describe, it, expect } from "vitest";
import { parseAnalysisStderr } from "../technical-qc";

const SAMPLE = `
[blackdetect @ 0x1] black_start:0 black_end:1.5 black_duration:1.5
[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 2.0
[freezedetect @ 0x2] lavfi.freezedetect.freeze_duration: 3.5
[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 5.5
[Parsed_ebur128_0 @ 0x3] Summary:

  Integrated loudness:
    I:         -14.3 LUFS
    Threshold: -24.6 LFS

  Loudness range:
    LRA:         4.2 LU
    Threshold: -34.6 LUFS
    LRA low:   -17.0 LUFS
    LRA high:  -12.8 LUFS

  True peak:
    Peak:       -1.2 dBFS
`;

describe("parseAnalysisStderr (pure)", () => {
  it("extracts integrated LUFS, true peak, LRA, black and freeze intervals", () => {
    const m = parseAnalysisStderr(SAMPLE);
    expect(m.integratedLufs).toBe(-14.3);
    expect(m.truePeakDbtp).toBe(-1.2);
    expect(m.loudnessRangeLu).toBe(4.2);
    expect(m.blackIntervals).toEqual([{ start: 0, end: 1.5, duration: 1.5 }]);
    expect(m.freezeIntervals).toEqual([{ start: 2, end: 5.5, duration: 3.5 }]);
  });

  it("returns nulls (not NaN) when nothing was measured", () => {
    const m = parseAnalysisStderr("no summary here");
    expect(m.integratedLufs).toBeNull();
    expect(m.truePeakDbtp).toBeNull();
    expect(m.blackIntervals).toEqual([]);
  });
});
