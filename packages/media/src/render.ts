import { spawn } from "node:child_process";
import { FFMPEG_PATH } from "./ffmpeg-paths";
import { probeMedia } from "./probe";

export interface TextOverlayInstruction {
  text: string;
  startSeconds: number;
  endSeconds: number;
  position: "TOP" | "CENTER" | "BOTTOM";
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
  /** Path to a real font file — required, never left to ffmpeg's own fontconfig fallback.
   * See /docs/DECISIONS.md: relying on implicit font resolution produced a non-deterministic,
   * wrong-language font on this dev machine and isn't portable to a production host anyway. */
  fontPath: string;
}

export interface RenderResult {
  outputPath: string;
  ffmpegArgs: string[];
  durationSeconds: number;
  width: number | null;
  height: number | null;
}

/**
 * Sanitizes (not merely escapes) text bound for ffmpeg's drawtext filter. This text
 * ultimately originates from LLM-generated headlines/captions — untrusted input per
 * CLAUDE.md's standing rule. Rather than hand-rolling ffmpeg's fragile nested
 * quote-within-quote escaping (a real filter-graph-injection risk if gotten wrong), this
 * strips/replaces the handful of characters that are structurally meaningful to ffmpeg's
 * filtergraph parser — a small loss of text fidelity (a straight apostrophe becomes a
 * typographic one) in exchange for guaranteed safety.
 */
export function sanitizeDrawtextValue(text: string): string {
  return text
    .replace(/\\/g, "")
    .replace(/'/g, "\u2019")
    .replace(/:/g, "\u2013")
    .replace(/[[\];,]/g, "")
    .slice(0, 200);
}

/** Font paths are developer/system-controlled, not LLM output — correctness escaping, not
 * injection defense. */
function escapeFilterPathValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:");
}

function positionToY(position: TextOverlayInstruction["position"], targetHeight: number | null): string {
  const h = targetHeight ?? 1920;
  switch (position) {
    case "TOP":
      return String(Math.round(h * 0.08));
    case "CENTER":
      return "(h-text_h)/2";
    case "BOTTOM":
      return `h-${Math.round(h * 0.12)}-text_h`;
  }
}

function buildFilterComplex(instructions: RenderInstructions): {
  filterComplex: string;
  videoLabel: string;
  audioLabel: string;
} {
  const { segments, targetDimensions, textOverlays, fontPath, normalizeAudio } = instructions;
  const parts: string[] = [];

  let videoLabel: string;
  let audioLabel: string;

  if (segments.length === 1) {
    const seg = segments[0]!;
    parts.push(`[0:v]trim=start=${seg.startSeconds}:end=${seg.endSeconds},setpts=PTS-STARTPTS[v0]`);
    parts.push(`[0:a]atrim=start=${seg.startSeconds}:end=${seg.endSeconds},asetpts=PTS-STARTPTS[a0]`);
    videoLabel = "v0";
    audioLabel = "a0";
  } else {
    const pairLabels: string[] = [];
    segments.forEach((seg, i) => {
      parts.push(
        `[0:v]trim=start=${seg.startSeconds}:end=${seg.endSeconds},setpts=PTS-STARTPTS[v${i}]`,
      );
      parts.push(
        `[0:a]atrim=start=${seg.startSeconds}:end=${seg.endSeconds},asetpts=PTS-STARTPTS[a${i}]`,
      );
      pairLabels.push(`[v${i}][a${i}]`);
    });
    parts.push(`${pairLabels.join("")}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);
    videoLabel = "vcat";
    audioLabel = "acat";
  }

  if (targetDimensions) {
    const { width, height } = targetDimensions;
    parts.push(
      `[${videoLabel}]scale=w=${width}:h=${height}:force_original_aspect_ratio=increase,crop=${width}:${height}[vscaled]`,
    );
    videoLabel = "vscaled";
  }

  textOverlays.forEach((overlay, i) => {
    const nextLabel = `vtext${i}`;
    const fontSize = targetDimensions ? Math.round(targetDimensions.width * 0.06) : 48;
    const y = positionToY(overlay.position, instructions.targetDimensions?.height ?? null);
    parts.push(
      `[${videoLabel}]drawtext=fontfile='${escapeFilterPathValue(fontPath)}':` +
        `text='${sanitizeDrawtextValue(overlay.text)}':fontcolor=white:fontsize=${fontSize}:` +
        `x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.4:boxborderw=12:` +
        `enable='between(t,${overlay.startSeconds},${overlay.endSeconds})'[${nextLabel}]`,
    );
    videoLabel = nextLabel;
  });

  if (normalizeAudio) {
    parts.push(`[${audioLabel}]loudnorm=I=-16:TP=-1.5:LRA=11[anorm]`);
    audioLabel = "anorm";
  }

  return { filterComplex: parts.join(";"), videoLabel, audioLabel };
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        // Keep only the tail — ffmpeg's stderr is verbose progress logging; the actual error
        // is almost always in the last ~2000 chars.
        reject(new Error(`ffmpeg exited with code ${code}:\n${stderr.slice(-2000)}`));
      }
    });
  });
}

/**
 * Executes a validated EditPlan-derived instruction set deterministically via ffmpeg — the
 * renderer does not improvise; every effect must be explicit in `instructions`. See
 * /docs/DECISIONS.md for exactly which EditPlan capabilities this currently implements vs.
 * gracefully skips (B-roll, music/SFX, transitions — deferred pending an asset library).
 */
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

export async function renderVideo(instructions: RenderInstructions): Promise<RenderResult> {
  if (instructions.segments.length === 0) {
    throw new Error("RenderInstructions.segments must contain at least one segment.");
  }

  // Defense in depth: packages/agents' Edit Planner already validates segment bounds against
  // the source duration it was told about, but that duration could be stale (source file
  // changed) or the EditPlan could have been created/edited outside that path entirely.
  // ffmpeg's own trim filter does NOT error on an out-of-bounds end time — it silently
  // clamps to the available frames — so this check has to happen here, not just upstream.
  // Found by an integration test expecting a render to fail and observing it silently
  // succeed with a truncated clip instead — see /docs/DECISIONS.md.
  const sourceProbe = await probeMedia(instructions.sourcePath);
  const tolerance = 0.1; // frame-rounding slack
  for (const segment of instructions.segments) {
    if (segment.endSeconds > sourceProbe.durationSeconds + tolerance) {
      throw new RenderSegmentOutOfBoundsError(segment.endSeconds, sourceProbe.durationSeconds);
    }
  }

  const { filterComplex, videoLabel, audioLabel } = buildFilterComplex(instructions);

  const args = [
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
    "-movflags",
    "+faststart",
    instructions.outputPath,
  ];

  await runFfmpeg(args);

  const probed = await probeMedia(instructions.outputPath);

  return {
    outputPath: instructions.outputPath,
    ffmpegArgs: args,
    durationSeconds: probed.durationSeconds,
    width: probed.width,
    height: probed.height,
  };
}
