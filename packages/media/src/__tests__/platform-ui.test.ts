import { describe, expect, it } from "vitest";
import {
  PLATFORM_UI,
  UI_PLATFORM_IDS,
  UI_REGION_IDS,
  REFERENCE_PHONE,
  derivedSafeZone,
  outsideVisibleWidth,
  referenceAppFit,
  referenceVisibleX,
  scaleUiRect,
  screenFit,
  uiOverlapArea,
  uiRegionsHit,
} from "../platform-ui";
import { PLATFORM_PROFILES, PLACEMENT_SAFE_ZONE } from "../platform-profiles";
import { PLAN_CAPTION_PRESETS } from "../plan-to-timeline";
import { EditTimelineSchema } from "../timeline";
import { timelineCaptionChunks } from "../timeline-captions";
import { layoutCaptionChunk } from "../timeline-layout";
import { nodeMeasureText } from "../timeline-render";

describe("screen fit", () => {
  it("fills the area above the nav bar on the reference phone, cropping ~49 px a side", () => {
    const f = referenceAppFit();
    const areaH = REFERENCE_PHONE.heightPt - REFERENCE_PHONE.navBarPt; // 769
    expect(f.scale).toBeCloseTo(areaH / 1920, 6);
    expect(f.y).toBeCloseTo(0, 6);
    expect(f.height).toBeCloseTo(areaH, 6);
    expect(f.visible.x0).toBeCloseTo(49.4, 1);
    expect(f.visible.x1).toBeCloseTo(1030.6, 1);
    expect(f.visible.y0).toBe(0);
    expect(f.visible.y1).toBeCloseTo(1920, 6);
    expect(referenceVisibleX()).toEqual({ x0: 50, x1: 1030 });
  });

  it("contain letterboxes and shows everything", () => {
    const f = screenFit({ width: 393, height: 852 }, "CONTAIN");
    expect(f.width).toBeCloseTo(393, 6);
    expect(f.height).toBeCloseTo(698.67, 1);
    expect(f.y).toBeCloseTo((852 - 698.67) / 2, 1);
    expect(f.visible).toEqual({ x0: 0, y0: 0, x1: 1080, y1: 1920 });
  });

  it("fill on a wide viewport crops top and bottom instead", () => {
    const f = screenFit({ width: 400, height: 600 }, "FILL");
    expect(f.width).toBeCloseTo(400, 6);
    expect(f.visible.x0).toBe(0);
    expect(f.visible.y0).toBeGreaterThan(0);
  });
});

