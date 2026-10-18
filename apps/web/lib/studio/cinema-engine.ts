import * as cinema from "@chris/cinema/pure";
import { actorCenterHeight, compileFilm, evaluateFrame, formatIssues as cinemaFormatIssues, resolveFilm, validateFilm as cinemaValidateFilm, type Film } from "@chris/cinema/pure";
import {
  FALLBACK_CATALOG,
  type CatalogEntry,
  type EngineIssue,
  type EngineJob,
  type EngineValidation,
  type FilmCatalog,
  type FilmEnginePort,
  type NarratorVoice,
  type ShotFacts,
  type StudioFilm,
} from "@chris/agents/studio";

/**
 * SERVER-ONLY. The thin adapter from the studio's FilmEnginePort onto the real engine
 * (packages/cinema + its heavy jobs). What is wired today and what isn't:
 *
 *  - validateFilm / formatIssues — REAL (`@chris/cinema/pure` validateFilm, the engine's own
 *    validator with "did you mean" hints for the repair loop).
 *  - describeShots — REAL: the engine's pure evaluator (compileFilm + evaluateFrame) at 60% of
 *    each shot, with a pinhole projection of every visible actor's centre into the 9:16 frame →
 *    `inFrame` (feeds the Meaning-Match "is the rising baseline actually in frame" rule).
 *  - getCatalog — the engine's machine-readable catalog when it exports one (`FILM_CATALOG` or
 *    `getFilmCatalog()`), else the studio's fallback catalog of the DSL v1 vocabulary.
 *    TODO(engine): export FILM_CATALOG from @chris/cinema/pure as { version, entries: CatalogEntry[] }.
 *  - listVoices — the Kokoro voices with audition samples in docs/evidence (▶ via
 *    /api/studio/voices/[id]) + "My voice". TODO(engine): export a KOKORO_VOICES list.
 *  - requestStoryboard / requestRender / getJob — heavy-job kinds `film-storyboard` / `film-render`
 *    (apps/worker, being built alongside). Until those kinds exist, capabilities() says so in plain
 *    words and the pipeline continues without stills (the review pack then judges the DSL only) /
 *    stops before render with a clear message. TODO(engine): see `HEAVY_ARGS` below for the exact
 *    args/result shape the studio expects; wire `dispatch` to runHeavyJob.
 */

/** The engine's curated narrators (KOKORO_VOICES: chosen from all 28 Kokoro English voices by
 * the model card's grades + a measured audition; ▶ samples in packages/cinema/assets/voice-samples). */
export const STUDIO_VOICES: NarratorVoice[] = [
  ...cinema.KOKORO_VOICES.map((v) => ({ id: v.id, label: `${v.label} — ${v.vibe.split(/[.—]/)[0]!.trim().toLowerCase()} (${v.accent})`, engine: "KOKORO" as const, sampleUrl: `/api/studio/voices/${v.id}`, note: v.vibe })),
  { id: "chris", label: "My voice — record the lines", engine: "CHRIS", sampleUrl: null, note: "You record each line on your phone; the engine syncs the picture to your words." },
];

/** What the studio sends the heavy jobs (documented for the engine side). */
export const HEAVY_ARGS = {
  "film-storyboard": "{ filmId, versionId, film: <validated DSL>, shotIds?: string[], points?: [0.6], idempotencyKey } → result { stills: [{ id, shotId, point, url, caption, metrics? }], contactSheetUrl (JPEG with the line under each still) }",
  "film-render": "{ filmId, versionId, film, tier: 'PREVIEW'|'FINAL', chrisNarration?: { [shotId]: mediaKey }, idempotencyKey } → result { videoUrl, posterUrl, durationSeconds, loudnessLufs, truePeakDbtp, frames: Still[], contactSheetUrl, contentItemId?, renderId? }",
} as const;

export interface HeavyDispatch {
  /** Starts (or joins, by idempotency key) a heavy job; null when the kind isn't available. */
  start(kind: "film-storyboard" | "film-render", args: Record<string, unknown>): Promise<{ jobId: string } | null>;
  get(jobId: string): Promise<EngineJob | null>;
  has(kind: "film-storyboard" | "film-render"): boolean;
}

