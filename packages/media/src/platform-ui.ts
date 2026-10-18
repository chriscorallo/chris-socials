/**
 * Where TikTok / Instagram Reels / YouTube Shorts draw their on-screen UI over a 9:16 video on a
 * modern tall iPhone — PURE data + geometry (browser-safe). Used by the editor's platform mock,
 * the full-screen "as it looks in the app" view, and the platform warnings (text / captions /
 * graphics / face under a platform's buttons). `PLATFORM_PROFILES[id].safeZone` (the old margin
 * rectangle) is DERIVED from the conservative regions here (derivedSafeZone).
 *
 * Positions of the mock's icons/rows sit inside the part of the video the apps show on the
 * reference phone (x ≈ 50–1031, see referenceVisibleX), at the screen margins the apps use.
 *
 * Coordinates: px of a 1080x1920 video (x from the left, y from the top), as displayed on the
 * REFERENCE PHONE (393x852 pt, 19.5:9 — iPhone 15/16/17 class). Two sets per platform:
 *  - `regions`      best estimate of where the UI actually sits with a normal (1–2 line) caption;
 *                   what the mock draws and what the editor warns about;
 *  - `conservative` the official ADS safe-zone guidance (TikTok's In-Feed template, Meta's Reels
 *                   ads guide, Google Ads' vertical-video zone) — covers long captions, links,
 *                   CTAs. None of the three apps publishes organic UI positions; see
 *                   docs/decisions-pending/editor-smoothness-fullscreen-platform-ui.md (sources,
 *                   dates, where they disagree and which value was picked).
 *
 * Screen fit (all three, observed/derived, no official doc): the feed shows the video in the
 * area ABOVE the opaque bottom navigation bar (49 pt bar + 34 pt home indicator), aspect-FILLED:
 * on a 393x769 pt viewport a 9:16 video is scaled to the viewport height (769/1920 pt per px),
 * ~49 px are cropped off each side, and it starts at the very top of the screen (under the status
 * bar). The nav bar never covers the video. See screenFit().
 */
export type UiPlatformId = "INSTAGRAM" | "TIKTOK" | "YOUTUBE";

/** Rectangle in px of the 1080x1920 reference video (x0,y0 top-left; x1,y1 exclusive). */
export interface UiRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const UI_REGION_IDS = ["topBar", "rightRail", "bottomText", "progressBar"] as const;
export type UiRegionId = (typeof UI_REGION_IDS)[number];

export type RailIconKind = "avatar" | "like" | "dislike" | "comment" | "save" | "share" | "repost" | "remix" | "more" | "disc" | "audio";

export interface RailItem {
  kind: RailIconKind;
  /** Centre y of the icon (px). */
  cy: number;
  /** Icon diameter (px). */
  size: number;
  /** Draws a count/label under the icon. */
  label: boolean;
}

export type TextRowKind = "handle" | "caption" | "audio";

export interface TextRow {
  kind: TextRowKind;
  /** Centre y of the row (px). */
  cy: number;
  /** Row height (px). */
  h: number;
  /** Width of the placeholder line (px). */
  w: number;
  /** handle rows: avatar circle before the name. */
  avatar?: boolean;
  /** handle rows: a pill button after the name ("Follow" / "Subscribe"). */
  pill?: string;
}

export interface PlatformUi {
  id: UiPlatformId;
  label: string;
  regions: Record<UiRegionId, UiRect>;
  conservative: Record<UiRegionId, UiRect>;
  rail: { cx: number; items: RailItem[] };
  text: { x: number; rows: TextRow[] };
  /** Top bar contents for the mock. */
  top: { tabs: string[]; activeTab: number; align: "center" | "left"; icons: Array<"live" | "search" | "camera" | "more"> ; cy: number };
  progress: { color: string };
  /** Bottom nav bar items for the full-screen mock (drawn BELOW the video, never over it). */
  nav: string[];
  basis: string;
}

