import { FALLBACK_CATALOG } from "./catalog";
import { applyShot, initialWorld } from "./deterministic";
import { flattenShots, type StudioFilm, type StudioShot } from "./film-types";
import type { EngineIssue, EngineJob, EngineValidation, FilmCatalog, FilmEnginePort, NarratorVoice, RenderResult, ShotFacts, Still, StillMetrics, StoryboardResult } from "./engine-port";

/**
 * In-memory FilmEnginePort for tests and the dev "fake engine" mode. Jobs complete after
 * `pollsToFinish` polls; requests are de-duplicated by idempotency key (so a resumed pipeline
 * gets the same job back). Storyboard stills are SVG "animatic cards" drawn from the DSL state —
 * a sketch of what is on screen, not a render — so the UI and the crew room can be exercised
 * end to end without Chrome/WebGL.
 */

export const FAKE_VOICES: NarratorVoice[] = [
  { id: "am_michael", label: "Michael — warm, low", engine: "KOKORO", sampleUrl: null },
  { id: "af_heart", label: "Heart — bright, clear", engine: "KOKORO", sampleUrl: null },
  { id: "am_fenrir", label: "Fenrir — deep, dramatic", engine: "KOKORO", sampleUrl: null },
  { id: "bf_emma", label: "Emma — British, calm", engine: "KOKORO", sampleUrl: null },
  { id: "chris", label: "My voice — record the lines", engine: "CHRIS", sampleUrl: null, note: "You record each line; the engine syncs the picture to your words." },
];

/** Minimal structural validation (the real engine's validator is much stricter). */
export function fakeValidate(dsl: unknown): EngineValidation {
  const errors: EngineIssue[] = [];
  const d = dsl as Partial<StudioFilm> | null;
  if (!d || typeof d !== "object") return { ok: false, errors: [{ path: "(root)", message: "Film must be a JSON object." }], warnings: [] };
  if (d.dsl !== 1) errors.push({ path: "dsl", message: 'Must be 1.' });
  if (!Array.isArray(d.cast)) errors.push({ path: "cast", message: "Missing cast array." });
  if (!Array.isArray(d.scenes) || !d.scenes.length) errors.push({ path: "scenes", message: "Needs at least one scene." });
  const cast = new Set((d.cast ?? []).map((a) => a.id));
  (d.scenes ?? []).forEach((s, si) =>
    (s.shots ?? []).forEach((sh, hi) => {
      const p = `scenes[${si}].shots[${hi}]`;
      if (!sh.id) errors.push({ path: `${p}.id`, message: "Shot needs an id." });
      if (!sh.camera) errors.push({ path: `${p}.camera`, message: "Shot needs a camera." });
      if (!sh.line && sh.duration === undefined) errors.push({ path: `${p}.duration`, message: "Shot without a line needs a duration." });
      (sh.actions ?? []).forEach((a, ai) => {
        if (!cast.has(a.actor)) errors.push({ path: `${p}.actions[${ai}].actor`, message: `No actor "${a.actor}" in the cast.` });
        const at = a.at as { word?: string };
        if (at && typeof at === "object" && at.word && !(sh.line ?? "").toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).includes(at.word.toLowerCase())) errors.push({ path: `${p}.actions[${ai}].at.word`, message: `"${at.word}" is not a word of this shot's line.` });
      });
    }),
  );
  return errors.length ? { ok: false, errors, warnings: [] } : { ok: true, film: d as StudioFilm, warnings: [] };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/)) {
    if ((cur + " " + w).trim().length > max) {
      if (cur) out.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) out.push(cur);
  return out.slice(0, 3);
}

