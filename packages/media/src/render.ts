import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildAssDocument,
  buildCaptionChunks,
  layoutCaptionChunks,
  remapWordsToOutputTimeline,
  CAPTION_STYLE_PRESETS,
  type CaptionLayoutResult,
  type CaptionsConfig,
  type TranscriptWord,
} from "./captions";
import { FFMPEG_PATH } from "./ffmpeg-paths";
import { BUNDLED_FONT_FILES, resolveBundledFontsDir, type BundledFontWeight } from "./fonts";
import { layoutOverlays, type OverlayLayout, type OverlayPosition, type OverlayStyle } from "./overlay-layout";
import { probeMedia } from "./probe";

export interface TextOverlayInstruction {
  text: string;
  /** Output timeline. */
  startSeconds: number;
  endSeconds: number;
  position: OverlayPosition;
  /** Visual treatment; defaults to HEADLINE. See OVERLAY_STYLE_PRESETS. */
  style?: OverlayStyle;
}

export type PunchInFocus = "CENTER" | "UPPER_THIRD";

export interface PunchInInstruction {
  /** Output timeline. */
  startSeconds: number;
  endSeconds: number;
  /** 1.0 - 1.3. */
  zoom: number;
  focus?: PunchInFocus;
}

export interface CaptionsInstruction {
  config: CaptionsConfig;
  /** Word timings on the SOURCE timeline (MediaAsset.transcriptWords); remapped here. */
  sourceWords: TranscriptWord[];
}

export interface RenderInstructions {
  sourcePath: string;
  outputPath: string;
  /** Segments to keep, source-time order, at least one. More than one is concatenated as
   * hard cuts — no transitions yet, see /docs/DECISIONS.md. */
  segments: Array<{ startSeconds: number; endSeconds: number }>;
  /** Center-crop + scale to this target (e.g. 1080x1920 for 9:16), or null to keep the
   * source's native framing. */
  targetDimensions: { width: number; height: number } | null;
  textOverlays: TextOverlayInstruction[];
  normalizeAudio: boolean;
  /**
   * Optional font override. Omitted/empty, or pointing at one of the bundled Inter files:
   * each overlay style uses its own bundled weight (the normal case). Any other path: that
   * single font is used for every overlay. Either way the file MUST exist — renderVideo
   * throws rather than letting ffmpeg silently fall back to a random system font.
   */
  fontPath?: string;
  /** Burned-in word-level captions; omitted or disabled = none. */
  captions?: CaptionsInstruction | null;
  punchIns?: PunchInInstruction[];
}

export interface RenderResult {
  outputPath: string;
  ffmpegArgs: string[];
  durationSeconds: number;
  width: number | null;
  height: number | null;
  /** Instructions the renderer received but did not (fully) execute, human-readable. */
  unexecutedInstructions: string[];
  /** Laid-out overlays (pixel rects) and captions — what was actually drawn, for QC. */
  overlayLayouts: OverlayLayout[];
  captionLayout: CaptionLayoutResult | null;
  /** ffmpeg stderr lines that look like warnings (should be empty for a clean render). */
  ffmpegWarnings: string[];
}

export class RenderFontNotFoundError extends Error {
  constructor(fontPath: string) {
    super(
      `Font file not found: ${fontPath}. Refusing to render — ffmpeg would otherwise silently ` +
        `substitute whatever fontconfig finds and still exit 0.`,
    );
    this.name = "RenderFontNotFoundError";
  }
}

/** Paths are developer/system-controlled, not LLM output — correctness escaping for a
 * single-quoted filtergraph option value. */
export function escapeFilterPathValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:");
}

