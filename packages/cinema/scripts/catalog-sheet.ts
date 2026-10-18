/**
 * Renders every catalog example (one still each, at 70 % of its shot) and tiles them into labeled
 * contact sheets — the visual check that each vocabulary item reads as what it claims to depict.
 *   pnpm --filter @chris/cinema exec tsx scripts/catalog-sheet.ts <outDir> [--types ACTOR,RECIPE,SET] [--ids A,B] [--tier PREVIEW] [--at 0.7]
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { findLocalHeadlessShell } from "@chris/motion";
import { VISUAL_CATALOG, catalogExampleFilm } from "../src/catalog";
import { getCinemaBundle, rendererGl } from "../src/render";
import { resolveFilm } from "../src/timing";
import { runFfmpeg } from "../src/audio/ffmpeg";

const out = process.argv[2]!;
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const types = (arg("types") ?? "ACTOR,RECIPE,SET").split(",");
const ids = arg("ids")?.split(",");
const tier = (arg("tier") ?? "PREVIEW") as "PREVIEW";
const at = Number(arg("at") ?? 0.7);
await mkdir(out, { recursive: true });
const { renderStill, selectComposition, openBrowser } = await import("@remotion/renderer");
const serveUrl = await getCinemaBundle();
const gl = rendererGl();
const browser = await openBrowser("chrome", { browserExecutable: findLocalHeadlessShell(), chromiumOptions: { gl } });
const entries = VISUAL_CATALOG.filter((e) => types.includes(e.type) && (!ids || ids.includes(e.id)));
const t0 = Date.now();
let i = 0;
for (const e of entries) {
  const film = catalogExampleFilm(e, { width: 540, height: 960 });
  const rf = resolveFilm(film);
  const inputProps = { film, clips: null, tier, fontBaseUrl: null };
  const composition = await selectComposition({ serveUrl, id: "MiniMovie", inputProps, puppeteerInstance: browser, chromiumOptions: { gl }, logLevel: "error" });
  const frame = Math.min(rf.totalFrames - 1, Math.round(rf.totalFrames * at));
  const file = join(out, `cat-${String(i).padStart(3, "0")}.jpg`);
  await renderStill({ serveUrl, composition, inputProps, frame, output: file, imageFormat: "jpeg", jpegQuality: 85, puppeteerInstance: browser, chromiumOptions: { gl }, logLevel: "error" });
  // label
  await runFfmpeg(["-y", "-i", file, "-vf", `drawtext=text='${e.id.replace(/[:']/g, " ")}':x=10:y=10:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.6`, "-q:v", "3", join(out, `lab-${String(i).padStart(3, "0")}.jpg`)]);
  console.log(`${e.id} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  i++;
}
await browser.close({ silent: true });
const cols = 6;
const per = cols * 2;
for (let s = 0; s * per < i; s++) {
  await runFfmpeg(["-y", "-start_number", String(s * per), "-framerate", "1", "-i", join(out, "lab-%03d.jpg"), "-vf", `scale=270:-2,tile=${cols}x2:padding=4:margin=4:color=0x111111`, "-frames:v", "1", "-update", "1", "-q:v", "3", join(out, `sheet-${s + 1}.jpg`)]);
}
console.log(`${i} stills in ${((Date.now() - t0) / 1000).toFixed(0)} s → ${out}`);