/** Reference phone: iPhone 15/16/17 (non-Max / Pro), portrait. */
export const REFERENCE_PHONE = { name: "iPhone 15/16/17 (393x852 pt)", widthPt: 393, heightPt: 852, navBarPt: 83, statusBarPt: 54 } as const;

const VIDEO = { width: 1080, height: 1920 };
const fullWidth = (y0: number, y1: number): UiRect => ({ x0: 0, y0, x1: VIDEO.width, y1 });

/** Evenly spaced rail items between two centre ys. */
function railItems(kinds: RailIconKind[], firstCy: number, lastCy: number, size: number): RailItem[] {
  const step = kinds.length > 1 ? (lastCy - firstCy) / (kinds.length - 1) : 0;
  return kinds.map((kind, i) => ({
    kind,
    cy: Math.round(firstCy + i * step),
    size: kind === "disc" || kind === "audio" ? Math.round(size * 0.8) : kind === "avatar" ? Math.round(size * 1.05) : size,
    label: !(kind === "avatar" || kind === "disc" || kind === "audio" || kind === "more"),
  }));
}

export const PLATFORM_UI: Record<UiPlatformId, PlatformUi> = {
  TIKTOK: {
    id: "TIKTOK",
    label: "TikTok",
    regions: {
      topBar: fullWidth(0, 230),
      rightRail: { x0: 860, y0: 760, x1: 1080, y1: 1660 },
      bottomText: { x0: 0, y0: 1500, x1: 830, y1: 1890 },
      progressBar: fullWidth(1890, 1920),
    },
    // TikTok In-Feed safe-zone template (Apr 2025 file): 720x1280 top 160 / bottom 440 / sides 80,
    // right action column 120 wide from y 560 → x1.5 at 1080x1920.
    conservative: {
      topBar: fullWidth(0, 240),
      rightRail: { x0: 780, y0: 700, x1: 1080, y1: 1920 },
      bottomText: { x0: 0, y0: 1260, x1: 860, y1: 1920 },
      progressBar: fullWidth(1880, 1920),
    },
    rail: { cx: 950, items: railItems(["avatar", "like", "comment", "save", "share", "disc"], 850, 1590, 104) },
    text: {
      x: 80,
      rows: [
        { kind: "handle", cy: 1572, h: 46, w: 250 },
        { kind: "caption", cy: 1648, h: 34, w: 700 },
        { kind: "caption", cy: 1708, h: 34, w: 520 },
        { kind: "audio", cy: 1790, h: 32, w: 380 },
      ],
    },
    top: { tabs: ["Following", "For You"], activeTab: 1, align: "center", icons: ["live", "search"], cy: 170 },
    progress: { color: "rgba(255,255,255,0.75)" },
    nav: ["Home", "Friends", "+", "Inbox", "Profile"],
    basis:
      "Best estimate on a 393x852 pt iPhone with a 1–2 line caption (TikTok publishes no organic positions). Conservative = TikTok's official In-Feed ads safe-zone template (Apr 2025 file, help page updated June 2026). The caption block grows upward with long captions, links and anchors (up to y≈906 with a 4-line anchor).",
  },
  INSTAGRAM: {
    id: "INSTAGRAM",
    label: "Instagram Reels",
    regions: {
      topBar: fullWidth(0, 230),
      rightRail: { x0: 900, y0: 1050, x1: 1080, y1: 1800 },
      bottomText: { x0: 0, y0: 1560, x1: 880, y1: 1880 },
      progressBar: fullWidth(1890, 1920),
    },
    // Meta Reels ads guide: 14% top / 35% bottom / 6% sides; its diagram also keeps the lower
    // right (≈227 px wide below y 1152) clear for the action buttons — extended up to y 1050 here
    // because the organic icon column (Repost added in 2025) starts higher than the ads diagram.
    conservative: {
      topBar: fullWidth(0, 269),
      rightRail: { x0: 853, y0: 1050, x1: 1080, y1: 1920 },
      bottomText: { x0: 0, y0: 1248, x1: 1080, y1: 1920 },
      progressBar: fullWidth(1880, 1920),
    },
    rail: { cx: 962, items: railItems(["like", "comment", "repost", "share", "more", "audio"], 1110, 1750, 80) },
    text: {
      x: 84,
      rows: [
        { kind: "handle", cy: 1622, h: 44, w: 220, avatar: true, pill: "Follow" },
        { kind: "caption", cy: 1702, h: 32, w: 640 },
        { kind: "audio", cy: 1776, h: 30, w: 360 },
      ],
    },
    top: { tabs: ["Reels", "Friends"], activeTab: 0, align: "left", icons: ["camera"], cy: 165 },
    progress: { color: "rgba(255,255,255,0.7)" },
    nav: ["Home", "Reels", "Messages", "Search", "Profile"],
    basis:
      "Best estimate on a 393x852 pt iPhone with a one-line caption (Meta publishes no organic Reels positions). Conservative = Meta's Reels ads safe zone (14% top / 35% bottom / 6% sides, lower-right action area; Stories+Reels zones unified March 2026).",
  },
  YOUTUBE: {
    id: "YOUTUBE",
    label: "YouTube Shorts",
    regions: {
      topBar: fullWidth(0, 230),
      rightRail: { x0: 900, y0: 900, x1: 1080, y1: 1800 },
      bottomText: { x0: 0, y0: 1500, x1: 880, y1: 1880 },
      progressBar: fullWidth(1890, 1920),
    },
    // Google Ads vertical-video safe zone (official 1080x1920 template): top 288 / bottom 672 /
    // left 48 / right 192.
    conservative: {
      topBar: fullWidth(0, 288),
      rightRail: { x0: 888, y0: 700, x1: 1080, y1: 1920 },
      bottomText: { x0: 0, y0: 1248, x1: 1080, y1: 1920 },
      progressBar: fullWidth(1880, 1920),
    },
    rail: { cx: 958, items: railItems(["like", "dislike", "comment", "share", "remix", "audio"], 960, 1745, 92) },
    text: {
      x: 80,
      rows: [
        { kind: "handle", cy: 1612, h: 46, w: 210, avatar: true, pill: "Subscribe" },
        { kind: "caption", cy: 1692, h: 34, w: 680 },
        { kind: "caption", cy: 1748, h: 34, w: 420 },
        { kind: "audio", cy: 1822, h: 30, w: 340 },
      ],
    },
    top: { tabs: [], activeTab: 0, align: "center", icons: ["search", "more"], cy: 170 },
    progress: { color: "#ff0033" },
    nav: ["Home", "Shorts", "+", "Subscriptions", "You"],
    basis:
      "Best estimate on a 393x852 pt iPhone with a 1–2 line title (YouTube publishes no organic Shorts positions). Conservative = Google Ads' vertical-video safe zone (top 288 / bottom 672 / left 48 / right 192 at 1080x1920).",
  },
};

