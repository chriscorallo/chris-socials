/**
 * Platform UI safe zones — the regions where TikTok / Instagram Reels / YouTube Shorts draw
 * their own chrome (status bar + top tabs, caption/handle/CTA block at the bottom, the
 * like/comment/share rail on the right). Text placed there is covered on-platform even if it
 * looks fine in the raw file. Values are for a 1080x1920 (9:16) canvas and are deliberately
 * the conservative union across the three platforms; other 9:16 sizes scale proportionally.
 */
export const SAFE_ZONE_9X16_REFERENCE = {
  width: 1080,
  height: 1920,
  /** Status bar + "Following / For You" tabs. */
  top: 250,
  /** Caption, handle, audio ticker, CTA buttons. */
  bottom: 420,
  /** Like / comment / share / profile rail. */
  right: 140,
  /** No platform chrome on the left, but text kissing the edge looks unfinished. */
  left: 60,
} as const;

export interface SafeArea {
  /** Inclusive pixel bounds of the area text may occupy. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Max width of a horizontally *centered* text block that stays inside left/right. */
  centeredMaxWidth: number;
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * Safe area for a given output canvas. Vertical (taller than wide) canvases get the 9:16
 * platform-chrome margins scaled to size; anything else (16:9 YouTube long-form, 1:1) gets a
 * plain 5% title-safe margin, since those surfaces don't overlay UI on the video.
 */
export function getSafeArea(width: number, height: number): SafeArea {
  let left: number;
  let right: number;
  let top: number;
  let bottom: number;
  if (height > width) {
    const sx = width / SAFE_ZONE_9X16_REFERENCE.width;
    const sy = height / SAFE_ZONE_9X16_REFERENCE.height;
    left = Math.round(SAFE_ZONE_9X16_REFERENCE.left * sx);
    right = width - Math.round(SAFE_ZONE_9X16_REFERENCE.right * sx);
    top = Math.round(SAFE_ZONE_9X16_REFERENCE.top * sy);
    bottom = height - Math.round(SAFE_ZONE_9X16_REFERENCE.bottom * sy);
  } else {
    left = Math.round(width * 0.05);
    right = width - Math.round(width * 0.05);
    top = Math.round(height * 0.05);
    bottom = height - Math.round(height * 0.05);
  }
  const center = width / 2;
  const centeredMaxWidth = Math.floor(2 * Math.min(center - left, right - center));
  return { left, top, right, bottom, centeredMaxWidth, canvasWidth: width, canvasHeight: height };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectInsideSafeArea(rect: Rect, safe: SafeArea): boolean {
  return (
    rect.x >= safe.left - 0.5 &&
    rect.y >= safe.top - 0.5 &&
    rect.x + rect.width <= safe.right + 0.5 &&
    rect.y + rect.height <= safe.bottom + 0.5
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}
