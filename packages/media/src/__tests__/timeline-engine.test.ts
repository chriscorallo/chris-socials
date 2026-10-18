import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import opentype from "opentype.js";
import { FONT_REGISTRY } from "../font-registry";
import { FONT_METRICS } from "../font-metrics";
import { resolveBundledFontsDir } from "../fonts";
import { EditTimelineSchema, GRADE_PRESET_VALUES, type EditTimelineInput } from "../timeline";
import { timelineCaptionChunks } from "../timeline-captions";
import {
  cropGeometry,
  easeInOutCubic,
  findTimelineCollisions,
  layoutCaptionChunk,
  layoutTimelineText,
  normalizeTexts,
  normalizeZooms,
  resolveGrade,
  temperatureGains,
  zoomStateAt,
  zoomWindow,
} from "../timeline-layout";
import {
  assColor,
  buildCaptionsAss,
  chooseOutputFps,
  clipFrameCounts,
  gradeFilters,
  nodeMeasureText,
  zoomFilter,
} from "../timeline-render";
import { planToTimeline, type PlanLike } from "../plan-to-timeline";
import { getSafeArea, rectInsideSafeArea, rectsIntersect } from "../safe-zones";
import {
  PLATFORM_PROFILES,
  checkAgainstProfile,
  combinedSafeZone,
  sizeCapRetryVideoKbps,
  type VariantProbe,
} from "../platform-profiles";
import { parseLoudnormJson, variantEncodeArgs } from "../platform-variant";

const canvas = { width: 1080, height: 1920 };

function tl(input: Partial<EditTimelineInput> = {}) {
  return EditTimelineSchema.parse({
    version: 2,
    clips: [{ id: "c1", mediaAssetId: "A", sourceStart: 0, sourceEnd: 4 }],
    captions: { fontId: "inter-display-bold", fontSize: 64, color: "#FFFFFF", highlightColor: "#FFD84D" },
    ...input,
  });
}

describe("font registry + metrics", () => {
  it("keeps the 3 Inter ids and registers >= 12 fonts, each file present with matching generated metrics", () => {
    const ids = FONT_REGISTRY.map((f) => f.id);
    expect(ids.slice(0, 3)).toEqual(["inter-semibold", "inter-display-bold", "inter-display-extrabold"]);
    expect(ids.length).toBeGreaterThanOrEqual(12);
    expect(new Set(ids).size).toBe(ids.length);
    const dir = resolveBundledFontsDir();
    for (const f of FONT_REGISTRY) {
      const bytes = readFileSync(join(dir, f.file));
      const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const os2 = font.tables.os2 as unknown as { usWinAscent: number; usWinDescent: number; sCapHeight: number };
      const m = FONT_METRICS[f.id]!;
      expect(m, f.id).toBeTruthy();
      expect(m.unitsPerEm).toBe(font.unitsPerEm);
      expect(m.winAscent).toBe(os2.usWinAscent);
      expect(m.winDescent).toBe(os2.usWinDescent);
      expect(m.capHeight).toBe(os2.sCapHeight);
      expect(m.fullName).toBe(font.names.fullName!.en);
      // Every font covers the basics captions/texts need.
      for (const ch of "AZaz09%$€é!?") expect(font.charToGlyphIndex(ch), `${f.id} ${ch}`).toBeGreaterThan(0);
    }
  });
});

describe("crop math", () => {
  it("zoom 1 / pan 0 is the centred cover crop", () => {
    const g = cropGeometry({ width: 1920, height: 1080 }, canvas, { zoom: 1, panX: 0, panY: 0 });
    expect(g.scale).toBeCloseTo(1920 / 1080, 6);
    expect(g.scaledHeight).toBeCloseTo(1920, 6);
    expect(g.offsetX).toBeCloseTo((g.scaledWidth - 1080) / 2, 6);
    expect(g.offsetY).toBeCloseTo(0, 6);
  });
  it("pan -1 / +1 slide the window to the edges; zoom adds overflow on both axes", () => {
    const left = cropGeometry({ width: 1920, height: 1080 }, canvas, { zoom: 1, panX: -1, panY: 0 });
    const right = cropGeometry({ width: 1920, height: 1080 }, canvas, { zoom: 1, panX: 1, panY: 0 });
    expect(left.offsetX).toBe(0);
    expect(right.offsetX).toBeCloseTo(right.scaledWidth - 1080, 6);
    const z = cropGeometry({ width: 1080, height: 1920 }, canvas, { zoom: 2, panX: 0, panY: -1 });
    expect(z.scaledWidth).toBeCloseTo(2160, 6);
    expect(z.offsetX).toBeCloseTo(540, 6);
    expect(z.offsetY).toBe(0);
  });
});

