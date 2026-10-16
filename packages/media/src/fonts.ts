import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bundled, open-licensed typography (Inter 4.1 by Rasmus Andersson, SIL Open Font License 1.1
 * — see packages/media/assets/Inter-OFL-LICENSE.txt (kept outside fonts/ because libass tries to load every file in its fontsdir)). Shipped as static TTFs, not
 * WOFF2: ffmpeg's drawtext (FreeType) and libass only read WOFF2 when FreeType was built with
 * brotli, which isn't something we can assume of a static ffmpeg binary.
 *
 * Why bundle at all: the previous default (`/System/Library/Fonts/Supplemental/Arial.ttf`)
 * only exists on a Mac with that font set installed — on any other host the renderer either
 * failed or, worse, ffmpeg silently fell back to whatever fontconfig found and exited 0.
 */
export const BUNDLED_FONT_FILES = {
  /** Body/caption-overlay/lower-third weight. */
  SEMIBOLD: "Inter-SemiBold.ttf",
  /** Headlines and the CLEAN caption preset. */
  DISPLAY_BOLD: "InterDisplay-Bold.ttf",
  /** Number callouts and the BOLD_HIGHLIGHT caption preset. */
  DISPLAY_EXTRABOLD: "InterDisplay-ExtraBold.ttf",
} as const;

export type BundledFontWeight = keyof typeof BUNDLED_FONT_FILES;

/** Family names as libass/fontconfig see them (name table nameID 1), for ASS styles. */
export const BUNDLED_FONT_FAMILIES: Record<BundledFontWeight, { family: string; bold: boolean }> = {
  SEMIBOLD: { family: "Inter SemiBold", bold: false },
  DISPLAY_BOLD: { family: "Inter Display", bold: true },
  DISPLAY_EXTRABOLD: { family: "Inter Display ExtraBold", bold: false },
};

const FONT_SUBDIR = join("packages", "media", "assets", "fonts");

function candidateFontDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.RENDER_FONTS_DIR) dirs.push(process.env.RENDER_FONTS_DIR);
  // 1. Relative to this module on disk (works under tsx/vitest/plain node).
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    dirs.push(resolve(here, "..", "assets", "fonts"));
  } catch {
    // import.meta.url can be a synthetic URL under a bundler (Next.js server bundling
    // rewrites it, the same class of bug as ffmpeg-static's __dirname — see
    // /docs/DECISIONS.md). Fall through to the cwd walk below.
  }
  // 2. Walk up from cwd looking for the monorepo layout (apps/web runs with cwd=apps/web).
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    dirs.push(join(dir, FONT_SUBDIR));
    dirs.push(join(dir, "node_modules", "@chris", "media", "assets", "fonts"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

export class BundledFontNotFoundError extends Error {
  constructor(searched: string[]) {
    super(
      `Bundled fonts not found. Searched: ${searched.join(", ")}. Set RENDER_FONTS_DIR to the ` +
        `directory containing ${Object.values(BUNDLED_FONT_FILES).join(", ")}.`,
    );
    this.name = "BundledFontNotFoundError";
  }
}

let cachedFontsDir: string | null = null;

/** Absolute directory containing the bundled TTFs. Throws (never guesses) if not found. */
export function resolveBundledFontsDir(): string {
  if (cachedFontsDir && existsSync(join(cachedFontsDir, BUNDLED_FONT_FILES.SEMIBOLD))) {
    return cachedFontsDir;
  }
  const candidates = candidateFontDirs();
  for (const dir of candidates) {
    if (existsSync(join(dir, BUNDLED_FONT_FILES.SEMIBOLD))) {
      cachedFontsDir = dir;
      return dir;
    }
  }
  throw new BundledFontNotFoundError(candidates);
}

/** Absolute path of one bundled weight (default: the headline weight). */
export function resolveBundledFontPath(weight: BundledFontWeight = "DISPLAY_BOLD"): string {
  return join(resolveBundledFontsDir(), BUNDLED_FONT_FILES[weight]);
}

/**
 * Lazily-resolved default font path for `RenderInstructions.fontPath`. A getter-backed object
 * rather than a top-level constant so merely importing @chris/media never throws on a host
 * that lacks the font directory (e.g. a web route that only probes media).
 */
export function getDefaultFontPath(): string {
  return resolveBundledFontPath("DISPLAY_BOLD");
}

/**
 * Convenience constant for callers that want a plain string. Resolved at import time but
 * never throws: if the bundled fonts can't be found it is an empty string, and `renderVideo`
 * will then refuse to render with a clear error (it asserts the font file exists).
 */
export const DEFAULT_FONT_PATH: string = (() => {
  try {
    return getDefaultFontPath();
  } catch {
    return "";
  }
})();