const vsub = (a: number[], b: number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const norm = (a: number[]) => {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1;
  return [a[0]! / l, a[1]! / l, a[2]! / l];
};

/** Pinhole projection: is world point p inside the 9:16 frame of a camera? (5% margin). */
export function pointInFrame(cam: { position: number[]; lookAt: number[]; fov: number }, p: number[], aspect = 9 / 16): boolean {
  const f = norm(vsub(cam.lookAt, cam.position));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const d = vsub(p, cam.position);
  const z = dot(d, f);
  if (z <= 0.05) return false;
  const th = Math.tan((cam.fov * Math.PI) / 360);
  return Math.abs(dot(d, r) / z) <= th * aspect * 1.05 && Math.abs(dot(d, u) / z) <= th * 1.05;
}

export class CinemaFilmEngine implements FilmEnginePort {
  readonly name = "cinema";
  constructor(private readonly heavy: HeavyDispatch | null = null) {}

  capabilities() {
    const sb = !!this.heavy?.has("film-storyboard");
    const r = !!this.heavy?.has("film-render");
    return { storyboard: sb, render: r, chrisNarration: r, note: sb && r ? undefined : "the storyboard/render workers for mini-movies aren't connected yet" };
  }

  validateFilm(dsl: unknown): EngineValidation {
    const r = cinemaValidateFilm(dsl);
    return r.ok ? { ok: true, film: r.film as unknown as StudioFilm, warnings: r.warnings } : { ok: false, errors: r.errors, warnings: r.warnings };
  }

  formatIssues(issues: EngineIssue[]) {
    return cinemaFormatIssues(issues);
  }

  getCatalog(): FilmCatalog {
    const mod = cinema as unknown as Record<string, unknown>;
    const fromEngine = (typeof mod.getFilmCatalog === "function" ? (mod.getFilmCatalog as () => unknown)() : mod.FILM_CATALOG) as { version?: string; entries?: CatalogEntry[] } | undefined;
    if (fromEngine && Array.isArray(fromEngine.entries) && fromEngine.entries.length) return { version: String(fromEngine.version ?? "engine"), entries: fromEngine.entries };
    return FALLBACK_CATALOG;
  }

  listVoices() {
    return STUDIO_VOICES;
  }

  describeShots(film: StudioFilm): ShotFacts[] {
    try {
      const rf = resolveFilm(film as unknown as Film, null);
      const cf = compileFilm(rf);
      return rf.shots.map((rs) => {
        const frame = Math.min(rs.endFrame - 1, Math.round(rs.startFrame + (rs.endFrame - rs.startFrame) * 0.6));
        const st = evaluateFrame(cf, frame);
        const actions = rs.shot.actions ?? [];
        return {
          shotId: rs.shot.id,
          actors: st.actors.map((a) => {
            const center = [a.position[0], a.position[1] + actorCenterHeight(a.kind, a.params as Record<string, unknown>) * a.scale, a.position[2]];
            const visible = a.visible && a.exit < 1;
            return { id: a.id, kind: a.kind, visible, inFrame: visible ? pointInFrame(st.camera, center) : false, changes: actions.filter((x) => x.actor === a.id).map((x) => x.do) };
          }),
          cameraTarget: JSON.stringify(rs.shot.camera.target),
          cameraMove: rs.shot.camera.rig,
          textOnScreen: st.texts.map((t) => t.display),
        };
      });
    } catch {
      return [];
    }
  }

  async requestStoryboard(input: { filmId: string; versionId: string; film: StudioFilm; shotIds?: string[]; idempotencyKey: string }) {
    const r = await this.heavy?.start("film-storyboard", { ...input, points: [0.6] });
    if (!r) throw new Error("The storyboard worker isn't connected yet.");
    return r;
  }

  async requestRender(input: { filmId: string; versionId: string; film: StudioFilm; tier: "PREVIEW" | "FINAL"; chrisNarration?: Record<string, string> | null; idempotencyKey: string }) {
    const r = await this.heavy?.start("film-render", input);
    if (!r) throw new Error("The render worker isn't connected yet.");
    return r;
  }

  async getJob(jobId: string) {
    return this.heavy ? this.heavy.get(jobId) : null;
  }
}
