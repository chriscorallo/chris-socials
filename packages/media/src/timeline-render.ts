import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeAssText, type TranscriptWord } from "./captions";
import { FFMPEG_PATH } from "./ffmpeg-paths";
import { findFont } from "./font-registry";
import { resolveBundledFontsDir } from "./fonts";
import { probeMedia, type ProbeResult } from "./probe";
import type { Rect } from "./safe-zones";
import { escapeFilterPathValue, RenderSegmentOutOfBoundsError } from "./render";
import { measureTextWidth } from "./text-layout";
import { clipDuration, EditTimelineSchema, timelineDuration, type EditTimeline, type EditTimelineInput } from "./timeline";
import { timelineCaptionChunks, type TimelineCaptionChunk } from "./timeline-captions";
import {
  fontMetricsFor,
  isNeutralGrade,
  layoutCaptionChunk,
  layoutTimelineText,
  normalizeTexts,
  normalizeZooms,
  parseHexColor,
  resolveGrade,
  temperatureGains,
  vignetteAngle,
  type TimelineCaptionLayout,
  type MeasureText,
  type TextElementLayout,
} from "./timeline-layout";

/**
 * Timeline renderer: renders an EditTimeline (v2) exactly — the same pure layout/zoom/grade
 * functions the browser preview uses (timeline-layout.ts), executed with ffmpeg. See
 * docs/decisions-pending/timeline-engine.md for the decisions and the preview parity notes.
 */

/** Absolute path of a registered font's TTF. Throws for unknown ids / missing files. */
export function registeredFontPath(fontId: string, fontsDir = resolveBundledFontsDir()): string {
  const font = findFont(fontId);
  if (!font) throw new Error(`Unknown fontId "${fontId}" — not in FONT_REGISTRY.`);
  const path = join(fontsDir, font.file);
  if (!existsSync(path)) throw new Error(`Font file for "${fontId}" not found at ${path}.`);
  return path;
}

/** Server-side MeasureText: opentype.js advances from the registered TTF, no kerning. */
export const nodeMeasureText: MeasureText = (text, fontId, fontPx) =>
  measureTextWidth(text, registeredFontPath(fontId), fontPx);

export interface RenderTimelineInput {
  timeline: EditTimeline | EditTimelineInput;
  /** mediaAssetId -> local file path, for every asset the clips reference. */
  sources: Record<string, string>;
  /** mediaAssetId -> that take's transcript words (source timeline), or null. */
  sourceWords: Record<string, TranscriptWord[] | null | undefined>;
  outputPath: string;
  fontsDir?: string;
  /** Encoder overrides (tests use a fast preset). Default = master quality. */
  encode?: { preset?: string; crf?: number; audioBitrateKbps?: number };
}

export interface RenderTimelineResult {
  outputPath: string;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  fps: number;
  captionCount: number;
  /** Things the renderer adjusted or could not do (clamped times, no word timings, ...). */
  warnings: string[];
  /** ffmpeg stderr lines that look like problems — should be empty. */
  ffmpegWarnings: string[];
  textLayouts: TextElementLayout[];
  captionLayouts: Array<{ chunk: TimelineCaptionChunk; layout: TimelineCaptionLayout }>;
  ffmpegArgs: string[];
  renderMs: number;
}

/** Master encode: mezzanine-grade so per-platform variants re-encode from a clean source. */
export const MASTER_ENCODE = { preset: "slow", crf: 16, audioBitrateKbps: 320 } as const;

const WARNING_PATTERNS = [/Stray %/i, /fontconfig/i, /font.*not found/i, /Error/i, /Glyph.*not found/i, /fallback/i];

/** 60 fps when every source is >= 50 fps (keep the motion), else 30. */
export function chooseOutputFps(sourceFps: Array<number | null>): number {
  return sourceFps.length > 0 && sourceFps.every((f) => (f ?? 0) >= 50) ? 60 : 30;
}

/** Frame-aligned clip lengths: clip k gets round(end_k*fps) - round(start_k*fps) frames, so
 * cumulative A/V position never drifts more than half a frame from the exact timeline. */
export function clipFrameCounts(timeline: Pick<EditTimeline, "clips">, fps: number): number[] {
  const counts: number[] = [];
  let t = 0;
  for (const c of timeline.clips) {
    const start = Math.round(t * fps);
    t += clipDuration(c);
    counts.push(Math.max(1, Math.round(t * fps) - start));
  }
  return counts;
}

