import { describe, it, expect } from "vitest";
import {
  composeInstagramCaption,
  composeTikTokTitle,
  composeYouTubeMetadata,
  truncateCodePoints,
  validatePackageText,
  validateMediaSpec,
  normalizeHashtag,
} from "../platform-limits";

describe("caption composition", () => {
  it("appends package hashtags once, case-insensitively deduped against the caption", () => {
    const out = composeInstagramCaption("Hello #World", ["world", "#New", "#new", "  spaced tag "]);
    expect(out.text).toBe("Hello #World\n\n#New #spacedtag");
    expect(out.hashtagCount).toBe(3);
    expect(out.droppedHashtags).toEqual([]);
  });

  it("never exceeds Instagram's 30-hashtag cap; overflow is reported, not silently sent", () => {
    const out = composeInstagramCaption("x", Array.from({ length: 35 }, (_, i) => `t${i}`));
    expect(out.hashtagCount).toBe(30);
    expect(out.droppedHashtags).toHaveLength(5);
  });

  it("TikTok has no hashtag cap but respects the 2,200 UTF-16 limit", () => {
    const out = composeTikTokTitle("a".repeat(2190), ["toolongtag"]);
    expect(out.text.length).toBeLessThanOrEqual(2200);
    expect(out.droppedHashtags).toEqual(["toolongtag"]);
  });

  it("normalizeHashtag rejects empties", () => {
    expect(normalizeHashtag("#")).toBeNull();
    expect(normalizeHashtag("#café_2")).toBe("café_2");
  });
});

describe("YouTube metadata", () => {
  it("derives a title from the caption's first line when none is set, strips < >, truncates by code point", () => {
    const meta = composeYouTubeMetadata({ title: null, caption: `${"é".repeat(99)}👍👍 rest\nsecond line`, hashtags: [] });
    expect(Array.from(meta.title)).toHaveLength(100);
    expect(meta.titleTruncated).toBe(true);
    expect(truncateCodePoints("ab😀c", 3)).toBe("ab😀");
  });

  it("keeps tags under 500 chars counting commas and quotes for spaced tags", () => {
    const meta = composeYouTubeMetadata({ title: "t", caption: "c", hashtags: Array.from({ length: 60 }, (_, i) => `tag${i}xxxx`) });
    const length = meta.tags.reduce((sum, t, i) => sum + t.length + (i > 0 ? 1 : 0), 0);
    expect(length).toBeLessThanOrEqual(500);
    expect(meta.tags.length).toBeLessThan(60);
  });
});

describe("validatePackageText / validateMediaSpec", () => {
  it("flags too many @-mentions on Instagram", () => {
    const caption = Array.from({ length: 21 }, (_, i) => `@user${i}`).join(" ");
    expect(validatePackageText("INSTAGRAM", { caption, title: null, hashtags: [] }).some((r) => r.includes("@-mentions"))).toBe(true);
  });

  it("accepts a normal 1080x1920 30s render on every platform", () => {
    for (const platform of ["INSTAGRAM", "TIKTOK", "YOUTUBE"] as const) {
      expect(validateMediaSpec(platform, { width: 1080, height: 1920, durationSeconds: 30, fileSizeBytes: 10_000_000 })).toEqual([]);
    }
  });

  it("rejects too-short Instagram/TikTok renders and oversized TikTok dimensions", () => {
    expect(validateMediaSpec("INSTAGRAM", { width: 1080, height: 1920, durationSeconds: 2, fileSizeBytes: 1 })[0]).toContain("at least 3s");
    expect(validateMediaSpec("TIKTOK", { width: 2700, height: 4800, durationSeconds: 30, fileSizeBytes: 1 }).some((r) => r.includes("4096px"))).toBe(true);
  });
});
