/**
 * Render a mini-movie.
 *   pnpm --filter @chris/cinema exec tsx scripts/make-film.ts [--film path.json] [--tier DRAFT|PREVIEW|FINAL]
 *        [--out dir] [--frames 0-120] [--silent] [--concurrency N]
 * Without --film it renders the proof film (src/films/the-raise.ts).
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PROOF_FILM, renderFilm, type Film } from "../src/index";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const film: Film = arg("film") ? (JSON.parse(await readFile(resolve(arg("film")!), "utf8")) as Film) : PROOF_FILM;
const tier = (arg("tier") ?? "DRAFT") as "DRAFT" | "PREVIEW" | "FINAL";
const out = resolve(arg("out") ?? join(process.cwd(), ".cache", "films", film.id));
const frames = arg("frames")?.split("-").map(Number) as [number, number] | undefined;
const t0 = Date.now();
const report = await renderFilm({
  film,
  outDir: out,
  tier,
  frameRange: frames,
  silent: process.argv.includes("--silent"),
  concurrency: arg("concurrency") ? Number(arg("concurrency")) : undefined,
  log: (m) => console.log(m),
});
console.log(JSON.stringify({ output: report.output, seconds: report.durationSeconds, frames: report.frames, stagesMs: report.stagesMs, msPerVideoSecond: report.renderMsPerVideoSecond, final: report.mix?.final, totalMs: Date.now() - t0 }, null, 2));