function n(v: number): string {
  return String(Math.round(v * 10000) / 10000);
}

/** ffmpeg colour for drawtext/drawbox: 0xRRGGBB@alpha. */
function ffColor(hex: string): string {
  const c = parseHexColor(hex);
  const h = (x: number) => x.toString(16).padStart(2, "0").toUpperCase();
  return `0x${h(c.r)}${h(c.g)}${h(c.b)}@${n(c.a)}`;
}

/** ASS colour + alpha override values (&HBBGGRR& / &HAA&, AA = transparency). */
export function assColor(hex: string): { c: string; a: string } {
  const c = parseHexColor(hex);
  const h = (x: number) => x.toString(16).padStart(2, "0").toUpperCase();
  return { c: `&H${h(c.b)}${h(c.g)}${h(c.r)}&`, a: `&H${h(Math.round(255 - c.a * 255))}&` };
}

function assTime(seconds: number): string {
  const cs = Math.round(Math.max(0, seconds) * 100);
  const hh = Math.floor(cs / 360000);
  const mm = Math.floor((cs % 360000) / 6000);
  const ss = Math.floor((cs % 6000) / 100);
  return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** Rounded-rectangle ASS vector drawing in absolute canvas px (used with \an7\pos(0,0)). */
export function assRoundedRect(r: Rect, radius: number): string {
  const rad = Math.max(0, Math.min(radius, r.width / 2, r.height / 2));
  const k = rad * (1 - 0.5523);
  const x0 = r.x;
  const y0 = r.y;
  const x1 = r.x + r.width;
  const y1 = r.y + r.height;
  const p = (v: number) => String(Math.round(v * 100) / 100);
  if (rad <= 0) return `m ${p(x0)} ${p(y0)} l ${p(x1)} ${p(y0)} ${p(x1)} ${p(y1)} ${p(x0)} ${p(y1)}`;
  return [
    `m ${p(x0 + rad)} ${p(y0)}`,
    `l ${p(x1 - rad)} ${p(y0)}`,
    `b ${p(x1 - k)} ${p(y0)} ${p(x1)} ${p(y0 + k)} ${p(x1)} ${p(y0 + rad)}`,
    `l ${p(x1)} ${p(y1 - rad)}`,
    `b ${p(x1)} ${p(y1 - k)} ${p(x1 - k)} ${p(y1)} ${p(x1 - rad)} ${p(y1)}`,
    `l ${p(x0 + rad)} ${p(y1)}`,
    `b ${p(x0 + k)} ${p(y1)} ${p(x0)} ${p(y1 - k)} ${p(x0)} ${p(y1 - rad)}`,
    `l ${p(x0)} ${p(y0 + rad)}`,
    `b ${p(x0)} ${p(y0 + k)} ${p(x0 + k)} ${p(y0)} ${p(x0 + rad)} ${p(y0)}`,
  ].join(" ");
}

function assHeader(canvas: { width: number; height: number }): string[] {
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    // drawtext and the browser preview (font-kerning: none) don't kern either — keep widths identical.
    "Kerning: no",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Base,Inter SemiBold,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
}

function plateEvent(layer: number, start: number, end: number, rect: Rect, radius: number, color: string): string {
  const col = assColor(color);
  return `Dialogue: ${layer},${assTime(start)},${assTime(end)},Base,,0,0,0,,{\\an7\\pos(0,0)\\bord0\\shad0\\1c${col.c}\\1a${col.a}\\p1}${assRoundedRect(rect, radius)}{\\p0}`;
}

/** ASS document with the rounded plates behind texts (drawtext draws the glyphs on top). */
export function buildTextPlatesAss(
  texts: Array<{ start: number; end: number; layout: TextElementLayout }>,
  canvas: { width: number; height: number },
): string | null {
  const events = texts
    .filter((t) => t.layout.plate)
    .map((t) => plateEvent(0, t.start, t.end, t.layout.plate!.rect, t.layout.plate!.radius, t.layout.plate!.color));
  if (events.length === 0) return null;
  return [...assHeader(canvas), ...events, ""].join("\n");
}

/**
 * Caption ASS: every line is its own event at \an7\pos(lineLeft, lineTop) where
 * lineTop = baseline - winAscent*fontPx/unitsPerEm (libass's measured baseline offset) and the
 * font size is set as ASS Fontsize = fontPx*(winAscent+winDescent)/unitsPerEm — so libass
 * draws exactly the geometry timeline-layout computed.
 */
export function buildCaptionsAss(
  timeline: Pick<EditTimeline, "canvas" | "captions">,
  laid: Array<{ chunk: TimelineCaptionChunk; layout: TimelineCaptionLayout }>,
): string | null {
  if (laid.length === 0) return null;
  const cap = timeline.captions;
  const m = fontMetricsFor(cap.fontId);
  const events: string[] = [];
  const base = assColor(cap.color);
  const hi = assColor(cap.highlightColor);
  const stroke = cap.strokeColor ? assColor(cap.strokeColor) : null;
  const shadow = assColor("#00000080");

  for (const { chunk, layout } of laid) {
    const assSize = Math.round(((layout.fontPx * (m.winAscent + m.winDescent)) / m.unitsPerEm) * 100) / 100;
    const ascent = (m.winAscent * layout.fontPx) / m.unitsPerEm;
    const style =
      `\\fn${m.fullName}\\fs${assSize}\\b0\\i0\\bord${layout.strokeWidth}\\shad${layout.shadowOffset}` +
      (stroke ? `\\3c${stroke.c}\\3a${stroke.a}` : "") +
      `\\4c${shadow.c}\\4a${shadow.a}`;
    if (layout.plate) {
      events.push(plateEvent(0, chunk.start, chunk.end, layout.plate.rect, layout.plate.radius, layout.plate.color));
    }
    const words = chunk.words;
    for (const line of layout.lines) {
      const pos = `\\an7\\pos(${line.x},${n(line.baseline - ascent)})`;
      if (cap.preset === "KARAOKE") {
        // \kf sweeps SecondaryColour (unfilled = color) -> PrimaryColour (filled = highlight)
        // across each word over [word.start, next word.start). Cumulative centiseconds, so
        // rounding never drifts.
        const first = line.words[0]!.index;
        let cursor = Math.round((words[first]!.start - chunk.start) * 100);
        let text = cursor > 0 ? `{\\k${cursor}}` : "";
        line.words.forEach((w, j) => {
          const word = words[w.index]!;
          const nextStart = words[w.index + 1]?.start ?? word.end;
          const endCs = Math.max(cursor, Math.round((Math.max(nextStart, word.start) - chunk.start) * 100));
          const dur = j < line.words.length - 1 && line.words[j + 1]!.index === w.index ? 0 : endCs - cursor;
          text += `${j > 0 ? " " : ""}{\\kf${dur}}${sanitizeAssText(w.text)}`;
          cursor += dur;
        });
        events.push(
          `Dialogue: 1,${assTime(chunk.start)},${assTime(chunk.end)},Base,,0,0,0,,{${pos}${style}\\1c${hi.c}\\1a${hi.a}\\2c${base.c}\\2a${base.a}}${text}`,
        );
        continue;
      }
      const colored = (active: number | null) =>
        line.words
          .map((w) => {
            const t = sanitizeAssText(w.text);
            return active !== null && w.index === active ? `{\\1c${hi.c}\\1a${hi.a}}${t}{\\1c${base.c}\\1a${base.a}}` : t;
          })
          .join(" ");
      const head = `{${pos}${style}\\1c${base.c}\\1a${base.a}}`;
      if (cap.preset !== "BOLD_HIGHLIGHT") {
        events.push(`Dialogue: 1,${assTime(chunk.start)},${assTime(chunk.end)},Base,,0,0,0,,${head}${colored(null)}`);
        continue;
      }
      // BOLD_HIGHLIGHT: the phrase stays put; the spoken word lights up. Word i is active from
      // its start (chunk start for the first word) to the next word's start (chunk end for
      // the last).
      words.forEach((w, i) => {
        const s = i === 0 ? chunk.start : w.start;
        const e = i === words.length - 1 ? chunk.end : words[i + 1]!.start;
        if (e <= s) return;
        events.push(`Dialogue: 1,${assTime(s)},${assTime(e)},Base,,0,0,0,,${head}${colored(i)}`);
      });
    }
  }
  return [...assHeader(timeline.canvas), ...events, ""].join("\n");
}

/** The zoom (perspective) filter for normalized zooms, or null when there are none. */
export function zoomFilter(
  zooms: EditTimeline["zooms"],
  canvas: { width: number; height: number },
  fps: number,
): string | null {
  if (zooms.length === 0) return null;
  // T = output time of the frame. perspective's `in` is the 1-based input frame count (verified by test).
  const T = `((in-1)/${fps})`;
  let z = "1";
  for (const zm of [...zooms].reverse()) {
    let expr: string;
    if (zm.mode === "EASE" && zm.easeSeconds > 0) {
      const p = `clip((${T}-${n(zm.start)})/${n(zm.easeSeconds)},0,1)`;
      const e = `if(lt(${p},0.5),4*pow(${p},3),1-pow(2-2*${p},3)/2)`;
      expr = `(1+${n(zm.zoom - 1)}*${e})`;
    } else expr = n(zm.zoom);
    z = `if(gte(${T},${n(zm.start)})*lt(${T},${n(zm.end)}),${expr},${z})`;
  }
  const W = canvas.width;
  const H = canvas.height;
  // Repeat per corner — ffmpeg expressions have no variables shared across options.
  const zx = `(${z})`;
  // Focal point per time window: x/y are constant per zoom, but outside zooms it doesn't
  // matter (zoom = 1 -> window = full frame), so use the active zoom's focal point.
  let fx = "0.5";
  let fy = "0.5";
  for (const zm of [...zooms].reverse()) {
    fx = `if(gte(${T},${n(zm.start)})*lt(${T},${n(zm.end)}),${n(zm.x)},${fx})`;
    fy = `if(gte(${T},${n(zm.start)})*lt(${T},${n(zm.end)}),${n(zm.y)},${fy})`;
  }
  const left = `(${fx})*${W}*(1-1/${zx})`;
  const top = `(${fy})*${H}*(1-1/${zx})`;
  const right = `(${left}+${W}/${zx})`;
  const bottom = `(${top}+${H}/${zx})`;
  return (
    `perspective=x0='${left}':y0='${top}':x1='${right}':y1='${top}':x2='${left}':y2='${bottom}':` +
    `x3='${right}':y3='${bottom}':interpolation=cubic:sense=source:eval=frame`
  );
}

/** Grade filters (eq / colorchannelmixer / vignette) for a timeline grade, or [] if neutral. */
export function gradeFilters(grade: EditTimeline["grade"]): string[] {
  const g = resolveGrade(grade);
  if (isNeutralGrade(g)) return [];
  const out: string[] = [];
  if (g.brightness !== 0 || g.contrast !== 1 || g.saturation !== 1) {
    out.push(`eq=brightness=${n(g.brightness)}:contrast=${n(g.contrast)}:saturation=${n(g.saturation)}`);
  }
  if (g.temperature !== 0) {
    const t = temperatureGains(g.temperature);
    out.push(`colorchannelmixer=rr=${n(t.r)}:gg=${n(t.g)}:bb=${n(t.b)}`);
  }
  if (g.vignette > 0) out.push(`vignette=angle=${n(vignetteAngle(g.vignette))}`);
  return out;
}

function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(FFMPEG_PATH, args);
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolvePromise(stderr) : reject(new Error(`ffmpeg exited with code ${code}:\n${stderr.slice(-3000)}`)),
    );
  });
}

