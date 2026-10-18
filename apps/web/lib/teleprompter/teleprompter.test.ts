import { describe, expect, it, vi } from "vitest";
import { cleanPrompterText, pickPrompterSource, resolveSavedEdit, splitPlanDescription, textFingerprint, titleForNewVideo } from "./script-source";
import {
  advanceProgress,
  estimateSeconds,
  formatDuration,
  progressAfterDrag,
  progressPerSecond,
  scrollOffset,
  speedToWpm,
  wordCount,
  wrapLines,
} from "./scroll";
import {
  MIME_CANDIDATES,
  VIDEO_ONLY_MIME_CANDIDATES,
  baseMime,
  cameraConstraints,
  extensionForMime,
  pickRecorderMime,
  settingsLabel,
  supportsQuality,
  takeFileName,
  videoBitrateFor,
} from "./recording";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings";
import { deliverTakes, isPermanentUploadError, type HandoffDeps } from "./handoff";

// Teleprompter (docs/decisions-pending/teleprompter.md): script source, scroll timing,
// recorder choices, settings, and the take → video handoff.

describe("teleprompter script source", () => {
  const script = { spokenScript: "Your 401(k) match is free money.\n\n\nTake it.", authorType: "AGENT" };

  it("prefers the latest script version", () => {
    const s = pickPrompterSource({
      scriptVersions: [script, { spokenScript: "old", authorType: "AGENT" }],
      creatorCard: { hook: "Hook", talkingPoints: ["a"] },
      description: "Hook: plan hook",
    });
    expect(s.kind).toBe("script");
    expect(s.text).toBe("Your 401(k) match is free money.\n\nTake it.");
    expect(s.label).toBe("Your script (v2)");
  });

  it("labels Chris's own edit", () => {
    expect(pickPrompterSource({ scriptVersions: [{ spokenScript: "x", authorType: "HUMAN" }] }).label).toBe("Your script (your edit)");
    expect(pickPrompterSource({ scriptVersions: [{ spokenScript: "x", authorType: "HUMAN" }], scriptVersionCount: 3 }).label).toBe("Your script (v3, your edit)");
    expect(pickPrompterSource({ scriptVersions: [{ spokenScript: "x", authorType: "IMPORTED" }] }).label).toBe("Your script (from ChatGPT)");
    expect(pickPrompterSource({ scriptVersions: [{ spokenScript: "x", authorType: "AGENT" }] }).label).toBe("Your script");
  });

  it("skips an empty script, then uses the Creator Card (hook + talking points + notes)", () => {
    const s = pickPrompterSource({
      scriptVersions: [{ spokenScript: "   " }],
      creatorCard: { hook: "Stop paying fees", talkingPoints: ["Index funds", "", 3, "Expense ratios"], notes: "Smile" },
      description: "Hook: plan",
    });
    expect(s.kind).toBe("card");
    expect(s.text).toBe("Stop paying fees\n\n• Index funds\n\n• Expense ratios\n\nSmile");
  });

  it("falls back to the imported plan's hook + notes", () => {
    const s = pickPrompterSource({ description: "Hook: Your parents lied\n\nMyth 1\nMyth 2" });
    expect(s).toMatchObject({ kind: "plan", text: "Your parents lied\n\nMyth 1\nMyth 2" });
    expect(pickPrompterSource({ description: "Just some notes" }).text).toBe("Just some notes");
  });

  it("offers the paste box when there is nothing", () => {
    expect(pickPrompterSource({})).toMatchObject({ kind: "none", text: "" });
    expect(pickPrompterSource({ description: "  ", creatorCard: { hook: " ", talkingPoints: [] } }).kind).toBe("none");
  });

  it("splits plan descriptions like the plan board", () => {
    expect(splitPlanDescription("Hook: A\n\nB")).toEqual({ hook: "A", notes: "B" });
    expect(splitPlanDescription("Hook: A")).toEqual({ hook: "A", notes: null });
    expect(splitPlanDescription(null)).toEqual({ hook: null, notes: null });
  });

  it("cleans whitespace but keeps paragraphs", () => {
    expect(cleanPrompterText("  a   b \r\n\r\n\r\n c\t d ")).toBe("a b\n\nc d");
  });

  it("keeps a local edit only while the source script is unchanged", () => {
    const src = pickPrompterSource({ description: "Hook: original" });
    const saved = { base: textFingerprint(src.text), text: "tweaked" };
    expect(resolveSavedEdit(src, saved)).toEqual({ text: "tweaked", edited: true });
    const newer = pickPrompterSource({ scriptVersions: [{ spokenScript: "a brand new script" }] });
    expect(resolveSavedEdit(newer, saved)).toEqual({ text: "a brand new script", edited: false });
    expect(resolveSavedEdit(src, null)).toEqual({ text: "original", edited: false });
    expect(textFingerprint("abc")).not.toBe(textFingerprint("abd"));
  });

  it("titles a new video from the typed title or the first words", () => {
    expect(titleForNewVideo(" My title ", "x")).toBe("My title");
    expect(titleForNewVideo("", "Why your 401(k) match is free money and you should take it")).toBe("Why your 401(k) match is free money and…");
    expect(titleForNewVideo("", "Short one.")).toBe("Short one");
    expect(titleForNewVideo("", "")).toBe("New video");
  });
});