/** One 270×480 animatic card of what's on screen at `point` of the shot. */
export function sketchShotSvg(film: StudioFilm, shot: StudioShot, before: ReturnType<typeof initialWorld>, point: number, caption?: string): string {
  const after = applyShot(before, shot);
  const w = point > 0.5 ? after : before;
  const kinds = new Map(film.cast.map((a) => [a.id, a]));
  const visible = [...w].filter(([, s]) => s.visible).map(([id]) => id);
  const entering = (shot.actions ?? []).filter((a) => a.do === "ENTER").map((a) => a.actor);
  const ids = [...new Set([...visible, ...(point > 0.2 ? entering : [])])];
  const shapes: string[] = [];
  const xs = (i: number) => 40 + ((i + 0.5) * 190) / Math.max(1, ids.length);
  ids.forEach((id, i) => {
    const a = kinds.get(id);
    const x = xs(i);
    const st = w.get(id);
    switch (a?.kind) {
      case "COIN_STACK": {
        const h = Math.max(4, Math.min(140, (st?.count ?? 40) * 1.2));
        shapes.push(`<rect x="${x - 22}" y="${330 - h}" width="44" height="${h}" rx="6" fill="#E5B454"/><ellipse cx="${x}" cy="${330 - h}" rx="22" ry="6" fill="#F6D68A"/>`);
        break;
      }
      case "BUILDING":
        shapes.push(`<rect x="${x - 24}" y="230" width="48" height="100" fill="#2B2A33" stroke="#6B6880"/>${[0, 1, 2, 3].map((r) => `<rect x="${x - 16}" y="${242 + r * 22}" width="10" height="10" fill="#F2C46B"/><rect x="${x + 6}" y="${242 + r * 22}" width="10" height="10" fill="#F2C46B"/>`).join("")}`);
        break;
      case "CAR":
        shapes.push(`<rect x="${x - 30}" y="305" width="60" height="22" rx="9" fill="#3A3946"/><circle cx="${x - 18}" cy="329" r="6" fill="#111"/><circle cx="${x + 18}" cy="329" r="6" fill="#111"/>`);
        break;
      case "BASELINE": {
        const lvl = st?.level ?? 0;
        const y = 336 - Math.min(200, lvl * 80);
        shapes.push(`<rect x="10" y="${y - 3}" width="250" height="6" rx="3" fill="#9B8CFF" opacity="0.9"/><text x="135" y="${y - 10}" font-size="10" fill="#C9C1FF" text-anchor="middle" font-family="sans-serif">${esc(String(a.params?.label ?? "BASELINE"))}</text>`);
        break;
      }
      case "COIN_CHART":
        shapes.push([0, 1, 2, 3, 4, 5].map((k) => `<rect x="${x - 40 + k * 14}" y="${330 - (k + 1) * 18}" width="10" height="${(k + 1) * 18}" fill="#E5B454"/>`).join(""));
        break;
      case "CARD":
      case "CARD_FAN":
        shapes.push(`<rect x="${x - 26}" y="250" width="52" height="34" rx="5" fill="#F5F0E6" opacity="0.9"/><rect x="${x - 12}" y="200" width="52" height="34" rx="5" fill="#F5F0E6" opacity="0.6"/>`);
        break;
      case "PEDESTAL":
        shapes.push(`<rect x="${x - 34}" y="330" width="68" height="18" fill="#47454F"/>`);
        break;
      case "LIGHT_SHAFT":
        shapes.push(`<polygon points="${x - 14},40 ${x + 14},40 ${x + 50},340 ${x - 50},340" fill="#FFF3D1" opacity="0.12"/>`);
        break;
      default:
        shapes.push(`<circle cx="${x}" cy="300" r="16" fill="#5E5B6E"/>`);
    }
  });
  const texts = (shot.text ?? []).filter((t) => t.style !== "FOOTNOTE").slice(0, 2).map((t, i) => `<text x="135" y="${80 + i * 34}" font-size="${t.style === "HERO_NUMBER" ? 28 : 15}" font-weight="700" fill="${t.style === "HERO_NUMBER" ? "#F6D68A" : "#F5F0E6"}" text-anchor="middle" font-family="sans-serif">${esc(t.text.replace("|", " "))}</text>`);
  const cap = (caption ?? shot.line ?? "").trim();
  const capLines = wrap(cap, 34).map((l, i) => `<text x="135" y="${414 + i * 16}" font-size="12" fill="#F5F0E6" text-anchor="middle" font-family="sans-serif">${esc(l)}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="270" height="480" viewBox="0 0 270 480"><rect width="270" height="480" fill="#0E0D12"/><rect x="0" y="336" width="270" height="56" fill="#16151C"/>${shapes.join("")}${texts.join("")}<rect x="0" y="392" width="270" height="88" fill="#000" opacity="0.55"/>${capLines.join("")}<text x="10" y="20" font-size="10" fill="#8F8BA3" font-family="monospace">${esc(shot.id)} · ${esc(shot.camera.rig)}</text></svg>`;
}

export const svgDataUrl = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

export interface FakeEngineOptions {
  validate?: (dsl: unknown) => EngineValidation;
  formatIssues?: (issues: EngineIssue[]) => string;
  catalog?: FilmCatalog;
  voices?: NarratorVoice[];
  pollsToFinish?: number;
  failStoryboards?: number;
  failRenders?: number;
  stillMetrics?: (shotId: string) => StillMetrics | undefined;
  videoUrl?: string | null;
  loudnessLufs?: number;
  storyboard?: boolean;
  render?: boolean;
}

export class FakeFilmEngine implements FilmEnginePort {
  readonly name = "fake";
  private jobs = new Map<string, EngineJob & { polls: number; film: StudioFilm; tier?: "PREVIEW" | "FINAL" }>();
  private byKey = new Map<string, string>();
  private failS: number;
  private failR: number;
  requests: Array<{ kind: string; key: string }> = [];

  constructor(private readonly opts: FakeEngineOptions = {}) {
    this.failS = opts.failStoryboards ?? 0;
    this.failR = opts.failRenders ?? 0;
  }

  capabilities() {
    return { storyboard: this.opts.storyboard ?? true, render: this.opts.render ?? true, chrisNarration: true, note: "fake engine (sketch storyboards)" };
  }
  validateFilm(dsl: unknown) {
    return (this.opts.validate ?? fakeValidate)(dsl);
  }
  formatIssues(issues: EngineIssue[]) {
    return this.opts.formatIssues ? this.opts.formatIssues(issues) : issues.map((i) => `- ${i.path}: ${i.message}${i.hint ? ` (hint: ${i.hint})` : ""}`).join("\n");
  }
  getCatalog() {
    return this.opts.catalog ?? FALLBACK_CATALOG;
  }
  listVoices() {
    return this.opts.voices ?? FAKE_VOICES;
  }
  describeShots(film: StudioFilm): ShotFacts[] {
    let w = initialWorld(film);
    const kinds = new Map(film.cast.map((a) => [a.id, a.kind]));
    return flattenShots(film).map(({ shot }) => {
      const after = applyShot(w, shot);
      const facts: ShotFacts = {
        shotId: shot.id,
        actors: [...after].map(([id, s]) => ({ id, kind: kinds.get(id) ?? "?", visible: s.visible || w.get(id)?.visible === true, inFrame: null, changes: (shot.actions ?? []).filter((a) => a.actor === id).map((a) => a.do) })),
        cameraTarget: JSON.stringify(shot.camera.target),
        cameraMove: shot.camera.rig,
        textOnScreen: (shot.text ?? []).map((t) => t.text),
      };
      w = after;
      return facts;
    });
  }

  private makeJob(kind: "STORYBOARD" | "RENDER", key: string, film: StudioFilm, tier?: "PREVIEW" | "FINAL") {
    this.requests.push({ kind, key });
    const existing = this.byKey.get(key);
    if (existing) return { jobId: existing };
    const id = `job_${this.jobs.size + 1}`;
    this.jobs.set(id, { id, kind, status: "QUEUED", polls: 0, film, tier });
    this.byKey.set(key, id);
    return { jobId: id };
  }

  async requestStoryboard(input: { film: StudioFilm; idempotencyKey: string }) {
    return this.makeJob("STORYBOARD", input.idempotencyKey, input.film);
  }
  async requestRender(input: { film: StudioFilm; tier: "PREVIEW" | "FINAL"; idempotencyKey: string }) {
    return this.makeJob("RENDER", input.idempotencyKey, input.film, input.tier);
  }

  stillsFor(film: StudioFilm, points = [0.6]): StoryboardResult {
    let w = initialWorld(film);
    const stills: Still[] = [];
    const cells: string[] = [];
    for (const { shot } of flattenShots(film)) {
      for (const p of points) {
        const svg = sketchShotSvg(film, shot, w, p);
        stills.push({ id: `${shot.id}@${p}`, shotId: shot.id, point: p, url: svgDataUrl(svg), caption: shot.line, metrics: this.opts.stillMetrics?.(shot.id) });
        cells.push(svg);
      }
      w = applyShot(w, shot);
    }
    const cols = 4;
    const rows = Math.ceil(cells.length / cols);
    const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * 276}" height="${rows * 486}"><rect width="100%" height="100%" fill="#050507"/>${cells.map((c, i) => `<g transform="translate(${(i % cols) * 276 + 3},${Math.floor(i / cols) * 486 + 3})">${c.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}</g>`).join("")}</svg>`;
    return { stills, contactSheetUrl: svgDataUrl(sheet) };
  }

  async getJob(jobId: string): Promise<EngineJob | null> {
    const j = this.jobs.get(jobId);
    if (!j) return null;
    if (j.status === "DONE" || j.status === "FAILED") return j;
    j.polls++;
    if (j.polls < (this.opts.pollsToFinish ?? 1)) {
      j.status = "RUNNING";
      j.progressPct = Math.round((j.polls / (this.opts.pollsToFinish ?? 1)) * 100);
      return { ...j };
    }
    if (j.kind === "STORYBOARD") {
      if (this.failS > 0) {
        this.failS--;
        Object.assign(j, { status: "FAILED", error: "WebGL context lost (fake)" });
        return j;
      }
      Object.assign(j, { status: "DONE", progressPct: 100, storyboard: this.stillsFor(j.film) });
      return j;
    }
    if (this.failR > 0) {
      this.failR--;
      Object.assign(j, { status: "FAILED", error: "renderer crashed (fake)" });
      return j;
    }
    const sb = this.stillsFor(j.film, [0.5]);
    const render: RenderResult = {
      tier: j.tier ?? "FINAL",
      videoUrl: this.opts.videoUrl ?? null,
      posterUrl: sb.stills[0]?.url ?? null,
      durationSeconds: flattenShots(j.film).reduce((s, f) => s + Math.max(0.6, (f.shot.line?.split(/\s+/).length ?? 0) / 2.6) + (f.shot.hold ?? 0), 0),
      loudnessLufs: this.opts.loudnessLufs ?? -14,
      truePeakDbtp: -1.5,
      frames: sb.stills,
      contactSheetUrl: sb.contactSheetUrl,
    };
    Object.assign(j, { status: "DONE", progressPct: 100, render });
    return j;
  }
}