describe("zoom curve", () => {
  it("CUT is instant, EASE ramps with easeInOutCubic then holds, both cut back at end", () => {
    const { zooms, warnings } = normalizeZooms(
      [
        { id: "e", start: 3, end: 5, zoom: 1.5, x: 0.3, y: 0.3, mode: "EASE", easeSeconds: 1 },
        { id: "c", start: 1, end: 2, zoom: 1.2, x: 0.5, y: 0.5, mode: "CUT", easeSeconds: 0.4 },
        { id: "late", start: 9, end: 12, zoom: 1.2, x: 0.5, y: 0.5, mode: "CUT", easeSeconds: 0.4 },
      ],
      8,
    );
    expect(zooms.map((z) => z.id)).toEqual(["c", "e"]);
    expect(warnings[0]).toMatch(/late/);
    expect(zoomStateAt(zooms, 0.99).zoom).toBe(1);
    expect(zoomStateAt(zooms, 1).zoom).toBe(1.2);
    expect(zoomStateAt(zooms, 2).zoom).toBe(1);
    expect(zoomStateAt(zooms, 3).zoom).toBe(1);
    expect(zoomStateAt(zooms, 3.5).zoom).toBeCloseTo(1.25, 6);
    expect(zoomStateAt(zooms, 4.2).zoom).toBe(1.5);
    expect(easeInOutCubic(0.25)).toBeCloseTo(0.0625, 6);
    const w = zoomWindow({ zoom: 2, x: 0.25, y: 0.5 }, canvas);
    expect(w).toEqual({ x: 135, y: 480, width: 540, height: 960 });
  });
  it("the ffmpeg perspective expression is built for every zoom", () => {
    const f = zoomFilter([{ id: "a", start: 1, end: 2, zoom: 1.2, x: 0.5, y: 0.33, mode: "EASE", easeSeconds: 0.5 }], canvas, 30)!;
    expect(f).toMatch(/^perspective=/);
    expect(f).toContain("eval=frame");
    expect(f).toContain("((in-1)/30)");
  });
});

describe("grade", () => {
  it("uses preset values, and explicit non-neutral fields override them", () => {
    expect(resolveGrade({ preset: "WARM", brightness: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0 })).toEqual(
      GRADE_PRESET_VALUES.WARM,
    );
    const mixed = resolveGrade({ preset: "WARM", brightness: 0, contrast: 1.4, saturation: 1, temperature: -0.5, vignette: 0 });
    expect(mixed).toEqual({ ...GRADE_PRESET_VALUES.WARM, contrast: 1.4, temperature: -0.5 });
    expect(gradeFilters({ preset: "NONE", brightness: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0 })).toEqual([]);
    const bw = gradeFilters({ preset: "BW", brightness: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0 });
    expect(bw[0]).toBe("eq=brightness=0:contrast=1.15:saturation=0");
    expect(bw[1]).toMatch(/^vignette=angle=0\.26/);
    expect(temperatureGains(1)).toEqual({ r: 1.1, g: 1, b: 0.88 });
    expect(gradeFilters({ preset: "NONE", brightness: 0, contrast: 1, saturation: 1, temperature: 0.5, vignette: 0 })).toEqual([
      "colorchannelmixer=rr=1.05:gg=1:bb=0.94",
    ]);
  });
});