describe("teleprompter scroll timing", () => {
  it("maps speed levels to words per minute, clamped", () => {
    expect(speedToWpm(1)).toBe(90);
    expect(speedToWpm(5)).toBe(150);
    expect(speedToWpm(10)).toBe(225);
    expect(speedToWpm(0)).toBe(90);
    expect(speedToWpm(99)).toBe(225);
  });

  it("counts words, ignoring bullets and punctuation", () => {
    expect(wordCount("• One, two —  three!\n\nfour")).toBe(4);
    expect(wordCount("   ")).toBe(0);
  });

  it("reads 150 words in 60 s at speed 5", () => {
    const words = 150;
    const rate = progressPerSecond(words, speedToWpm(5));
    expect(estimateSeconds(words, 150)).toBe(60);
    // simulate 60 s of 16 ms frames
    let p = 0;
    for (let t = 0; t < 60_000; t += 16) p = advanceProgress(p, 16, rate);
    expect(p).toBeGreaterThan(0.99);
    expect(p).toBeLessThanOrEqual(1);
  });

  it("caps big frame gaps and clamps to [0, 1]", () => {
    const rate = progressPerSecond(10, 60); // 0.1 / s
    expect(advanceProgress(0, 5_000, rate)).toBeCloseTo(0.025); // capped at 250 ms
    expect(advanceProgress(0.999, 250, 10)).toBe(1);
    expect(advanceProgress(0.5, -100, rate)).toBe(0.5);
    expect(progressPerSecond(0, 150)).toBe(0);
  });

  it("puts the text top on the reading line at 0 and the bottom at 1", () => {
    expect(scrollOffset(0, 1000, 120)).toBe(120);
    expect(scrollOffset(1, 1000, 120)).toBe(-880);
    expect(scrollOffset(0.5, 1000, 120)).toBe(-380);
    expect(scrollOffset(2, 1000, 120)).toBe(-880);
  });

  it("drag-to-scrub moves against the finger", () => {
    expect(progressAfterDrag(0.5, -100, 1000)).toBeCloseTo(0.6); // finger up → forward
    expect(progressAfterDrag(0.05, 500, 1000)).toBe(0);
    expect(progressAfterDrag(0.5, 10, 0)).toBe(0.5);
  });

  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65.4)).toBe("1:05");
  });

  it("wraps words for the floating window, keeping paragraph breaks", () => {
    const measure = (s: string) => s.length * 10; // 10 px per char
    expect(wrapLines("one two three four\n\nfive", 100, measure)).toEqual(["one two", "three four", "", "five"]);
    expect(wrapLines("supercalifragilistic x", 100, measure)).toEqual(["supercalifragilistic", "x"]);
    expect(wrapLines("", 100, measure)).toEqual([]);
  });
});

