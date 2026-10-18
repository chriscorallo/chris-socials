import { describe, expect, it } from "vitest";
import {
  nextSegmentIndex,
  resumeProgress,
  rewindProgress,
  segmentBar,
  segmentFileName,
  segmentsFromDraft,
  totalSeconds,
  uploadSegmentWithRetry,
  uploadSummary,
  wantsCountdown,
  type LocalSegment,
} from "./segments";

/** Segmented "Record here" — pure helpers (docs/decisions-pending/segmented-recording-drafts.md). */
const seg = (over: Partial<LocalSegment> = {}): LocalSegment => ({
  key: over.key ?? Math.random().toString(36).slice(2),
  index: 0,
  seconds: 5,
  scriptStart: 0,
  scriptEnd: 0.2,
  file: null,
  localUrl: null,
  remoteUrl: null,
  status: "uploaded",
  percent: 100,
  attempt: 1,
  error: null,
  ...over,
});

describe("segment bar + status", () => {
  it("parts are proportional, the bar never fills from the first seconds, and grows with the recording", () => {
    const b = segmentBar([seg({ key: "a", seconds: 6 }), seg({ key: "b", seconds: 12 })], 3);
    expect(b.scaleS).toBe(60);
    expect(b.parts.map((p) => p.frac)).toEqual([0.1, 0.2]);
    expect(b.currentFrac).toBeCloseTo(0.05);
    const long = segmentBar([seg({ seconds: 80 })], null);
    expect(long.scaleS).toBeCloseTo(92);
    expect(long.parts[0]!.frac).toBeLessThan(1);
    expect(totalSeconds([seg({ seconds: 2.5 }), seg({ seconds: 4 })])).toBe(6.5);
  });

  it("upload status line: saving → saved; a failed part is called out by its number", () => {
    expect(uploadSummary([])).toMatchObject({ label: null, pending: 0 });
    expect(uploadSummary([seg({ index: 0 }), seg({ index: 1, status: "uploading", percent: 45 })])).toMatchObject({ label: "Saving part 2 · 45%", tone: "busy", pending: 1 });
    expect(uploadSummary([seg({ index: 0 }), seg({ index: 3, status: "failed" })])).toMatchObject({ label: "Part 2 didn't save — tap to retry", tone: "bad", failed: 1 });
    expect(uploadSummary([seg({ index: 0 }), seg({ index: 1 })])).toMatchObject({ label: "All 2 parts saved", tone: "ok" });
    expect(uploadSummary([seg({ index: 0 })]).label).toBe("Part 1 saved");
  });

  it("next index continues after the draft's parts (deleted indexes are never reused)", () => {
    expect(nextSegmentIndex([])).toBe(0);
    expect(nextSegmentIndex([seg({ index: 0 }), seg({ index: 2 })])).toBe(3);
  });

  it("parts of a saved draft come back as uploaded remote parts, in order", () => {
    const local = segmentsFromDraft({
      segments: [
        { id: "s1", key: "k1", index: 0, seconds: 4, url: "/api/media/raw/x/1.mp4", scriptStart: 0, scriptEnd: 0.3 },
        { id: "s2", key: "k2", index: 1, seconds: 6, url: "/api/media/raw/x/2.mp4", scriptStart: 0.3, scriptEnd: null },
      ],
    });
    expect(local.map((s) => [s.key, s.status, s.remoteUrl, s.file])).toEqual([
      ["k1", "uploaded", "/api/media/raw/x/1.mp4", null],
      ["k2", "uploaded", "/api/media/raw/x/2.mp4", null],
    ]);
    expect(local[1]!.scriptEnd).toBe(0);
  });

  it("part file names sort in recording order", () => {
    expect(segmentFileName(2, "video/mp4;codecs=avc1", new Date(2026, 9, 17, 14, 5, 9))).toBe("part-03-2026-10-17-140509.mp4");
    expect(segmentFileName(0, "video/webm", new Date(2026, 0, 2, 3, 4, 5))).toMatch(/^part-01-.*\.webm$/);
  });
});

describe("teleprompter position across parts", () => {
  it("resumes at the saved position — unless the script text changed (then from the top)", () => {
    expect(resumeProgress(null, "fp")).toBe(0);
    expect(resumeProgress({ scriptPosition: 0.42, scriptFingerprint: "fp" }, "fp")).toBe(0.42);
    expect(resumeProgress({ scriptPosition: 0.42, scriptFingerprint: "old" }, "fp")).toBe(0);
    expect(resumeProgress({ scriptPosition: 0.42, scriptFingerprint: null }, "fp")).toBe(0.42);
    expect(resumeProgress({ scriptPosition: 7, scriptFingerprint: "fp" }, "fp")).toBe(1);
  });

  it("'Back a line' moves back exactly one line of text, clamped at the top", () => {
    // 1000 px of text, 47 px lines: one line = 0.047.
    expect(rewindProgress(0.5, 1, 47, 1000)).toBeCloseTo(0.453);
    expect(rewindProgress(0.5, 2, 47, 1000)).toBeCloseTo(0.406);
    expect(rewindProgress(0.02, 1, 47, 1000)).toBe(0);
    expect(rewindProgress(0.3, 1, 47, 0)).toBe(0.3);
  });

  it("the 3-2-1 countdown runs only before the first part of a visit", () => {
    expect(wantsCountdown(true, 0)).toBe(true);
    expect(wantsCountdown(true, 1)).toBe(false);
    expect(wantsCountdown(false, 0)).toBe(false);
  });
});

describe("background part upload (retries)", () => {
  const noWait = () => Promise.resolve();

  it("succeeds after a dropped connection — the same key is re-sent (server dedupes)", async () => {
    const keys: string[] = [];
    let calls = 0;
    const updates: Array<Partial<LocalSegment>> = [];
    const s = seg({ key: "part-key", status: "queued" });
    const r = await uploadSegmentWithRetry(
      {
        upload: async (x, onProgress) => {
          keys.push(x.key);
          calls++;
          onProgress(50);
          if (calls === 1) throw new Error("Network error during upload");
        },
        wait: noWait,
      },
      s,
      (p) => updates.push(p),
    );
    expect(r).toBe("uploaded");
    expect(keys).toEqual(["part-key", "part-key"]);
    expect(updates.filter((u) => u.status === "uploading").map((u) => u.attempt)).toEqual([1, 2]);
    expect(updates[updates.length - 1]).toMatchObject({ status: "uploaded", percent: 100 });
  });

  it("gives up after 3 attempts, and at once on a permanent error (closed draft)", async () => {
    let n = 0;
    const flaky = await uploadSegmentWithRetry({ upload: async () => { n++; throw new Error("Network error during upload"); }, wait: noWait }, seg(), () => undefined);
    expect(flaky).toBe("failed");
    expect(n).toBe(3);
    let m = 0;
    const last: Array<Partial<LocalSegment>> = [];
    const closed = await uploadSegmentWithRetry(
      { upload: async () => { m++; throw new Error("This recording was already finished — refused."); }, wait: noWait },
      seg(),
      (p) => last.push(p),
    );
    expect(closed).toBe("failed");
    expect(m).toBe(1);
    expect(last[last.length - 1]).toMatchObject({ status: "failed", error: "This recording was already finished — refused." });
  });
});
