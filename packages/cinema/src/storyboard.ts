import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { findLocalHeadlessShell } from "@chris/motion";
import type { Film } from "./dsl/schema";
import { getCinemaBundle, rendererGl } from "./render";
import { resolveFilm, type LineClip } from "./timing";
import type { Tier } from "./remotion/world/World";
import { runFfmpeg } from "./audio/ffmpeg";

/**
 * Storyboard: renders a few stills per shot (start / middle / end) instead of the whole film —
 * seconds instead of minutes, so a director (or Chris) can judge framing, lighting and text
 * before paying for a full render. The future studio's "storyboard preview" and "shot reroll"
 * build on this.
 */
export async function renderStoryboard(input: { film: Film; clips?: Record<string, LineClip> | null; outDir: string; tier?: Tier; points?: number[]; shots?: string[] }): Promise<{ sheet: string; stills: string[] }> {
  const { renderStill, selectComposition, openBrowser, ensureBrowser } = await import("@remotion/renderer");
  const rf = resolveFilm(input.film, input.clips ?? null);
  const tier = input.tier ?? "DRAFT";
  const points = input.points ?? [0.1, 0.5, 0.92];
  await mkdir(input.outDir, { recursive: true });
  const serveUrl = await getCinemaBundle();
  const gl = rendererGl();
  const exe = findLocalHeadlessShell();
  if (!exe) await ensureBrowser();
  const browser = await openBrowser("chrome", { browserExecutable: exe, chromiumOptions: { gl } });
  const inputProps = { film: input.film, clips: input.clips ?? null, tier, fontBaseUrl: null };
  const stills: string[] = [];
  try {
    const composition = await selectComposition({ serveUrl, id: "MiniMovie", inputProps, puppeteerInstance: browser, chromiumOptions: { gl }, logLevel: "error" });
    for (const rs of rf.shots) {
      if (input.shots && !input.shots.includes(rs.shot.id)) continue;
      for (const p of points) {
        const frame = Math.min(rs.endFrame - 1, Math.round(rs.startFrame + (rs.endFrame - rs.startFrame) * p));
        const out = join(input.outDir, `still-${String(stills.length).padStart(3, "0")}.jpg`);
        await renderStill({ serveUrl, composition, inputProps, frame, output: out, imageFormat: "jpeg", jpegQuality: 85, puppeteerInstance: browser, chromiumOptions: { gl }, logLevel: "error" });
        stills.push(out);
      }
    }
  } finally {
    await browser.close({ silent: true }).catch(() => undefined);
  }
  const sheet = join(input.outDir, "storyboard.jpg");
  const cols = points.length * 2;
  const rows = Math.ceil(stills.length / cols);
  await runFfmpeg(["-framerate", "1", "-i", join(input.outDir, "still-%03d.jpg"), "-vf", `scale=240:-2,tile=${cols}x${rows}:padding=4:margin=4:color=0x111111`, "-frames:v", "1", "-q:v", "3", sheet]);
  return { sheet, stills };
}