describe("caption timing across clips from two takes", () => {
  it("maps each clip's take words onto the output timeline, applies wordEdits, and chunks", () => {
    const timeline = tl({
      clips: [
        { id: "c1", mediaAssetId: "take1", sourceStart: 10, sourceEnd: 12 },
        { id: "c2", mediaAssetId: "take2", sourceStart: 3, sourceEnd: 5 },
      ],
      captions: {
        fontId: "inter-display-bold",
        fontSize: 64,
        color: "#FFFFFF",
        highlightColor: "#FFD84D",
        wordEdits: { "take2:1": "", "take1:0": "Money" },
      },
    });
    const chunks = timelineCaptionChunks(timeline, {
      take1: [
        { word: "money", start: 10.2, end: 10.6 },
        { word: "talks.", start: 10.6, end: 11.0 },
        { word: "cut", start: 12.5, end: 12.9 }, // outside clip 1
      ],
      take2: [
        { word: "Second", start: 3.1, end: 3.5 },
        { word: "um", start: 3.5, end: 3.7 }, // hidden by wordEdits
        { word: "take.", start: 3.7, end: 4.2 },
      ],
    });
    const words = chunks.flatMap((c) => c.words);
    expect(words.map((w) => w.word)).toEqual(["Money", "talks.", "Second", "take."]);
    expect(words[0]).toMatchObject({ start: 0.2, end: 0.6, key: "take1:0" });
    // take2 starts at output 2.0: 3.1 - 3 + 2 = 2.1
    expect(words[2]).toMatchObject({ start: 2.1, end: 2.5, key: "take2:0" });
    expect(words[3]!.start).toBeCloseTo(2.7, 6);
    expect(chunks.map((c) => c.text)).toEqual(["Money talks.", "Second take."]);
  });

  it("frame-aligned clip lengths never drift more than half a frame", () => {
    const timeline = tl({
      clips: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, mediaAssetId: "A", sourceStart: i, sourceEnd: i + 0.517 })),
    });
    const frames = clipFrameCounts(timeline, 30);
    let acc = 0;
    let exact = 0;
    for (let i = 0; i < frames.length; i++) {
      acc += frames[i]!;
      exact += 0.517;
      expect(Math.abs(acc / 30 - exact)).toBeLessThanOrEqual(0.5 / 30 + 1e-9);
    }
    expect(chooseOutputFps([30, 25])).toBe(30);
    expect(chooseOutputFps([59.94, 60])).toBe(60);
  });
});

describe("text + caption layout", () => {
  it("centres the block at (x,y), wraps inside maxWidth, aligns lines, clamps to the canvas", () => {
    const text = {
      text: "The three rules nobody tells you about money",
      fontId: "montserrat-black",
      fontSize: 72,
      backgroundColor: "#000000A0",
      strokeColor: null,
      align: "center" as const,
      x: 0.5,
      y: 0.3,
      maxWidth: 0.7,
      uppercase: true,
    };
    const l = layoutTimelineText(text, canvas, nodeMeasureText);
    expect(l.lines.length).toBeGreaterThan(1);
    for (const line of l.lines) {
      expect(line.text).toBe(line.text.toUpperCase());
      expect(line.width).toBeLessThanOrEqual(0.7 * 1080);
      expect(Math.abs(line.x + line.width / 2 - 540)).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(l.rect.y + l.rect.height / 2 - 0.3 * 1920)).toBeLessThanOrEqual(1);
    expect(l.plate?.radius).toBeGreaterThan(0);
    const left = layoutTimelineText({ ...text, align: "left", x: 0, y: 1 }, canvas, nodeMeasureText);
    expect(left.rect.x).toBe(0);
    expect(left.rect.y + left.rect.height).toBe(1920);
    expect(new Set(left.lines.map((ln) => ln.x)).size).toBe(1);
    // Explicit newlines are hard breaks.
    expect(layoutTimelineText({ ...text, text: "one\ntwo" }, canvas, nodeMeasureText).lines.map((x) => x.text)).toEqual(["ONE", "TWO"]);
  });

  it("caption chunk words carry x positions inside their line; BOXED gets a plate", () => {
    const chunk = { words: [{ word: "Save", start: 0, end: 0.3, key: "a:0" }, { word: "50%", start: 0.3, end: 0.6, key: "a:1" }] };
    const caps = { preset: "BOXED" as const, fontId: "poppins-extrabold", fontSize: 70, strokeColor: null, backgroundColor: null, y: 0.7 };
    const l = layoutCaptionChunk(chunk, caps, canvas, nodeMeasureText);
    expect(l.lines).toHaveLength(1);
    expect(l.lines[0]!.words.map((w) => w.text)).toEqual(["Save", "50%"]);
    expect(l.lines[0]!.words[1]!.x).toBeGreaterThan(l.lines[0]!.words[0]!.x + l.lines[0]!.words[0]!.width);
    expect(l.plate?.color).toBe("#000000B3");
    expect(Math.abs(l.rect.y + l.rect.height / 2 - 0.7 * 1920)).toBeLessThanOrEqual(1);
  });

  it("ASS output sanitises text, uses the font's full name, and never carries a stray override", () => {
    const timeline = tl({
      captions: { preset: "KARAOKE", fontId: "anton", fontSize: 80, color: "#FFFFFF", highlightColor: "#00FF00" },
    });
    const chunks = [
      { words: [{ word: "{evil}", start: 0, end: 0.4, key: "A:0" }, { word: "\\N50%", start: 0.5, end: 0.9, key: "A:1" }], text: "", start: 0, end: 1 },
    ];
    const ass = buildCaptionsAss(timeline, chunks.map((c) => ({ chunk: c, layout: layoutCaptionChunk(c, timeline.captions, canvas, nodeMeasureText) })))!;
    expect(ass).toContain("\\fnAnton Regular");
    expect(ass).toContain("Kerning: no");
    expect(ass).toContain("(evil)");
    expect(ass).toContain("/N50%");
    expect(ass).toMatch(/\{\\kf50\}\(evil\) \{\\kf40\}\/N50%/);
    expect(assColor("#11223380")).toEqual({ c: "&H332211&", a: "&H7F&" });
  });

  it("finds text/text and caption/text collisions; normalizeTexts clamps with a warning", () => {
    const timeline = tl({
      texts: [
        { id: "a", text: "Headline", start: 0, end: 3, fontId: "anton", fontSize: 120, color: "#FFFFFF", y: 0.72 },
        { id: "b", text: "Other", start: 2, end: 9, fontId: "anton", fontSize: 120, color: "#FFFFFF", y: 0.73 },
      ],
    });
    const chunks = timelineCaptionChunks(timeline, { A: [{ word: "hello", start: 0.5, end: 1 }, { word: "there", start: 1, end: 1.4 }] });
    const c = findTimelineCollisions(timeline, chunks, nodeMeasureText);
    expect(c.some((x) => x.kind === "TEXT_TEXT" && x.overlapStartSeconds === 2 && x.overlapEndSeconds === 3)).toBe(true);
    expect(c.some((x) => x.kind === "CAPTION_TEXT" && x.b === "Headline")).toBe(true);
    const n = normalizeTexts(timeline.texts, 4);
    expect(n.texts[1]!.end).toBe(4);
    expect(n.warnings[0]).toMatch(/clamped/);
  });
});

