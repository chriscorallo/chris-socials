import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Film } from "./dsl/schema";
import { getCinemaBundle, rendererGl } from "./render";
import { resolveFilm, resolveAnchor, type LineClip, type ResolvedFilm, type ResolvedShot } from "./timing";
import type { FilmTier as Tier } from "./chunks";
import { runFfmpeg } from "./audio/ffmpeg";
import { compileFilm, evaluateFrame } from "./evaluate";
import { LOOK_DEFS } from "./looks";
import { bandOf } from "./text-bands";
import { captionedContactSheet, measureStill, type StillMetricsResult, type StillTextInfo } from "./sheets";

/**
 * Storyboard: a few keyframe stills per shot instead of the whole film — one browser, one page
 * load, the chosen frames only (Remotion `frames`), at reduced size by default — so a director
 * (the crew, or Chris) can judge framing, lighting and text cheaply before paying for a full
 * render. Each shot comes back with its timing and the narration words it covers.
 */

export interface StoryboardStill {
  frame: number;
  /** Film seconds. */
  time: number;
  path: string;
  /** 0..1 position inside the shot. */
  point: number;
  /** Pixel metrics for the Quality checks (contrast per text band, empty frame, mean light). */
  metrics?: StillMetricsResult;
}

/** The on-screen text of a frame (band + color as drawn) — for contrast measurement. */
export function textInfoAt(film: Film, cf: ReturnType<typeof compileFilm>, frame: number): StillTextInfo[] {
  const st = evaluateFrame(cf, frame);
  const look = LOOK_DEFS[film.look];
  return st.texts.filter((t) => t.enter > 0.6 && t.exit < 0.4).map((t) => ({ band: bandOf(t.beat), color: t.beat.accent || t.beat.style === "HERO_NUMBER" ? look.goldLight : look.cream }));
}

export interface StoryboardShot {
  shotId: string;
  index: number;
  sceneId: string;
  startSec: number;
  endSec: number;
  purpose: string | null;
  /** The narration line spoken in this shot (as written) — null for lineless shots. */
  line: string | null;
  /** Its words with film times (measured when narration clips were given, else estimated). */
  words: Array<{ word: string; start: number; end: number }>;
  stills: StoryboardStill[];
}

export interface StoryboardResult {
  shots: StoryboardShot[];
  /** All stills tiled into one JPEG contact sheet, the narration line under each still. */
  sheet: string;
  stills: string[];
  timingMeasured: boolean;
  durationSeconds: number;
  ms: number;
}

/**
 * Which frames of a shot tell its story: by default the moment its main action has landed —
 * the latest action/text anchor (+0.5 s) inside the shot, else the middle — and, for
 * `stillsPerShot` ≥ 2, the opening and the end too. Pure.
 */
export function keyframesForShot(rf: ResolvedFilm, rs: ResolvedShot, stillsPerShot = 1): number[] {
  const len = rs.endFrame - rs.startFrame;
  const clampF = (f: number) => Math.max(rs.startFrame, Math.min(rs.endFrame - 1, Math.round(f)));
  const anchors = [...(rs.shot.actions ?? []).map((a) => resolveAnchor(rs, a.at) + Math.min(1.2, (a.duration ?? 0.9) * 0.8)), ...(rs.shot.text ?? []).map((t) => resolveAnchor(rs, t.at) + 0.5)].filter((s) => s > rs.startSec && s < rs.endSec);
  const key = anchors.length ? clampF(Math.max(...anchors) * rf.fps) : clampF(rs.startFrame + len * 0.55);
  if (stillsPerShot <= 1) return [key];
  const first = clampF(rs.startFrame + len * 0.12);
  const last = clampF(rs.startFrame + len * 0.92);
  const set = stillsPerShot === 2 ? [first, key] : [first, key, last];
  return [...new Set(set)].sort((a, b) => a - b);
}