export class TimelineSourceMissingError extends Error {
  constructor(mediaAssetId: string) {
    super(`Timeline clip references media asset ${mediaAssetId}, but no local source file was provided for it.`);
    this.name = "TimelineSourceMissingError";
  }
}

/**
 * Renders an EditTimeline to `outputPath` (H.264 High / AAC-LC 48 kHz stereo master, faststart).
 * Throws for anything that would make the output wrong (unknown font, missing source, a clip
 * past its source's end); anything it adjusts (clamped times, missing word timings) is listed
 * in `warnings`, never dropped silently.
 */
export async function renderTimeline(input: RenderTimelineInput): Promise<RenderTimelineResult> {
  const started = Date.now();
  const timeline = EditTimelineSchema.parse(input.timeline);
  const canvas = timeline.canvas;
  const fontsDir = input.fontsDir ?? resolveBundledFontsDir();
  const warnings: string[] = [];
  const measure: MeasureText = (text, fontId, px) => measureTextWidth(text, registeredFontPath(fontId, fontsDir), px);

  // Fonts first: an unknown font is a hard error, never a silent substitution.
  const usedFonts = new Set(timeline.texts.map((t) => t.fontId));
  if (timeline.captions.enabled) usedFonts.add(timeline.captions.fontId);
  for (const id of usedFonts) {
    registeredFontPath(id, fontsDir);
    fontMetricsFor(id);
  }

  // Sources: probe each distinct asset once.
  const probes = new Map<string, ProbeResult>();
  for (const clip of timeline.clips) {
    if (probes.has(clip.mediaAssetId)) continue;
    const path = input.sources[clip.mediaAssetId];
    if (!path || !existsSync(path)) throw new TimelineSourceMissingError(clip.mediaAssetId);
    probes.set(clip.mediaAssetId, await probeMedia(path));
  }
  timeline.clips.forEach((clip, i) => {
    const p = probes.get(clip.mediaAssetId)!;
    if (!(clip.sourceEnd > clip.sourceStart)) {
      throw new Error(`Clip ${clip.id}: sourceEnd (${clip.sourceEnd}) must be after sourceStart (${clip.sourceStart}).`);
    }
    if (!p.hasVideo) throw new Error(`Clip ${clip.id}: source ${clip.mediaAssetId} has no video stream.`);
    if (clip.sourceEnd > p.durationSeconds + 0.1) {
      throw new RenderSegmentOutOfBoundsError(clip.sourceEnd, p.durationSeconds);
    }
    if (clip.sourceEnd > p.durationSeconds + 0.02) {
      warnings.push(`clip ${i + 1} (${clip.id}): ends ${n(clip.sourceEnd - p.durationSeconds)}s past its source — last frame held.`);
    }
    if (!p.hasAudio) warnings.push(`clip ${i + 1} (${clip.id}): source has no audio track — silence used.`);
  });

  const fps = chooseOutputFps(timeline.clips.map((c) => probes.get(c.mediaAssetId)!.frameRate));
  const frames = clipFrameCounts(timeline, fps);
  const duration = timelineDuration(timeline);

  const { texts, warnings: textWarnings } = normalizeTexts(timeline.texts, duration);
  const { zooms, warnings: zoomWarnings } = normalizeZooms(timeline.zooms, duration);
  warnings.push(...textWarnings, ...zoomWarnings);

  // Captions — the exact chunks the browser preview shows.
  let chunks: TimelineCaptionChunk[] = [];
  if (timeline.captions.enabled) {
    const usedAssets = [...new Set(timeline.clips.map((c) => c.mediaAssetId))];
    const anyWords = usedAssets.some((id) => (input.sourceWords[id]?.length ?? 0) > 0);
    if (!anyWords) {
      warnings.push("captions: enabled but no take in this timeline has word timings — no captions burned in.");
    } else {
      for (const id of usedAssets) {
        if (!(input.sourceWords[id]?.length ?? 0)) warnings.push(`captions: take ${id} has no word timings — its clips have no captions.`);
      }
      chunks = timelineCaptionChunks(timeline, input.sourceWords).filter((c) => c.start < duration);
    }
  }

  const textLayouts = texts.map((t) => layoutTimelineText(t, canvas, measure));
  const captionLayouts = chunks.map((chunk) => ({ chunk, layout: layoutCaptionChunk(chunk, timeline.captions, canvas, measure) }));

  const workDir = await mkdtemp(join(tmpdir(), "chris-timeline-"));
  try {
    const args: string[] = ["-hide_banner", "-y"];
    const parts: string[] = [];
    const W = canvas.width;
    const H = canvas.height;

    timeline.clips.forEach((clip, k) => {
      const path = input.sources[clip.mediaAssetId]!;
      const p = probes.get(clip.mediaAssetId)!;
      const outSeconds = frames[k]! / fps;
      // One input per CLIP with accurate input seeking (not one per asset): clips may come
      // from any point of any take in any order, and a shared input would make ffmpeg buffer
      // every decoded frame a later clip needs while concat is still consuming earlier ones.
      args.push("-ss", n(clip.sourceStart), "-t", n(clipDuration(clip) + 0.5), "-i", path);
      const cover = `max(${W}/iw,${H}/ih)*${n(clip.crop.zoom)}`;
      parts.push(
        `[${k}:v]setpts=PTS-STARTPTS,fps=${fps},` +
          `scale=w='max(${W},2*round(iw*${cover}/2))':h='max(${H},2*round(ih*${cover}/2))':flags=lanczos,` +
          `crop=${W}:${H}:x='(iw-ow)*${n((clip.crop.panX + 1) / 2)}':y='(ih-oh)*${n((clip.crop.panY + 1) / 2)}',` +
          `setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frames[k]},setpts=PTS-STARTPTS[v${k}]`,
      );
      const vol = clip.volume !== 1 ? `,volume=${n(clip.volume)}` : "";
      if (p.hasAudio) {
        parts.push(
          `[${k}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${vol},` +
            `apad,atrim=end=${n(outSeconds)},asetpts=PTS-STARTPTS[a${k}]`,
        );
      } else {
        parts.push(
          `anullsrc=r=48000:cl=stereo,atrim=end=${n(outSeconds)},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${k}]`,
        );
      }
    });
    parts.push(
      `${timeline.clips.map((_, k) => `[v${k}][a${k}]`).join("")}concat=n=${timeline.clips.length}:v=1:a=1[vcat][acat]`,
    );

    const vChain: string[] = [];
    const zf = zoomFilter(zooms, canvas, fps);
    if (zf) vChain.push(zf);
    vChain.push(...gradeFilters(timeline.grade));

    const platesAss = buildTextPlatesAss(
      texts.map((t, i) => ({ start: t.start, end: t.end, layout: textLayouts[i]! })),
      canvas,
    );
    if (platesAss) {
      const p = join(workDir, "plates.ass");
      await writeFile(p, platesAss, "utf8");
      vChain.push(`ass=filename='${escapeFilterPathValue(p)}':fontsdir='${escapeFilterPathValue(fontsDir)}'`);
    }

    let fileCounter = 0;
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i]!;
      const l = textLayouts[i]!;
      const fontPath = registeredFontPath(t.fontId, fontsDir);
      for (const line of l.lines) {
        const textPath = join(workDir, `text-${fileCounter++}.txt`);
        await writeFile(textPath, line.text, "utf8");
        const opts = [
          `fontfile='${escapeFilterPathValue(fontPath)}'`,
          `textfile='${escapeFilterPathValue(textPath)}'`,
          "expansion=none",
          `fontsize=${l.fontPx}`,
          `fontcolor=${ffColor(t.color)}`,
          `x=${line.x}`,
          // `ascent` = the rendered glyphs' max ascent: puts the baseline exactly at line.baseline.
          `y=${line.baseline}-ascent`,
        ];
        if (l.strokeWidth > 0 && t.strokeColor) opts.push(`borderw=${l.strokeWidth}`, `bordercolor=${ffColor(t.strokeColor)}`);
        opts.push(`enable='gte(t,${n(t.start)})*lt(t,${n(t.end)})'`);
        vChain.push(`drawtext=${opts.join(":")}`);
      }
    }

    const captionsAss = buildCaptionsAss(timeline, captionLayouts);
    if (captionsAss) {
      const p = join(workDir, "captions.ass");
      await writeFile(p, captionsAss, "utf8");
      vChain.push(`ass=filename='${escapeFilterPathValue(p)}':fontsdir='${escapeFilterPathValue(fontsDir)}'`);
    }
    vChain.push("format=yuv420p");
    parts.push(`[vcat]${vChain.join(",")}[vout]`);

    // loudnorm can't normalise pure digital silence (every clip from audio-less takes).
    const anyAudio = timeline.clips.some((c) => probes.get(c.mediaAssetId)!.hasAudio);
    const aChain = timeline.audio.normalize && anyAudio
      ? // -14 LUFS integrated / -1.5 dBTP: the short-form master target (variants re-normalise per platform).
        "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000"
      : "anull";
    parts.push(`[acat]${aChain}[aout]`);

    const enc = { ...MASTER_ENCODE, ...input.encode };
    args.push(
      "-filter_complex", parts.join(";"),
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", enc.preset, "-crf", String(enc.crf),
      "-profile:v", "high", "-pix_fmt", "yuv420p",
      "-g", String(fps * 2), "-r", String(fps),
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
      "-c:a", "aac", "-b:a", `${enc.audioBitrateKbps}k`, "-ar", "48000", "-ac", "2",
      "-t", n(frames.reduce((a, b) => a + b, 0) / fps),
      "-movflags", "+faststart",
      input.outputPath,
    );

    const stderr = await runFfmpeg(args);
    const ffmpegWarnings = stderr
      .split("\n")
      .filter((line) => WARNING_PATTERNS.some((p) => p.test(line)))
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const probed = await probeMedia(input.outputPath);
    return {
      outputPath: input.outputPath,
      durationSeconds: probed.durationSeconds,
      width: probed.width,
      height: probed.height,
      fps,
      captionCount: chunks.length,
      warnings,
      ffmpegWarnings,
      textLayouts,
      captionLayouts,
      ffmpegArgs: args,
      renderMs: Date.now() - started,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
