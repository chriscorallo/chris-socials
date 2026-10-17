import { join } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ffmpeg-static/ffprobe-static resolve their binary path via `__dirname` inside their own
  // package code. Left to Next's default Server Components bundling, that `__dirname` gets
  // rewritten to a synthetic build-time path (observed as "/ROOT/node_modules/...") instead
  // of the real on-disk location, so any server-side ffmpeg/ffprobe spawn fails with ENOENT —
  // found by exercising Phase 4's Quality Gate action through the real running dev server
  // (rather than only through a standalone script), which was the first thing to actually
  // invoke packages/media's ffmpeg code through Next's own bundler. `serverExternalPackages`
  // opts a dependency out of that bundling and uses plain Node `require` instead, which
  // resolves `__dirname` correctly — see /docs/DECISIONS.md.
  // Local Whisper transcription (transformers.js) loads native onnxruntime/sharp binaries —
  // same reason: must be required from node_modules at runtime, never bundled.
  serverExternalPackages: [
    "ffmpeg-static",
    "ffprobe-static",
    "@huggingface/transformers",
    "onnxruntime-node",
    "sharp",
  ],

  // @chris/motion ships TypeScript/TSX source (Remotion compositions + the editor's
  // <VisualsPreview> player). Turbopack transpiles workspace packages on its own; listing it
  // keeps webpack builds (and any non-workspace install) working too.
  transpilePackages: ["@chris/motion"],

  // Monorepo: trace server files from the repo root so files outside apps/web can be shipped.
  outputFileTracingRoot: join(__dirname, "..", ".."),
  // Files read from disk at RUNTIME (readFileSync/readdirSync), which the static tracer can't
  // discover on its own. Without this, every agent action failed on Vercel with ENOENT — the
  // prompt registry reads /prompts/** at call time — while working locally only because the
  // repo happens to be on disk. Brand docs are read by the seed; fonts by the renderer. See
  // /docs/DECISIONS.md ("Deploy: ship runtime-read files explicitly").
  // Never ship local data or other platforms' binaries in a function (Vercel caps a function
  // at 250 MB): the dynamic local-storage path otherwise drags <repo>/.storage (uploaded raw
  // takes) into the trace, and ffprobe-static carries binaries for every OS.
  outputFileTracingExcludes: {
    "/*": [
      "../../.storage/**",
      "../../.cache/**",
      "../../packages/domain/.pglite*/**",
      "../../node_modules/.pnpm/ffprobe-static@*/node_modules/ffprobe-static/bin/win32/**",
      "../../node_modules/.pnpm/ffprobe-static@*/node_modules/ffprobe-static/bin/darwin/**",
      // The editor now imports @chris/motion (pure helpers + the client-only preview player).
      // Remotion's native compositor and the bundler's rspack binaries are only used by the
      // worker's local render (which can't run in a Vercel Function anyway) — never ship them.
      "../../node_modules/.pnpm/@remotion+compositor-*/**",
      "../../node_modules/.pnpm/@rspack+binding-*/**",
    ],
  },
  outputFileTracingIncludes: {
    "/*": [
      "../../prompts/**/*.md",
      "../../brand/**/*.md",
      "../../packages/media/assets/**/*",
      // The procedural SFX kit, served to the editor by /api/sfx/[file] (small WAVs).
      "../../packages/motion/assets/sfx/*.wav",
    ],
  },
};

export default nextConfig;