export const UI_PLATFORM_IDS: UiPlatformId[] = ["TIKTOK", "INSTAGRAM", "YOUTUBE"];

// ---------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------

/** Scales a reference-video rect to a canvas of another size. */
export function scaleUiRect(r: UiRect, canvas: { width: number; height: number }): UiRect {
  const kx = canvas.width / VIDEO.width;
  const ky = canvas.height / VIDEO.height;
  return { x0: r.x0 * kx, y0: r.y0 * ky, x1: r.x1 * kx, y1: r.y1 * ky };
}

/** Intersection area of two rects (0 if they don't overlap). */
export function uiOverlapArea(a: UiRect, b: UiRect): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

export function rectToUi(r: { x: number; y: number; width: number; height: number }): UiRect {
  return { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height };
}

export interface ScreenFit {
  /** screen units per video px */
  scale: number;
  /** Where the whole video lands on screen (may extend past the screen when filled). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The part of the video that is visible, in video px. */
  visible: UiRect;
}

/**
 * How a video is placed in a viewport: FILL (cover — the apps' feed, cropping the sides on tall
 * screens) or CONTAIN (fit — the whole frame, letterboxed). `viewport` excludes the nav bar.
 */
export function screenFit(viewport: { width: number; height: number }, mode: "FILL" | "CONTAIN", video = VIDEO): ScreenFit {
  const sx = viewport.width / video.width;
  const sy = viewport.height / video.height;
  const scale = mode === "FILL" ? Math.max(sx, sy) : Math.min(sx, sy);
  const width = video.width * scale;
  const height = video.height * scale;
  const x = (viewport.width - width) / 2;
  const y = (viewport.height - height) / 2;
  const visible: UiRect = {
    x0: Math.max(0, -x / scale),
    y0: Math.max(0, -y / scale),
    x1: Math.min(video.width, (viewport.width - x) / scale),
    y1: Math.min(video.height, (viewport.height - y) / scale),
  };
  return { scale, x, y, width, height, visible };
}