export async function renderStoryboard(input: {
  film: Film;
  clips?: Record<string, LineClip> | null;
  outDir: string;
  tier?: Tier;
  /** 1–3 stills per shot (default 1: the moment the shot's action lands). */
  stillsPerShot?: number;
  /** Override: fractions of each shot instead of keyframe selection. */
  points?: number[];
  shots?: string[];
  /** Output scale (0.5 = 540×960 for a 1080×1920 film; default 0.5). */
  scale?: number;
  concurrency?: number | null;
  onProgress?: (done: number, total: number) => void;
}): Promise<StoryboardResult> {
  const t0 = Date.now();
  const { renderFrames, selectComposition, openBrowser, ensureBrowser } = await import("@remotion/renderer");
  const { findLocalHeadlessShell } = await import("@chris/motion");
  const rf = resolveFilm(input.film, input.clips ?? null);
  const tier = input.tier ?? "PREVIEW";
  await mkdir(input.outDir, { recursive: true });
  const plan: Array<{ rs: ResolvedShot; frames: number[] }> = [];
  for (const rs of rf.shots) {
    if (input.shots && !input.shots.includes(rs.shot.id)) continue;
    const frames = input.points
      ? [...new Set(input.points.map((p) => Math.min(rs.endFrame - 1, Math.round(rs.startFrame + (rs.endFrame - rs.startFrame) * p))))]
      : keyframesForShot(rf, rs, input.stillsPerShot ?? 1);
    plan.push({ rs, frames });
  }
  const allFrames = [...new Set(plan.flatMap((p) => p.frames))].sort((a, b) => a - b);
  const serveUrl = await getCinemaBundle();
  const gl = rendererGl();
  const exe = findLocalHeadlessShell();
  if (!exe) await ensureBrowser();
  const browser = await openBrowser("chrome", { browserExecutable: exe, chromiumOptions: { gl } });
  const inputProps = { film: input.film, clips: input.clips ?? null, tier, fontBaseUrl: null };
  const pathOf = (f: number) => join(input.outDir, `frame-${String(f).padStart(5, "0")}.jpg`);
  const writes: Array<Promise<void>> = [];
  try {
    const composition = await selectComposition({ serveUrl, id: "MiniMovie", inputProps, puppeteerInstance: browser, chromiumOptions: { gl }, logLevel: "error" });
    let done = 0;
    await renderFrames({
      serveUrl,
      composition,
      inputProps,
      frames: allFrames,
      outputDir: null,
      imageFormat: "jpeg",
      jpegQuality: 85,
      scale: input.scale ?? 0.5,
      concurrency: input.concurrency ?? null,
      puppeteerInstance: browser,
      chromiumOptions: { gl },
      logLevel: "error",
      timeoutInMilliseconds: 120000,
      onStart: () => undefined,
      onFrameUpdate: () => undefined,
      onFrameBuffer: (buf, frame) => {
        writes.push(writeFile(pathOf(frame), buf));
        input.onProgress?.(++done, allFrames.length);
      },
    });
    await Promise.all(writes);
  } finally {
    await browser.close({ silent: true }).catch(() => undefined);
  }
  const cf = compileFilm(rf);
  const shots: StoryboardShot[] = [];
  for (const { rs, frames } of plan) {
    const stills: StoryboardStill[] = [];
    for (const f of frames) {
      const metrics = await measureStill(pathOf(f), textInfoAt(input.film, cf, f)).catch(() => undefined);
      stills.push({ frame: f, time: f / rf.fps, path: pathOf(f), point: Math.round(((f - rs.startFrame) / Math.max(1, rs.endFrame - rs.startFrame)) * 100) / 100, ...(metrics ? { metrics } : {}) });
    }
    shots.push({ shotId: rs.shot.id, index: rs.index, sceneId: rs.sceneId, startSec: rs.startSec, endSec: rs.endSec, purpose: rs.shot.purpose ?? null, line: rs.shot.line ?? null, words: rs.words.map((w) => ({ word: w.raw, start: w.start, end: w.end })), stills });
  }
  const stills = shots.flatMap((s) => s.stills.map((x) => x.path));
  const sheet = join(input.outDir, "storyboard.jpg");
  if (stills.length) await captionedContactSheet(shots.flatMap((s) => s.stills.map((x) => ({ path: x.path, caption: s.line ?? "", label: `${s.index + 1} · ${s.shotId}` }))), sheet, { cols: 4, workDir: join(input.outDir, "sheet-work") });
  return { shots, sheet, stills, timingMeasured: rf.measured, durationSeconds: rf.durationSeconds, ms: Date.now() - t0 };
}

/**
 * Frames of a RENDERED film for the final review: one per shot at its key moment (the same
 * keyframe rule as the storyboard), measured, plus a captioned JPEG contact sheet and a poster
 * (the hook's keyframe). No browser — decoded from the video with ffmpeg.
 */
export async function framesFromVideo(input: { film: Film; clips: Record<string, LineClip> | null; videoPath: string; outDir: string }): Promise<{ shots: StoryboardShot[]; sheet: string; poster: string }> {
  await mkdir(input.outDir, { recursive: true });
  const rf = resolveFilm(input.film, input.clips);
  const cf = compileFilm(rf);
  const shots: StoryboardShot[] = [];
  for (const rs of rf.shots) {
    const f = keyframesForShot(rf, rs, 1)[0]!;
    const path = join(input.outDir, `final-${String(f).padStart(5, "0")}.jpg`);
    await runFfmpeg(["-ss", (f / rf.fps + 0.5 / rf.fps).toFixed(4), "-i", input.videoPath, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "3", path]);
    const metrics = await measureStill(path, textInfoAt(input.film, cf, f)).catch(() => undefined);
    shots.push({ shotId: rs.shot.id, index: rs.index, sceneId: rs.sceneId, startSec: rs.startSec, endSec: rs.endSec, purpose: rs.shot.purpose ?? null, line: rs.shot.line ?? null, words: rs.words.map((w) => ({ word: w.raw, start: w.start, end: w.end })), stills: [{ frame: f, time: f / rf.fps, path, point: Math.round(((f - rs.startFrame) / Math.max(1, rs.endFrame - rs.startFrame)) * 100) / 100, ...(metrics ? { metrics } : {}) }] });
  }
  const sheet = join(input.outDir, "final-sheet.jpg");
  await captionedContactSheet(shots.map((s) => ({ path: s.stills[0]!.path, caption: s.line ?? "", label: `${s.index + 1} · ${s.shotId}` })), sheet, { cols: 4, workDir: join(input.outDir, "final-sheet-work") });
  return { shots, sheet, poster: shots[0]?.stills[0]?.path ?? sheet };
}