describe("planToTimeline", () => {
  const plan: PlanLike = {
    segments: [{ startSeconds: 1, endSeconds: 4 }, { startSeconds: 6, endSeconds: 8 }],
    targetDimensions: { width: 1080, height: 1920 },
    textOverlays: [
      { text: "The hook headline that wraps onto two lines", startSeconds: 0, endSeconds: 2, position: "TOP", style: "HEADLINE" },
      { text: "73%", startSeconds: 2, endSeconds: 4, position: "CENTER", style: "NUMBER_CALLOUT" },
      { text: "Chris — creator", startSeconds: 0, endSeconds: 3, position: "BOTTOM", style: "LOWER_THIRD" },
    ],
    captions: { enabled: true, style: "BOLD_HIGHLIGHT", position: "LOWER" },
    punchIns: [{ startSeconds: 1, endSeconds: 2, zoom: 1.2, focus: "UPPER_THIRD" }],
    normalizeAudio: true,
  };

  it("converts segments, presets, captions and punch-ins into an explicit, valid timeline", () => {
    const t = planToTimeline(plan, { mediaAssetId: "take-1", sourceWordsAvailable: true });
    expect(EditTimelineSchema.safeParse(t).success).toBe(true);
    expect(t.clips.map((c) => [c.mediaAssetId, c.sourceStart, c.sourceEnd])).toEqual([["take-1", 1, 4], ["take-1", 6, 8]]);
    const [h, n, lt] = t.texts;
    expect(h).toMatchObject({ preset: "HEADLINE", fontId: "inter-display-bold", color: "#FFFFFF", backgroundColor: "#00000094", start: 0, end: 2 });
    expect(n).toMatchObject({ preset: "NUMBER_CALLOUT", fontId: "inter-display-extrabold", fontSize: 170, color: "#FFD84D", backgroundColor: null });
    expect(lt).toMatchObject({ preset: "LOWER_THIRD", align: "left" });
    const safe = getSafeArea(1080, 1920);
    for (const text of t.texts) expect(rectInsideSafeArea(layoutTimelineText(text, canvas, nodeMeasureText).rect, safe)).toBe(true);
    // TOP sits 40px under the safe top.
    expect(layoutTimelineText(h!, canvas, nodeMeasureText).rect.y).toBe(safe.top + 40);
    expect(layoutTimelineText(lt!, canvas, nodeMeasureText).rect.x).toBe(safe.left);
    expect(t.captions).toMatchObject({ enabled: true, preset: "BOLD_HIGHLIGHT", fontId: "inter-display-extrabold", fontSize: 64, highlightColor: "#FFD84D" });
    // The LOWER_THIRD sits in the lower caption band, so captions moved out of its way.
    const capRect = { x: 0, y: t.captions.y * 1920 - 50, width: 1080, height: 100 };
    expect(rectsIntersect(capRect, layoutTimelineText(lt!, canvas, nodeMeasureText).rect)).toBe(false);
    expect(t.zooms).toEqual([{ id: "zoom-1", start: 1, end: 2, zoom: 1.2, x: 0.5, y: 0.33, mode: "CUT", easeSeconds: 0.4 }]);
    expect(t.grade.preset).toBe("NONE");
    expect(t.audio.normalize).toBe(true);
  });

  it("disables captions when the take has no word timings, and keeps the default LOWER band when free", () => {
    const t = planToTimeline({ ...plan, textOverlays: [], captions: null }, { mediaAssetId: "x", sourceWordsAvailable: false });
    expect(t.captions.enabled).toBe(false);
    expect(t.captions.preset).toBe("CLEAN");
    const on = planToTimeline({ ...plan, textOverlays: [], captions: null }, { mediaAssetId: "x", sourceWordsAvailable: true });
    expect(on.captions.y).toBeGreaterThan(0.72);
    expect(on.captions.y).toBeLessThan(0.76);
  });
});

