/**
 * CLI: compute a person matte for a video (quality loop / debugging).
 *   pnpm --filter @chris/media exec tsx scripts/compute-matte.ts <video> <out.mp4> [fps]
 */
import { computePersonMatte } from "../src/person-matte";

const [input, output, fps] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: compute-matte.ts <video> <out.mp4> [fps]");
  process.exit(2);
}
const res = await computePersonMatte(input, output, { fps: fps ? Number(fps) : undefined });
console.log(JSON.stringify({ ...res, fpsAchieved: Math.round((res.frames / (res.ms / 1000)) * 10) / 10 }));
