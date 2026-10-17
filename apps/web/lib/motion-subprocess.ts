import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SFX_SOUNDS, type SfxSound } from "@chris/media/timeline";
import type { MotionModule } from "@chris/worker";
import { findSfxDir, findTsxRoot, findWebScriptsDir } from "./motion-assets";

/**
 * SERVER-ONLY. The motion engine as the web app's renders see it (registered for the worker's
 * render job in instrumentation.ts): SFX files are plain paths; the visuals layer is rendered
 * by a child process (scripts/render-motion-layer.mts under tsx) so Remotion and @chris/motion's
 * TypeScript never load inside the Next.js server. Local/self-hosted only — a Vercel Function
 * has neither tsx nor a headless Chrome; there the render degrades to "no visuals" with a
 * warning, exactly as before (render-job.ts prepareMotion).
 */
export function createSubprocessMotionModule(): MotionModule {
  return {
    sfxFiles() {
      const dir = findSfxDir();
      if (!dir) throw new Error("packages/motion/assets/sfx not found");
      return Object.fromEntries(SFX_SOUNDS.map((s) => [s, join(dir, `${s.toLowerCase()}.wav`)])) as Record<SfxSound, string>;
    },
    async renderVisualsLayer(input) {
      const root = findTsxRoot();
      const scripts = findWebScriptsDir();
      if (!root || !scripts) throw new Error("motion render helper not available on this server (needs the repo's tsx and apps/web/scripts)");
      const work = await mkdtemp(join(tmpdir(), "chris-motion-ipc-"));
      try {
        const inPath = join(work, "in.json");
        const outPath = join(work, "out.json");
        await writeFile(inPath, JSON.stringify(input));
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, ["--import", "tsx", join(scripts, "render-motion-layer.mts"), inPath, outPath], {
            cwd: root,
            env: process.env,
            stdio: ["ignore", "ignore", "pipe"],
          });
          let stderr = "";
          child.stderr.on("data", (c: Buffer) => {
            stderr = (stderr + c.toString()).slice(-4000);
          });
          child.on("error", reject);
          child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`motion render exited ${code}: ${stderr.trim().split("\n").slice(-4).join(" ")}`))));
        });
        return JSON.parse(await readFile(outPath, "utf8"));
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}
