/**
 * Director's review sheets: frames every `--every` seconds (default 0.5) with timecodes, tiled
 * into contact sheets, plus the safe-zone overlay on each frame so text under platform UI is
 * obvious at a glance.
 *   pnpm --filter @chris/cinema exec tsx scripts/contact-sheet.ts <film.mp4> <outDir> [--every 0.5] [--cols 6] [--width 270]
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runFfmpeg, probeDurationSeconds } from "../src/audio/ffmpeg";

const [input, out] = process.argv.slice(2);
if (!input || !out) throw new Error("usage: contact-sheet.ts <film.mp4> <outDir>");
const arg = (n: string, d: number) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const every = arg("every", 0.5);
const cols = arg("cols", 6);
const w = arg("width", 270);
await mkdir(out, { recursive: true });
const dur = await probeDurationSeconds(input);
const n = Math.floor(dur / every);
const perSheet = cols * 4;
// safe zones (1080x1920 reference): top 250, bottom 420, right 140, left 60 — drawn as thin red lines
const safe = `drawbox=x=iw*60/1080:y=ih*250/1920:w=iw*880/1080:h=ih*1250/1920:color=red@0.55:t=2`;
const label = `drawtext=text='%{eif\\:t*${1 / every}*${every}\\:d\\:1}':x=8:y=8:fontsize=h/34:fontcolor=white:box=1:boxcolor=black@0.6`;
void label;
for (let s = 0; s * perSheet < n; s++) {
  const start = s * perSheet * every;
  const len = Math.min(perSheet * every, dur - start);
  const sheet = join(out, `sheet-${String(s + 1).padStart(2, "0")}.jpg`);
  await runFfmpeg([
    "-ss",
    start.toFixed(3),
    "-t",
    len.toFixed(3),
    "-i",
    input,
    "-vf",
    `fps=${1 / every},${safe},scale=${w}:-2,drawtext=text='%{pts\\:hms\\:${start.toFixed(3)}}':x=6:y=6:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6,tile=${cols}x4:padding=4:margin=4:color=0x111111`,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    sheet,
  ]);
  console.log(sheet);
}