describe("platform UI regions", () => {
  it("best-estimate regions sit inside the conservative (official ads) ones", () => {
    for (const id of UI_PLATFORM_IDS) {
      const ui = PLATFORM_UI[id];
      for (const r of UI_REGION_IDS) {
        const b = ui.regions[r];
        const c = ui.conservative[r];
        expect(b.x0, `${id} ${r}`).toBeGreaterThanOrEqual(c.x0);
        expect(b.y0, `${id} ${r}`).toBeGreaterThanOrEqual(c.y0);
        expect(b.x1, `${id} ${r}`).toBeLessThanOrEqual(c.x1);
        expect(b.y1 <= c.y1 || r === "bottomText" || r === "progressBar", `${id} ${r}`).toBe(true);
      }
    }
  });

  it("the mock's icons and rows are inside their regions and inside the visible width", () => {
    const vis = referenceVisibleX();
    for (const id of UI_PLATFORM_IDS) {
      const ui = PLATFORM_UI[id];
      const rail = ui.regions.rightRail;
      for (const it of ui.rail.items) {
        expect(ui.rail.cx - it.size / 2, id).toBeGreaterThanOrEqual(rail.x0);
        expect(ui.rail.cx + it.size / 2, id).toBeLessThanOrEqual(vis.x1);
        expect(it.cy - it.size / 2, id).toBeGreaterThanOrEqual(rail.y0);
        expect(it.cy + it.size / 2, id).toBeLessThanOrEqual(rail.y1);
      }
      const text = ui.regions.bottomText;
      expect(ui.text.x).toBeGreaterThanOrEqual(vis.x0 + 20);
      for (const row of ui.text.rows) {
        expect(row.cy - row.h / 2, id).toBeGreaterThanOrEqual(text.y0);
        expect(row.cy + row.h / 2, id).toBeLessThanOrEqual(text.y1);
        expect(ui.text.x + row.w, id).toBeLessThanOrEqual(text.x1);
      }
    }
  });

  it("the old margin rectangle is derived from the conservative regions", () => {
    expect(derivedSafeZone(PLATFORM_UI.TIKTOK)).toEqual({ top: 240, bottom: 660, left: 60, right: 300 });
    expect(derivedSafeZone(PLATFORM_UI.INSTAGRAM)).toEqual({ top: 269, bottom: 672, left: 60, right: 227 });
    expect(derivedSafeZone(PLATFORM_UI.YOUTUBE)).toEqual({ top: 288, bottom: 672, left: 60, right: 192 });
    for (const id of UI_PLATFORM_IDS) expect(PLATFORM_PROFILES[id].safeZone).toEqual(derivedSafeZone(PLATFORM_UI[id]));
    // Graphics placement keeps its old margins (render output unchanged).
    expect(PLACEMENT_SAFE_ZONE).toEqual({ top: 288, bottom: 672, left: 65, right: 192 });
  });

  it("hit-tests rects against regions (scaled to the canvas), ignoring slivers", () => {
    const underRail = { x0: 900, y0: 1000, x1: 1000, y1: 1100 };
    expect(uiRegionsHit(underRail, "TIKTOK").map((h) => h.region)).toEqual(["rightRail"]);
    expect(uiRegionsHit({ x0: 450, y0: 950, x1: 550, y1: 1050 }, "TIKTOK")).toEqual([]);
    // the same rect on a half-size canvas
    const half = { x0: 450, y0: 500, x1: 500, y1: 550 };
    expect(uiRegionsHit(half, "TIKTOK", { width: 540, height: 960 }).map((h) => h.region)).toEqual(["rightRail"]);
    // a sliver: 4 px of a 600 px wide caption over the rail edge
    const sliver = { x0: 264, y0: 1380, x1: 864, y1: 1460 };
    expect(uiRegionsHit(sliver, "TIKTOK", undefined, { minFraction: 0.04 })).toEqual([]);
    expect(uiRegionsHit(sliver, "TIKTOK").map((h) => h.region)).toEqual(["rightRail"]);
    expect(uiOverlapArea({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 10, y0: 0, x1: 20, y1: 10 })).toBe(0);
    expect(scaleUiRect({ x0: 1080, y0: 1920, x1: 1080, y1: 1920 }, { width: 540, height: 960 })).toEqual({ x0: 540, y0: 960, x1: 540, y1: 960 });
  });

  it("flags content in the side strips a tall phone crops off", () => {
    expect(outsideVisibleWidth({ x0: 20, y0: 900, x1: 300, y1: 1000 })).toBe(true);
    expect(outsideVisibleWidth({ x0: 100, y0: 900, x1: 980, y1: 1000 })).toBe(false);
    expect(outsideVisibleWidth({ x0: 100, y0: 900, x1: 1060, y1: 1000 })).toBe(true);
  });
});

describe("default captions vs the platform UI", () => {
  it("default BOLD_HIGHLIGHT captions (64 px, y≈0.74) clear every app's caption block and rail for typical 3-word chunks", () => {
    const text = "Most people think a high income makes you rich. Third, stop upgrading. Invest the difference. Keep the apartment. Put it somewhere boring with an automatic transfer.";
    const words = text.split(" ").map((w, i) => ({ word: w, start: 0.3 + i * 0.4, end: 0.3 + i * 0.4 + 0.35 }));
    const tl = EditTimelineSchema.parse({
      version: 2,
      clips: [{ id: "c", mediaAssetId: "take", sourceStart: 0, sourceEnd: 0.3 + words.length * 0.4 }],
      captions: { ...PLAN_CAPTION_PRESETS.BOLD_HIGHLIGHT, y: 0.7388 },
    });
    expect(tl.captions.fontSize).toBe(64);
    const chunks = timelineCaptionChunks(tl, { take: words });
    expect(chunks.length).toBeGreaterThan(5);
    for (const ch of chunks) {
      const r = layoutCaptionChunk(ch, tl.captions, tl.canvas, nodeMeasureText).rect;
      const rect = { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height };
      for (const id of UI_PLATFORM_IDS) {
        const hits = uiRegionsHit(rect, id, tl.canvas, { minFraction: 0.04 });
        expect(hits, `${id}: "${ch.words.map((w) => w.word).join(" ")}" ${JSON.stringify(rect)}`).toEqual([]);
      }
    }
  });
});
