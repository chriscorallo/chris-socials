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
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
};

export default nextConfig;