/** The apps' feed fit on the reference phone: filled into the area above the nav bar. */
export function referenceAppFit(): ScreenFit {
  return screenFit({ width: REFERENCE_PHONE.widthPt, height: REFERENCE_PHONE.heightPt - REFERENCE_PHONE.navBarPt }, "FILL");
}

/** Visible x-range of the video in the apps on the reference phone (px), rounded inward. */
export function referenceVisibleX(): { x0: number; x1: number } {
  const v = referenceAppFit().visible;
  return { x0: Math.ceil(v.x0), x1: Math.floor(v.x1) };
}

/**
 * Backward-compatible margin rectangle (px at 1080x1920) from the CONSERVATIVE regions: top =
 * top bar, bottom = from the caption block's top, right = from the action rail's left edge, left
 * = the side crop on tall phones (at least 48 px).
 */
export function derivedSafeZone(ui: PlatformUi): { top: number; bottom: number; left: number; right: number } {
  const c = ui.conservative;
  const crop = referenceVisibleX();
  return {
    top: Math.round(c.topBar.y1),
    bottom: Math.round(VIDEO.height - c.bottomText.y0),
    left: Math.max(60, crop.x0),
    right: Math.round(VIDEO.width - c.rightRail.x0),
  };
}

export type UiHit = { region: UiRegionId; area: number };

/**
 * Which UI regions of a platform a rect (canvas px) sits under, best-estimate regions by default.
 * `minFraction` ignores slivers: a hit counts when the overlap is at least that fraction of the
 * rect's area OR of the region's own area (a small badge fully under a big rail still counts).
 */
export function uiRegionsHit(
  rect: UiRect,
  platform: UiPlatformId,
  canvas: { width: number; height: number } = VIDEO,
  opts: { set?: "regions" | "conservative"; minFraction?: number; ignore?: UiRegionId[] } = {},
): UiHit[] {
  const ui = PLATFORM_UI[platform];
  const set = ui[opts.set ?? "regions"];
  const min = opts.minFraction ?? 0;
  const area = Math.max(1, (rect.x1 - rect.x0) * (rect.y1 - rect.y0));
  const out: UiHit[] = [];
  for (const id of UI_REGION_IDS) {
    if (opts.ignore?.includes(id)) continue;
    const r = scaleUiRect(set[id], canvas);
    const a = uiOverlapArea(rect, r);
    if (a <= 0) continue;
    const rArea = Math.max(1, (r.x1 - r.x0) * (r.y1 - r.y0));
    if (a / area >= min || a / rArea >= min) out.push({ region: id, area: a });
  }
  return out;
}

/** True when part of the rect falls in the side strips a tall phone crops off (canvas px). */
export function outsideVisibleWidth(rect: UiRect, canvas: { width: number; height: number } = VIDEO): boolean {
  const v = referenceVisibleX();
  const k = canvas.width / VIDEO.width;
  return rect.x0 < v.x0 * k - 0.5 || rect.x1 > v.x1 * k + 0.5;
}
