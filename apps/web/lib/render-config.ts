/**
 * Font path for the renderer's text overlays — required, never left to ffmpeg's implicit
 * fontconfig fallback (see /docs/DECISIONS.md: that produced a random, wrong-language font
 * on the dev machine and isn't portable to a production host anyway).
 *
 * RENDER_FONT_PATH should point to a real, licensed, bundled font once the BrandAsset asset
 * library exists (deferred, see /docs/DECISIONS.md). Until then this falls back to a macOS
 * system font that only exists on a machine with Xcode's font set installed — genuinely
 * dev-only, not a production-ready default.
 */
export function getRenderFontPath(): string {
  return process.env.RENDER_FONT_PATH ?? "/System/Library/Fonts/Supplemental/Arial.ttf";
}
