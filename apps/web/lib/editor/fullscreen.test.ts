import { describe, expect, it } from "vitest";
import {
  APP_NAV_BAR_PT,
  DEFAULT_FULLSCREEN_PREFS,
  FULLSCREEN_PREFS_KEY,
  fullscreenLayout,
  loadFullscreenPrefs,
  nextFullscreenPlatform,
  parseFullscreenPrefs,
  saveFullscreenPrefs,
  swipeCloses,
} from "./fullscreen";

describe("full-screen layout", () => {
  it("plain: the whole 9:16 frame, fit to width and centred (letterboxed)", () => {
    const L = fullscreenLayout({ w: 393, h: 852 }, null);
    expect(L.canvas).toEqual({ w: 393, h: 698 });
    expect(L.x).toBe(0);
    expect(L.y).toBe(77);
    expect(L.nav).toBeNull();
    expect(L.clip).toEqual({ x: 0, y: 77, w: 393, h: 698 });
  });

  it("app UI on a 393x852 phone: like the reference iPhone — 83 pt nav, ~49 px cropped a side", () => {
    const L = fullscreenLayout({ w: 393, h: 852 }, "TIKTOK");
    expect(Math.abs(L.nav!.h - 83)).toBeLessThan(1.5);
    expect(Math.abs(L.clip.h - 769)).toBeLessThan(1.5);
    const scale = L.canvas.w / 1080;
    expect(-L.x / scale).toBeCloseTo(49.5, 0); // px of video hidden on the left
    expect(L.y).toBeLessThanOrEqual(0);
  });

  it("app UI on a short viewport: fills the area above a normal nav bar", () => {
    const L = fullscreenLayout({ w: 393, h: 660 }, "INSTAGRAM", 0);
    expect(L.nav).toEqual({ y: 660 - APP_NAV_BAR_PT, h: APP_NAV_BAR_PT });
    expect(L.canvas.h).toBeGreaterThanOrEqual(660 - APP_NAV_BAR_PT);
    expect(L.canvas.w).toBeGreaterThanOrEqual(393);
    const L2 = fullscreenLayout({ w: 393, h: 660 }, "INSTAGRAM", 34);
    expect(L2.nav!.h).toBe(APP_NAV_BAR_PT + 34);
  });
});

describe("full-screen gestures and prefs", () => {
  it("swipe down closes; taps, sideways and upward drags don't", () => {
    expect(swipeCloses(120, 400)).toBe(true);
    expect(swipeCloses(40, 50)).toBe(true); // a quick flick
    expect(swipeCloses(40, 400)).toBe(false);
    expect(swipeCloses(5, 100)).toBe(false);
    expect(swipeCloses(-150, 300)).toBe(false);
    expect(swipeCloses(120, 300, 200)).toBe(false);
  });

  it("remembers the last choice, guarded against bad or blocked storage", () => {
    expect(parseFullscreenPrefs(null)).toEqual(DEFAULT_FULLSCREEN_PREFS);
    expect(parseFullscreenPrefs("{not json")).toEqual(DEFAULT_FULLSCREEN_PREFS);
    expect(parseFullscreenPrefs(JSON.stringify({ platform: "MYSPACE", muted: "yes" }))).toEqual(DEFAULT_FULLSCREEN_PREFS);
    expect(parseFullscreenPrefs(JSON.stringify({ platform: "YOUTUBE", muted: true }))).toEqual({ platform: "YOUTUBE", muted: true });

    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveFullscreenPrefs({ platform: "TIKTOK", muted: false }, store);
    expect(mem.get(FULLSCREEN_PREFS_KEY)).toBeTruthy();
    expect(loadFullscreenPrefs(store)).toEqual({ platform: "TIKTOK", muted: false });

    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(loadFullscreenPrefs(blocked)).toEqual(DEFAULT_FULLSCREEN_PREFS);
    expect(() => saveFullscreenPrefs({ platform: "TIKTOK", muted: true }, blocked)).not.toThrow();
    expect(loadFullscreenPrefs(null)).toEqual(DEFAULT_FULLSCREEN_PREFS);
  });

  it("cycles the app UI choice", () => {
    expect(nextFullscreenPlatform("NONE")).toBe("TIKTOK");
    expect(nextFullscreenPlatform("YOUTUBE")).toBe("NONE");
  });
});
