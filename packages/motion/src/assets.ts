import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SFX_SOUNDS, type SfxSound } from "@chris/media";

/**
 * On-disk assets of @chris/motion (Node only). Resolution mirrors packages/media/src/fonts.ts:
 * relative to this module first, then a cwd walk (apps run with cwd=apps/<name>, and bundlers
 * may rewrite import.meta.url).
 */
function candidates(sub: string): string[] {
  const out: string[] = [];
  try {
    out.push(resolve(dirname(fileURLToPath(import.meta.url)), "..", ...sub.split("/")));
  } catch {
    // synthetic import.meta.url under a bundler — fall through to the cwd walk
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    out.push(join(dir, "packages", "motion", ...sub.split("/")));
    out.push(join(dir, "node_modules", "@chris", "motion", ...sub.split("/")));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function firstExisting(sub: string, probe: string): string {
  const c = candidates(sub);
  const hit = c.find((d) => existsSync(join(d, probe)));
  if (!hit) throw new Error(`@chris/motion asset dir "${sub}" not found (looked for ${probe} in: ${c.join(", ")})`);
  return hit;
}

/** packages/motion/assets/sfx — the procedural SFX kit (scripts/generate-sfx.mjs). */
export function resolveSfxDir(): string {
  if (process.env.MOTION_SFX_DIR) return process.env.MOTION_SFX_DIR;
  return firstExisting("assets/sfx", "whoosh.wav");
}

export function sfxFileName(sound: SfxSound): string {
  return `${sound.toLowerCase()}.wav`;
}

/** sound id -> absolute WAV path, for renderTimeline's `sfxFiles`. */
export function sfxFiles(dir = resolveSfxDir()): Record<SfxSound, string> {
  return Object.fromEntries(SFX_SOUNDS.map((s) => [s, join(dir, sfxFileName(s))])) as Record<SfxSound, string>;
}

/** The Remotion entry point (src/remotion/entry.ts). */
export function resolveRemotionEntry(): string {
  return join(firstExisting("src/remotion", "entry.ts"), "entry.ts");
}
