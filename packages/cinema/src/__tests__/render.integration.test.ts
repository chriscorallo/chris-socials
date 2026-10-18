import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findLocalHeadlessShell } from "@chris/motion";
import { PROOF_FILM } from "../films/the-raise";
import { getCinemaBundle, rendererGl } from "../render";

/**
 * Real Remotion + WebGL render: the same props must produce the same pixels (no clock, no
 * Math.random anywhere in the frame path). CINEMA_SKIP_REAL_RENDER=1 (or MOTION_SKIP_REAL_RENDER=1)
 * skips it on hosts without Chrome.
 */
const skip = process.env.CINEMA_SKIP_REAL_RENDER === "1" || process.env.MOTION_SKIP_REAL_RENDER === "1";

describe.skipIf(skip)("mini-movie render (real Chrome/WebGL)", () => {
  it("renders the same frame twice to identical pixels", async () => {
    const { renderStill, selectComposition, openBrowser, ensureBrowser } = await import("@remotion/renderer");
    const serveUrl = await getCinemaBundle();
    const exe = findLocalHeadlessShell();
    if (!exe) await ensureBrowser();
    const gl = rendererGl();
    const dir = await mkdtemp(join(tmpdir(), "cinema-det-"));
    const hashes: string[] = [];
    // two separate browsers: nothing can leak between the renders
    for (let run = 0; run < 2; run++) {
      const browser = await openBrowser("chrome", { browserExecutable: exe, chromiumOptions: { gl } });
      try {
        const inputProps = { film: PROOF_FILM, clips: null, tier: "PREVIEW", fontBaseUrl: null };
        const composition = await selectComposition({ serveUrl, id: "MiniMovie", inputProps, puppeteerInstance: browser, chromiumOptions: { gl }, logLevel: "error" });
        expect(composition.width).toBe(1080);
        const out = join(dir, `f${run}.png`);
        // frame 40: coins mid-air, grain, DOF, bloom and text all active
        await renderStill({ serveUrl, composition, inputProps, frame: 40, output: out, imageFormat: "png", puppeteerInstance: browser, chromiumOptions: { gl }, logLevel: "error" });
        hashes.push(createHash("sha256").update(await readFile(out)).digest("hex"));
      } finally {
        await browser.close({ silent: true });
      }
    }
    expect(hashes[0]).toBe(hashes[1]);
  }, 240000);
});
