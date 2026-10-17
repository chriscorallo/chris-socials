import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * SERVER-ONLY. Locates files of the @chris/motion package on disk without importing its Node
 * entry (which pulls in Remotion's renderer/bundler — never bundled into the web app).
 * Mirrors @chris/motion's own resolveSfxDir: MOTION_SFX_DIR, else a walk up from the app's cwd.
 */
function walkUp(rel: string[], probe: string): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const c = join(dir, ...rel);
    if (existsSync(join(c, probe))) return c;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** packages/motion/assets/sfx (the procedural SFX kit). */
export function findSfxDir(): string | null {
  if (process.env.MOTION_SFX_DIR) return process.env.MOTION_SFX_DIR;
  return walkUp(["packages", "motion", "assets", "sfx"], "whoosh.wav");
}

/** apps/web/scripts (the motion-layer child-process entry). */
export function findWebScriptsDir(): string | null {
  return walkUp(["scripts"], "render-motion-layer.mts") ?? walkUp(["apps", "web", "scripts"], "render-motion-layer.mts");
}

/** The repo root that has `tsx` installed (the child process runs TypeScript through it). */
export function findTsxRoot(): string | null {
  const hit = walkUp(["node_modules", "tsx"], "package.json");
  return hit ? dirname(dirname(hit)) : null;
}
