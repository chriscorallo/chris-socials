import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SFX_SOUNDS } from "@chris/media/timeline";
import { createSubprocessMotionModule } from "./motion-subprocess";
import { findSfxDir, findTsxRoot, findWebScriptsDir } from "./motion-assets";

/**
 * The web app's motion engine adapter (registered in instrumentation.ts): it must find the SFX
 * kit, the repo's tsx and its own child-process entry from the app's working directory —
 * otherwise renders started from the editor silently lose their graphics (graceful, but wrong).
 */
describe("web motion adapter", () => {
  it("finds every SFX file and the child-process entry", () => {
    expect(findSfxDir()).not.toBeNull();
    const files = createSubprocessMotionModule().sfxFiles();
    for (const s of SFX_SOUNDS) expect(existsSync(files[s]!), s).toBe(true);
    expect(findTsxRoot()).not.toBeNull();
    const scripts = findWebScriptsDir();
    expect(scripts && existsSync(join(scripts, "render-motion-layer.mts"))).toBe(true);
  });
});