describe("teleprompter recording choices", () => {
  it("prefers MP4/H.264 (iPhone Safari) when supported", () => {
    const safari = (t: string) => t.startsWith("video/mp4");
    expect(pickRecorderMime(safari)).toBe("video/mp4;codecs=avc1.640028,mp4a.40.2");
  });

  it("falls back to WebM on browsers without MP4 recording", () => {
    const oldChrome = (t: string) => t.startsWith("video/webm");
    expect(pickRecorderMime(oldChrome)).toBe("video/webm;codecs=vp9,opus");
    expect(pickRecorderMime((t) => t === "video/webm")).toBe("video/webm");
  });

  it("returns '' (browser default) when nothing matches or the check throws", () => {
    expect(pickRecorderMime(() => false)).toBe("");
    expect(
      pickRecorderMime((t) => {
        if (t.includes("640028")) throw new Error("bad codec string");
        return t === "video/mp4";
      }),
    ).toBe("video/mp4");
  });

  it("uses video-only candidates for the pre-rendered script video", () => {
    expect(pickRecorderMime((t) => t === "video/mp4;codecs=avc1" || t === "video/webm", VIDEO_ONLY_MIME_CANDIDATES)).toBe("video/mp4;codecs=avc1");
    expect(MIME_CANDIDATES[0]).toContain("mp4");
  });

  it("maps mime → extension and base type", () => {
    expect(extensionForMime("video/mp4;codecs=avc1")).toBe("mp4");
    expect(extensionForMime("video/webm;codecs=vp9,opus")).toBe("webm");
    expect(extensionForMime("video/quicktime")).toBe("mov");
    expect(baseMime("video/webm;codecs=vp9,opus")).toBe("video/webm");
    expect(baseMime("")).toBe("video/mp4");
  });

  it("picks a generous bitrate by resolution and frame rate (portrait or landscape)", () => {
    expect(videoBitrateFor(1080, 1920, 30)).toBe(10_000_000);
    expect(videoBitrateFor(1920, 1080, 60)).toBe(15_000_000);
    expect(videoBitrateFor(2160, 3840, 30)).toBe(35_000_000);
    expect(videoBitrateFor(720, 1280, 30)).toBe(6_000_000);
    expect(videoBitrateFor(480, 640, 30)).toBe(3_000_000);
    expect(videoBitrateFor(0, 0, 30)).toBe(10_000_000);
  });

  it("builds camera constraints with natural voice by default", () => {
    const c = cameraConstraints({ facing: "user", quality: "1080", fps: 30, voiceCleanup: false });
    expect(c.video).toMatchObject({ facingMode: { ideal: "user" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } });
    expect(c.audio).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    const k = cameraConstraints({ facing: "environment", quality: "4k", fps: 60, voiceCleanup: true });
    expect(k.video).toMatchObject({ width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 60 } });
    expect(k.audio).toMatchObject({ echoCancellation: true });
  });

  it("labels what the camera actually delivers", () => {
    expect(settingsLabel({ width: 1080, height: 1920, frameRate: 30 })).toBe("1080p · 30fps");
    expect(settingsLabel({ width: 3840, height: 2160, frameRate: 29.97 })).toBe("4K · 30fps");
    expect(settingsLabel({ width: 640, height: 480 })).toBe("480p");
    expect(settingsLabel({})).toBe("");
  });

  it("detects 4K / 60 fps from capabilities (absent on older Safari)", () => {
    expect(supportsQuality({ width: { max: 4032 }, height: { max: 3024 }, frameRate: { max: 60 } })).toEqual({ fourK: true, sixty: true });
    expect(supportsQuality({ width: { max: 1920 }, frameRate: { max: 30 } })).toEqual({ fourK: false, sixty: false });
    expect(supportsQuality(null)).toEqual({ fourK: false, sixty: false });
  });

  it("names takes with an extension that matches the container", () => {
    const at = new Date(2026, 9, 17, 14, 5);
    expect(takeFileName(2, "video/mp4;codecs=avc1", at)).toBe("teleprompter-take-2-2026-10-17_14-05.mp4");
    expect(takeFileName(1, "video/webm", at)).toMatch(/\.webm$/);
  });
});

describe("teleprompter settings", () => {
  it("drops anything out of range and keeps valid values", () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    const s = sanitizeSettings({ fontIndex: 99, speed: 7, mirrorText: true, facing: "sideways", fps: 60, quality: "8k", pipDelaySec: 5, pipFontIndex: -1 });
    expect(s).toMatchObject({ fontIndex: DEFAULT_SETTINGS.fontIndex, speed: 7, mirrorText: true, facing: "user", fps: 60, quality: "1080", pipDelaySec: 5, pipFontIndex: DEFAULT_SETTINGS.pipFontIndex });
    expect(DEFAULT_SETTINGS).toMatchObject({ voiceCleanup: false, scrollOnlyWhileRecording: true, countdown: true, facing: "user" });
  });
});

