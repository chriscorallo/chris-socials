import { PLAN_PLATFORMS, type PlanPlatform } from "../posting-plan-core";

/**
 * Platform words people actually type in a plan → the three platforms this app publishes to.
 * "Reels"/"IG" → Instagram, "Shorts"/"YT" → YouTube, "TT" → TikTok; "all"/"everywhere" → every
 * platform enabled in the posting plan. Anything else (Facebook, LinkedIn…) is reported back as
 * unknown so the preview can say "Facebook isn't connected — ignored" instead of dropping it
 * silently.
 */
const WORDS: Record<string, PlanPlatform | "ALL"> = {
  tiktok: "TIKTOK", "tik tok": "TIKTOK", tt: "TIKTOK", tik: "TIKTOK", tiktoks: "TIKTOK",
  instagram: "INSTAGRAM", insta: "INSTAGRAM", ig: "INSTAGRAM", reels: "INSTAGRAM", reel: "INSTAGRAM",
  "ig reels": "INSTAGRAM", "instagram reels": "INSTAGRAM", "insta reels": "INSTAGRAM", "ig reel": "INSTAGRAM",
  youtube: "YOUTUBE", yt: "YOUTUBE", shorts: "YOUTUBE", short: "YOUTUBE", "yt shorts": "YOUTUBE",
  "youtube shorts": "YOUTUBE", "yt short": "YOUTUBE", ytshorts: "YOUTUBE",
  all: "ALL", "all platforms": "ALL", everywhere: "ALL", "all 3": "ALL", "all three": "ALL", "cross post": "ALL", "cross-post": "ALL",
};
const OTHER = new Set(["facebook", "fb", "linkedin", "twitter", "x", "threads", "snapchat", "pinterest", "snap"]);

export interface PlatformParse {
  platforms: PlanPlatform[];
  /** Non-platform words found (e.g. "Facebook") — reported, never silently dropped. */
  unknown: string[];
  /** True when every token in the text was a platform word (so the text *is* a platform list). */
  pure: boolean;
}

function clean(s: string): string {
  return s.toLowerCase().replace(/[“”"'`*_]/g, "").replace(/\s+/g, " ").trim();
}

/** Splits "TikTok, IG Reels & YT Shorts" / "TT/IG" / "tiktok + reels" into platform words. */
export function parsePlatforms(text: string, enabled: readonly PlanPlatform[] = PLAN_PLATFORMS): PlatformParse {
  const s = clean(text).replace(/^(platforms?|channels?|post (?:on|to)|on)\s*[:\-–—]?\s*/, "");
  if (!s) return { platforms: [], unknown: [], pure: false };
  const parts = s.split(/\s*(?:,|\/|&|\+|;|\band\b|\|)\s*/).map((p) => p.trim()).filter(Boolean);
  const out = new Set<PlanPlatform>();
  const unknown: string[] = [];
  let pure = parts.length > 0;
  for (const part of parts) {
    const hit = WORDS[part] ?? WORDS[part.replace(/\s+/g, "")];
    if (hit === "ALL") enabled.forEach((p) => out.add(p));
    else if (hit) out.add(hit);
    else {
      // "tiktok reels" (space-separated list)
      const words = part.split(" ");
      const hits = words.map((w) => WORDS[w]);
      if (words.length > 1 && hits.every(Boolean)) {
        for (const h of hits) {
          if (h === "ALL") enabled.forEach((p) => out.add(p));
          else if (h) out.add(h);
        }
      } else if (OTHER.has(part)) {
        unknown.push(part);
      } else {
        pure = false;
      }
    }
  }
  return { platforms: PLAN_PLATFORMS.filter((p) => out.has(p)), unknown, pure: pure && (out.size > 0 || unknown.length > 0) };
}

/** A column header that names a single platform ("TikTok", "IG", "YT Shorts") — for checkbox-style sheets. */
export function headerPlatform(header: string): PlanPlatform | null {
  const hit = WORDS[clean(header).replace(/[?:]$/, "")];
  return hit && hit !== "ALL" ? hit : null;
}

/** Cell values that mean "yes, post here" in a checkbox-style platform column. */
export function isTruthyCell(value: string): boolean {
  return /^(x|✓|✔|✅|☑|y|yes|true|1|ok|post|posted|yep|on)$/i.test(value.trim());
}