describe("platform profiles", () => {
  const good: VariantProbe = {
    width: 1080, height: 1920, fps: 30, durationSeconds: 20, fileSizeBytes: 20e6, videoCodec: "h264", pixelFormat: "yuv420p",
    audioCodec: "aac", audioSampleRate: 48000, audioChannels: 2, faststart: true,
  };
  it("checkAgainstProfile passes a compliant file and flags each violation", () => {
    for (const p of Object.values(PLATFORM_PROFILES)) expect(checkAgainstProfile(good, p)).toEqual([]);
    const bad = { ...good, fps: 120, durationSeconds: 200, fileSizeBytes: 400 * 1024 * 1024, faststart: false, audioSampleRate: 44100 };
    const ig = checkAgainstProfile(bad, PLATFORM_PROFILES.INSTAGRAM).map((i) => i.code);
    expect(ig).toEqual(expect.arrayContaining(["FPS", "FILE_TOO_LARGE", "NOT_FASTSTART", "AUDIO_SAMPLE_RATE"]));
    expect(checkAgainstProfile(bad, PLATFORM_PROFILES.YOUTUBE).map((i) => i.code)).toContain("DURATION_LONG");
  });
  it("safe zones differ per app and the union is the max of each edge", () => {
    expect(PLATFORM_PROFILES.YOUTUBE.safeZone).not.toEqual(PLATFORM_PROFILES.TIKTOK.safeZone);
    // Derived from the conservative (official ads) regions in platform-ui.ts.
    expect(combinedSafeZone()).toEqual({ top: 288, bottom: 672, left: 60, right: 300 });
  });
  it("size-cap retry targets ~92% of the cap and refuses below 300 kbps video", () => {
    const kbps = sizeCapRetryVideoKbps({ maxFileSizeBytes: 300 * 1024 * 1024, durationSeconds: 600, audioKbps: 128 })!;
    expect(kbps).toBeGreaterThan(3000);
    expect(((kbps + 128) * 1000 * 600) / 8).toBeLessThan(300 * 1024 * 1024);
    expect(sizeCapRetryVideoKbps({ maxFileSizeBytes: 1_000_000, durationSeconds: 60, audioKbps: 128 })).toBeNull();
  });
  it("variant args: closed GOP, level 4.2, BT.709, faststart, two-pass linear loudnorm", () => {
    const args = variantEncodeArgs({
      masterPath: "/m.mp4", outputPath: "/o.mp4", profile: PLATFORM_PROFILES.YOUTUBE, fps: 30, preset: "slow", hasAudio: true,
      loudness: { integratedLufs: -20, truePeakDbtp: -3, lra: 5, threshold: -30, targetOffset: 0.1 },
    }).join(" ");
    expect(args).toContain("-g 15 -keyint_min 15 -sc_threshold 0 -flags +cgop -bf 2");
    expect(args).toContain("-level:v 4.2");
    expect(args).toContain("-b:a 384k");
    expect(args).toContain("measured_I=-20");
    expect(args).toContain("linear=true");
    expect(args).toContain("-movflags +faststart");
    expect(parseLoudnormJson('x {\n"input_i" : "-23.1",\n"input_tp" : "-4.0",\n"input_lra" : "3.2",\n"input_thresh" : "-33.5",\n"target_offset" : "0.2"\n}')).toEqual({
      integratedLufs: -23.1, truePeakDbtp: -4, lra: 3.2, threshold: -33.5, targetOffset: 0.2,
    });
  });
});