describe("teleprompter take handoff", () => {
  const file = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: "video/mp4" });
  function deps(over: Partial<HandoffDeps> = {}) {
    const calls: string[] = [];
    const d: HandoffDeps = {
      prepareExisting: vi.fn(async (id: string) => {
        calls.push(`prepare:${id}`);
        return { ok: true as const };
      }),
      createNew: vi.fn(async (title: string) => {
        calls.push(`create:${title}`);
        return { id: "new1" };
      }),
      upload: vi.fn(async (id: string, f: File, onProgress) => {
        calls.push(`upload:${id}:${f.name}`);
        onProgress(50, "uploading");
        onProgress(100, "processing");
      }),
      wait: vi.fn(async () => undefined),
      ...over,
    };
    return { d, calls };
  }

  it("walks an existing (planned) video to FILMED first, then uploads every take in order", async () => {
    const { d, calls } = deps();
    const progress: string[] = [];
    const r = await deliverTakes(d, { kind: "existing", contentItemId: "v1" }, [file("a.mp4"), file("b.mp4")], (p) => progress.push(`${p.index}:${p.phase}`));
    expect(r).toEqual({ ok: true, contentItemId: "v1", uploaded: 2 });
    expect(calls).toEqual(["prepare:v1", "upload:v1:a.mp4", "upload:v1:b.mp4"]);
    expect(d.createNew).not.toHaveBeenCalled();
    expect(progress[0]).toBe("0:preparing");
    expect(progress).toContain("1:processing");
  });

  it("creates a footage-first video for a new one", async () => {
    const { d, calls } = deps();
    const r = await deliverTakes(d, { kind: "new", title: "Fees" }, [file("a.mp4")], () => undefined);
    expect(r).toMatchObject({ ok: true, contentItemId: "new1" });
    expect(calls).toEqual(["create:Fees", "upload:new1:a.mp4"]);
  });

  it("stops before uploading if the video can't take footage", async () => {
    const { d } = deps({ prepareExisting: async () => ({ error: "This video was cancelled" }) });
    const r = await deliverTakes(d, { kind: "existing", contentItemId: "v1" }, [file("a.mp4")], () => undefined);
    expect(r).toMatchObject({ ok: false, contentItemId: null, uploaded: 0, error: "This video was cancelled", failedIndexes: [0] });
    expect(d.upload).not.toHaveBeenCalled();
  });

  it("retries a dropped connection and succeeds", async () => {
    let n = 0;
    const { d } = deps({
      upload: async () => {
        if (++n < 3) throw new Error("Network error during upload");
      },
    });
    const phases: string[] = [];
    const r = await deliverTakes(d, { kind: "existing", contentItemId: "v1" }, [file("a.mp4")], (p) => phases.push(p.phase));
    expect(r).toMatchObject({ ok: true, uploaded: 1 });
    expect(n).toBe(3);
    expect(d.wait).toHaveBeenCalledTimes(2);
    expect(phases.filter((p) => p === "retrying")).toHaveLength(2);
  });

  it("doesn't retry permanent errors; reports only the failed takes, keeps the rest", async () => {
    const { d } = deps({
      upload: async (_id, f) => {
        if (f.name === "b.mp4") throw new Error("Upload failed (413)");
      },
    });
    const r = await deliverTakes(d, { kind: "existing", contentItemId: "v1" }, [file("a.mp4"), file("b.mp4")], () => undefined);
    expect(r).toMatchObject({ ok: false, contentItemId: "v1", uploaded: 1, failedIndexes: [1] });
    expect(d.wait).not.toHaveBeenCalled();
    expect(isPermanentUploadError("Network error during upload")).toBe(false);
    expect(isPermanentUploadError("File type not allowed")).toBe(true);
  });

  it("a retry after a partial failure reuses the video instead of creating another", async () => {
    const { d, calls } = deps();
    const r = await deliverTakes(d, { kind: "new", title: "Fees" }, [file("b.mp4")], () => undefined, "new1");
    expect(r).toMatchObject({ ok: true, contentItemId: "new1" });
    expect(calls).toEqual(["upload:new1:b.mp4"]);
  });
});
