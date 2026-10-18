/**
 * Storyboard stills of a film (fast framing/lighting check).
 *   pnpm --filter @chris/cinema exec tsx scripts/storyboard.ts <outDir> [--film film.json] [--tier PREVIEW] [--shots a,b]
 *        [--stills 1|2|3] [--points 0.2,0.8] [--scale 0.5] [--clips clips.json]
 */
import { readFile } from "node:fs/promises";
import { PROOF_FILM } from "../src/films/the-raise";
import { renderStoryboard } from "../src/storyboard";

const out = process.argv[2]!;
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const film = arg("film") ? JSON.parse(await readFile(arg("film")!, "utf8")) : PROOF_FILM;
const clips = arg("clips") ? JSON.parse(await readFile(arg("clips")!, "utf8")) : null;
const r = await renderStoryboard({
  film,
  clips,
  outDir: out,
  tier: (arg("tier") ?? "PREVIEW") as "PREVIEW",
  shots: arg("shots")?.split(","),
  points: arg("points")?.split(",").map(Number),
  stillsPerShot: arg("stills") ? Number(arg("stills")) : undefined,
  scale: arg("scale") ? Number(arg("scale")) : undefined,
});
console.log(JSON.stringify({ sheet: r.sheet, stills: r.stills.length, shots: r.shots.length, ms: r.ms, durationSeconds: r.durationSeconds }));
