/**
 * Storyboard stills of a film (fast framing/lighting check).
 *   pnpm --filter @chris/cinema exec tsx scripts/storyboard.ts <outDir> [--tier DRAFT] [--shots a,b] [--timing timing-clips.json]
 */
import { readFile } from "node:fs/promises";
import { PROOF_FILM } from "../src/films/the-raise";
import { renderStoryboard } from "../src/storyboard";

const out = process.argv[2]!;
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const clips = arg("clips") ? JSON.parse(await readFile(arg("clips")!, "utf8")) : null;
const r = await renderStoryboard({ film: PROOF_FILM, clips, outDir: out, tier: (arg("tier") ?? "DRAFT") as "DRAFT", shots: arg("shots")?.split(","), points: arg("points")?.split(",").map(Number) });
console.log(r.sheet);
