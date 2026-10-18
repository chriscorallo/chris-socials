import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * SERVER-ONLY. Mini-movie proof films rendered by @chris/cinema (scripts/make-film.ts) live on
 * disk — CINEMA_FILMS_DIR, else <repo>/.cache/films/<filmId>/<filmId>-<tier>.mp4 with a
 * report-<tier>.json beside it. Labs only: nothing here touches the database or Blob.
 */

export interface LabsFilm {
  id: string;
  file: string;
  tier: string;
  sizeBytes: number;
  renderedAt: string;
  durationSeconds: number | null;
  loudnessLufs: number | null;
}

export function findFilmsDir(): string | null {
  if (process.env.CINEMA_FILMS_DIR) return existsSync(process.env.CINEMA_FILMS_DIR) ? process.env.CINEMA_FILMS_DIR : null;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    for (const c of [join(dir, ".cache", "films"), join(dir, "packages", "cinema", ".cache", "films")]) if (existsSync(c)) return c;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const SAFE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FILE = /^([a-z0-9][a-z0-9_-]{0,63})-(draft|preview|final)\.mp4$/;

export function listLabsFilms(): LabsFilm[] {
  const root = findFilmsDir();
  if (!root) return [];
  const out: LabsFilm[] = [];
  for (const id of readdirSync(root)) {
    if (!SAFE.test(id)) continue;
    const dir = join(root, id);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      const m = f.match(FILE);
      if (!m || m[1] !== id) continue;
      const st = statSync(join(dir, f));
      let durationSeconds: number | null = null;
      let loudnessLufs: number | null = null;
      try {
        const r = JSON.parse(readFileSync(join(dir, `report-${m[2]}.json`), "utf8")) as { durationSeconds?: number; mix?: { final?: { integratedLufs?: number } } };
        durationSeconds = r.durationSeconds ?? null;
        loudnessLufs = r.mix?.final?.integratedLufs ?? null;
      } catch {
        // no report — still listable
      }
      out.push({ id, file: f, tier: m[2]!, sizeBytes: st.size, renderedAt: st.mtime.toISOString(), durationSeconds, loudnessLufs });
    }
  }
  return out.sort((a, b) => b.renderedAt.localeCompare(a.renderedAt));
}

/** Absolute path of a listed film file, or null (whitelisted names only — never a raw path). */
export function labsFilmPath(id: string, file: string): string | null {
  const root = findFilmsDir();
  if (!root || !SAFE.test(id)) return null;
  const m = file.match(FILE);
  if (!m || m[1] !== id) return null;
  const p = join(root, id, file);
  return existsSync(p) ? p : null;
}