function num(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function enableBetween(start: number, end: number): string {
  return `enable='between(t,${num(start)},${num(end)})'`;
}

/** Validates/normalises punch-ins against the output duration; returns executed + notes. */
export function normalizePunchIns(
  punchIns: PunchInInstruction[],
  outputDurationSeconds: number,
): { executed: Required<PunchInInstruction>[]; skipped: string[] } {
  const skipped: string[] = [];
  const sorted = [...punchIns].sort((a, b) => a.startSeconds - b.startSeconds);
  const executed: Required<PunchInInstruction>[] = [];
  for (const p of sorted) {
    const start = Math.max(0, p.startSeconds);
    const end = Math.min(outputDurationSeconds, p.endSeconds);
    const label = `punch-in ${num(p.startSeconds)}-${num(p.endSeconds)}s x${p.zoom}`;
    if (end - start < 0.2) {
      skipped.push(`${label}: outside the output timeline or shorter than 0.2s — skipped.`);
      continue;
    }
    const prev = executed[executed.length - 1];
    if (prev && start < prev.endSeconds) {
      skipped.push(`${label}: overlaps the previous punch-in — skipped.`);
      continue;
    }
    let zoom = p.zoom;
    if (!(zoom >= 1 && zoom <= 1.3)) {
      zoom = Math.min(1.3, Math.max(1, zoom || 1));
      skipped.push(`${label}: zoom outside 1.0-1.3, clamped to ${zoom}.`);
    }
    if (zoom === 1) continue;
    executed.push({ startSeconds: start, endSeconds: end, zoom, focus: p.focus ?? "CENTER" });
  }
  return { executed, skipped };
}

/**
 * Crop (in source pixels, so punch-ins re-sample the original footage instead of upscaling an
 * already-upscaled frame) then scale to the canvas. zoom=1 is exactly the old
 * "scale-to-cover + center-crop" behaviour.
 */
function framingFilter(
  canvas: { width: number; height: number },
  zoom: number,
  focus: PunchInFocus,
): string {
  const { width: W, height: H } = canvas;
  const cw = `trunc(min(iw\\,ih*${W}/${H})/${zoom}/2)*2`;
  const ch = `trunc(min(ih\\,iw*${H}/${W})/${zoom}/2)*2`;
  const fy = focus === "UPPER_THIRD" ? 0.38 : 0.5;
  const y = fy === 0.5 ? "(ih-oh)/2" : `max(0\\,min(ih-oh\\,ih*${fy}-oh/2))`;
  return `crop=w=${cw}:h=${ch}:x=(iw-ow)/2:y=${y},scale=${W}:${H}:flags=lanczos,setsar=1`;
}

interface BuiltGraph {
  filterComplex: string;
  videoLabel: string;
  audioLabel: string;
}

async function buildFilterComplex(
  instructions: RenderInstructions,
  ctx: {
    canvas: { width: number; height: number };
    needsFraming: boolean;
    punchIns: Required<PunchInInstruction>[];
    outputDuration: number;
    overlays: OverlayLayout[];
    captionAssPath: string | null;
    fontsDir: string;
    workDir: string;
  },
): Promise<BuiltGraph> {
  const { segments, normalizeAudio } = instructions;
  const parts: string[] = [];
  let videoLabel: string;
  let audioLabel: string;

  if (segments.length === 1) {
    const seg = segments[0]!;
    parts.push(`[0:v]trim=start=${num(seg.startSeconds)}:end=${num(seg.endSeconds)},setpts=PTS-STARTPTS[v0]`);
    parts.push(`[0:a]atrim=start=${num(seg.startSeconds)}:end=${num(seg.endSeconds)},asetpts=PTS-STARTPTS[a0]`);
    videoLabel = "v0";
    audioLabel = "a0";
  } else {
    const pairLabels: string[] = [];
    segments.forEach((seg, i) => {
      parts.push(`[0:v]trim=start=${num(seg.startSeconds)}:end=${num(seg.endSeconds)},setpts=PTS-STARTPTS[v${i}]`);
      parts.push(`[0:a]atrim=start=${num(seg.startSeconds)}:end=${num(seg.endSeconds)},asetpts=PTS-STARTPTS[a${i}]`);
      pairLabels.push(`[v${i}][a${i}]`);
    });
    parts.push(`${pairLabels.join("")}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);
    videoLabel = "vcat";
    audioLabel = "acat";
  }

  // Framing + punch-ins. Punch-ins are hard "jump" zooms (the standard talking-head punch-in),
  // implemented by splitting the output timeline into pieces, framing each piece with a static
  // crop, and concatenating — no per-frame expressions, no zoompan frame-rate pitfalls.
  if (ctx.punchIns.length > 0) {
    const pieces: Array<{ start: number; end: number; zoom: number; focus: PunchInFocus }> = [];
    let cursor = 0;
    for (const p of ctx.punchIns) {
      if (p.startSeconds > cursor) pieces.push({ start: cursor, end: p.startSeconds, zoom: 1, focus: "CENTER" });
      pieces.push({ start: p.startSeconds, end: p.endSeconds, zoom: p.zoom, focus: p.focus });
      cursor = p.endSeconds;
    }
    if (cursor < ctx.outputDuration) pieces.push({ start: cursor, end: ctx.outputDuration, zoom: 1, focus: "CENTER" });
    const splitLabels = pieces.map((_, i) => `[ps${i}]`).join("");
    parts.push(`[${videoLabel}]split=${pieces.length}${splitLabels}`);
    pieces.forEach((piece, i) => {
      // The last piece is open-ended so frame rounding can never drop the tail.
      const trim = i === pieces.length - 1 ? `trim=start=${num(piece.start)}` : `trim=start=${num(piece.start)}:end=${num(piece.end)}`;
      parts.push(`[ps${i}]${trim},setpts=PTS-STARTPTS,${framingFilter(ctx.canvas, piece.zoom, piece.focus)}[pf${i}]`);
    });
    parts.push(`${pieces.map((_, i) => `[pf${i}]`).join("")}concat=n=${pieces.length}:v=1:a=0[vframed]`);
    videoLabel = "vframed";
  } else if (ctx.needsFraming) {
    parts.push(`[${videoLabel}]${framingFilter(ctx.canvas, 1, "CENTER")}[vframed]`);
    videoLabel = "vframed";
  }

  // Text overlays: one translucent plate (drawbox) + one drawtext per pre-wrapped line. Text
  // goes through `textfile=` with `expansion=none`, so it is rendered byte-for-byte — no
  // filtergraph escaping of untrusted text at all (the old inline `text='...'` path silently
  // rendered nothing for "50%" and mangled ':' ',' ';' brackets).
  let textFileCounter = 0;
  for (const o of ctx.overlays) {
    const enable = enableBetween(o.startSeconds, o.endSeconds);
    const chain: string[] = [];
    if (o.plate) {
      const r = o.plate.rect;
      chain.push(`drawbox=x=${r.x}:y=${r.y}:w=${r.width}:h=${r.height}:color=${o.plate.color}:t=fill:${enable}`);
    }
    if (o.accentBar) {
      const r = o.accentBar.rect;
      chain.push(`drawbox=x=${r.x}:y=${r.y}:w=${r.width}:h=${r.height}:color=${o.accentBar.color}:t=fill:${enable}`);
    }
    for (const line of o.lines) {
      const textPath = join(ctx.workDir, `overlay-${textFileCounter++}.txt`);
      await writeFile(textPath, line.text, "utf8");
      const x = line.x === "CENTER" ? "(w-text_w)/2" : String(line.x);
      const opts = [
        `fontfile='${escapeFilterPathValue(o.fontPath)}'`,
        `textfile='${escapeFilterPathValue(textPath)}'`,
        "expansion=none",
        `fontsize=${o.fontSize}`,
        `fontcolor=${o.textColor}`,
        `x=${x}`,
        // `ascent` = this line's tallest glyph above the baseline, so every line sits on its
        // computed baseline regardless of which glyphs it happens to contain.
        `y=${line.baselineY}-ascent`,
      ];
      if (o.borderWidth > 0) opts.push(`borderw=${o.borderWidth}`, `bordercolor=${o.borderColor}`);
      if (o.shadow) opts.push(`shadowx=${o.shadow.x}`, `shadowy=${o.shadow.y}`, `shadowcolor=${o.shadow.color}`);
      opts.push(enable);
      chain.push(`drawtext=${opts.join(":")}`);
    }
    if (chain.length > 0) {
      const next = `vtext${o.index}`;
      parts.push(`[${videoLabel}]${chain.join(",")}[${next}]`);
      videoLabel = next;
    }
  }

  if (ctx.captionAssPath) {
    parts.push(
      `[${videoLabel}]ass=filename='${escapeFilterPathValue(ctx.captionAssPath)}':fontsdir='${escapeFilterPathValue(ctx.fontsDir)}'[vcap]`,
    );
    videoLabel = "vcap";
  }

  if (normalizeAudio) {
    // -14 LUFS integrated: the de-facto short-form platform target (TikTok/Reels/Shorts all
    // normalise toward roughly -14), matching technical QC's loudness expectation.
    parts.push(`[${audioLabel}]loudnorm=I=-14:TP=-1.5:LRA=11[anorm]`);
    audioLabel = "anorm";
  }

  return { filterComplex: parts.join(";"), videoLabel, audioLabel };
}

/** stderr lines that indicate a silent-failure class we've been bitten by. */
const WARNING_PATTERNS = [/Stray %/i, /fontconfig/i, /font.*not found/i, /Error/i, /Glyph.*not found/i, /fallback/i];

function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(FFMPEG_PATH, args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stderr);
      } else {
        reject(new Error(`ffmpeg exited with code ${code}:\n${stderr.slice(-2000)}`));
      }
    });
  });
}

export class RenderSegmentOutOfBoundsError extends Error {
  constructor(endSeconds: number, sourceDurationSeconds: number) {
    super(
      `Segment ends at ${endSeconds}s, past the source file's actual duration of ` +
        `${sourceDurationSeconds}s. Refusing to render — ffmpeg's trim filter would silently ` +
        `clamp to the available frames rather than error, producing a shorter clip than ` +
        `requested instead of a clear failure.`,
    );
    this.name = "RenderSegmentOutOfBoundsError";
  }
}

function resolveFontOverride(fontPath: string | undefined): string | null {
  if (!fontPath) return null;
  if (!existsSync(fontPath)) throw new RenderFontNotFoundError(fontPath);
  // A path to one of the bundled files means "use the bundled per-style weights".
  const bundledNames = new Set<string>(Object.values(BUNDLED_FONT_FILES));
  const name = fontPath.split(/[\\/]/).pop() ?? "";
  if (bundledNames.has(name)) {
    try {
      if (resolve(dirname(fontPath)) === resolve(resolveBundledFontsDir())) return null;
    } catch {
      // Bundled dir not resolvable from here, but the given file exists: use it explicitly.
    }
  }
  return fontPath;
}

/**
 * Executes a validated EditPlan-derived instruction set deterministically via ffmpeg — the
 * renderer does not improvise; every effect must be explicit in `instructions`. Anything it
 * received but could not execute is reported in `unexecutedInstructions`, never dropped
 * silently.
 */
export async function renderVideo(instructions: RenderInstructions): Promise<RenderResult> {
  if (instructions.segments.length === 0) {
    throw new Error("RenderInstructions.segments must contain at least one segment.");
  }

  const fontOverride = resolveFontOverride(instructions.fontPath);
  const fontsDir = resolveBundledFontsDir();
  for (const file of Object.values(BUNDLED_FONT_FILES)) {
    if (!existsSync(join(fontsDir, file))) throw new RenderFontNotFoundError(join(fontsDir, file));
  }

  // Defense in depth: ffmpeg's trim filter does NOT error on an out-of-bounds end time — it
  // silently clamps — so this check has to happen here, not just upstream.
  const sourceProbe = await probeMedia(instructions.sourcePath);
  const tolerance = 0.1; // frame-rounding slack
  for (const segment of instructions.segments) {
    if (segment.endSeconds > sourceProbe.durationSeconds + tolerance) {
      throw new RenderSegmentOutOfBoundsError(segment.endSeconds, sourceProbe.durationSeconds);
    }
  }

  const unexecuted: string[] = [];
  const outputDuration = instructions.segments.reduce(
    (sum, s) => sum + Math.max(0, s.endSeconds - s.startSeconds),
    0,
  );
  const canvas = instructions.targetDimensions ?? {
    width: sourceProbe.width ?? 1080,
    height: sourceProbe.height ?? 1920,
  };

  const { executed: punchIns, skipped } = normalizePunchIns(instructions.punchIns ?? [], outputDuration);
  unexecuted.push(...skipped);

  const overlays = layoutOverlays(
    instructions.textOverlays.filter((o) => o.text.trim().length > 0 && o.endSeconds > o.startSeconds),
    canvas,
    fontOverride ? { fontPathOverride: (_w: BundledFontWeight) => fontOverride } : {},
  );

  let captionLayout: CaptionLayoutResult | null = null;
  const workDir = await mkdtemp(join(tmpdir(), "chris-render-text-"));
  try {
    let captionAssPath: string | null = null;
    const cap = instructions.captions;
    if (cap?.config.enabled) {
      if (cap.sourceWords.length === 0) {
        unexecuted.push("captions: enabled but the take has no word timings — no captions burned in.");
      } else {
        const outWords = remapWordsToOutputTimeline(cap.sourceWords, instructions.segments);
        const chunks = buildCaptionChunks(outWords, {
          maxChars: CAPTION_STYLE_PRESETS[cap.config.style].maxChars,
        });
        captionLayout = layoutCaptionChunks(chunks, cap.config, canvas, overlays);
        for (const l of captionLayout.layouts) {
          if (l.residualCollisionWith.length > 0) {
            unexecuted.push(
              `captions: "${l.chunk.text}" at ${num(l.chunk.start)}s overlaps overlay(s) ` +
                `${l.residualCollisionWith.join(", ")} and no free safe position was found.`,
            );
          }
        }
        if (chunks.length > 0) {
          captionAssPath = join(workDir, "captions.ass");
          await writeFile(captionAssPath, buildAssDocument(captionLayout, canvas), "utf8");
        }
      }
    }

    const needsFraming = instructions.targetDimensions != null;

    const { filterComplex, videoLabel, audioLabel } = await buildFilterComplex(instructions, {
      canvas,
      needsFraming,
      punchIns,
      outputDuration,
      overlays,
      captionAssPath,
      fontsDir,
      workDir,
    });

    const args = [
      "-hide_banner",
      "-y",
      "-i",
      instructions.sourcePath,
      "-filter_complex",
      filterComplex,
      "-map",
      `[${videoLabel}]`,
      "-map",
      `[${audioLabel}]`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      instructions.outputPath,
    ];

    const stderr = await runFfmpeg(args);
    const ffmpegWarnings = stderr
      .split("\n")
      .filter((line) => WARNING_PATTERNS.some((p) => p.test(line)))
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const probed = await probeMedia(instructions.outputPath);
    return {
      outputPath: instructions.outputPath,
      ffmpegArgs: args,
      durationSeconds: probed.durationSeconds,
      width: probed.width,
      height: probed.height,
      unexecutedInstructions: unexecuted,
      overlayLayouts: overlays,
      captionLayout,
      ffmpegWarnings,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
