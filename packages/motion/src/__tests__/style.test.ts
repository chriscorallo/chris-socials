import { describe, it, expect } from "vitest";
import { MOTION_LANGUAGES, MOTION_PALETTES, MOTION_TEMPLATES } from "@chris/media/timeline";
import {
  AUTO_TRANSITIONS,
  DEFAULT_FEEL,
  MIN_PRIMARY_CONTRAST,
  MIN_SECONDARY_CONTRAST,
  MOTION_FEELS,
  contrastRatio,
  ensureContrast,
  resolveMotionStyle,
  resolveThemedTransition,
} from "../pure";

describe("resolveMotionStyle (pure)", () => {
  it("no theme = the original house style exactly (v1 timelines render unchanged)", () => {
    for (const name of ["BRAND", "MONO", "VIVID"] as const) {
      const s = resolveMotionStyle({ palette: name }, null);
      expect(s.palette).toEqual(MOTION_PALETTES[name]);
      expect(s.feel).toBe(DEFAULT_FEEL);
      expect(s.feel.language).toBe("CRISP");
      expect(s.iconStyle).toBe("GOLD_METAL");
    }
    for (const t of MOTION_TEMPLATES) {
      expect(resolveThemedTransition(t, "enter", "AUTO", "CRISP")).toBe(AUTO_TRANSITIONS[t].enter);
      expect(resolveThemedTransition(t, "exit", "AUTO", "CRISP")).toBe(AUTO_TRANSITIONS[t].exit);
    }
  });

  it("theme colors override BRAND/VIVID accents but never MONO (restraint is a choice)", () => {
    const theme = { name: "Debt", motionLanguage: "PUNCHY", primary: "#FFB547", secondary: "#F0505F", iconStyle: "GLASS", rationale: null } as const;
    expect(resolveMotionStyle({ palette: "BRAND" }, theme).palette).toMatchObject({ primary: "#FFB547", secondary: "#F0505F", ink: MOTION_PALETTES.BRAND.ink });
    expect(resolveMotionStyle({ palette: "VIVID" }, theme).palette.primary).toBe("#FFB547");
    const mono = resolveMotionStyle({ palette: "MONO" }, theme);
    expect(mono.palette).toEqual(MOTION_PALETTES.MONO);
    expect(mono.feel.language).toBe("PUNCHY");
    expect(mono.iconStyle).toBe("GLASS");
  });

  it("guards contrast: a dark theme color is lightened to stay readable on the glass", () => {
    const s = resolveMotionStyle({ palette: "BRAND" }, { name: "x", motionLanguage: "CALM", primary: "#5A0000", secondary: "#002200", iconStyle: "GOLD_METAL", rationale: null });
    expect(contrastRatio(s.palette.primary, "#12121A")).toBeGreaterThanOrEqual(MIN_PRIMARY_CONTRAST);
    expect(contrastRatio(s.palette.secondary, "#12121A")).toBeGreaterThanOrEqual(MIN_SECONDARY_CONTRAST);
    expect(ensureContrast("#FFD54A", 4.5)).toBe("#FFD54A");
  });

  it("every motion language is a complete, distinct feel; explicit transitions always win", () => {
    for (const l of MOTION_LANGUAGES) {
      const f = MOTION_FEELS[l];
      expect(f.language).toBe(l);
      for (const k of ["settle", "soft", "punch", "grow", "object"] as const) expect(f.springs[k].stiffness).toBeGreaterThan(0);
      expect(resolveThemedTransition("STAT_CARD", "enter", "SLIDE", l)).toBe("SLIDE");
    }
    expect(MOTION_FEELS.CALM.tempo).toBeGreaterThan(MOTION_FEELS.PUNCHY.tempo);
    expect(MOTION_FEELS.PUNCHY.hitScale).toBeGreaterThan(MOTION_FEELS.CALM.hitScale);
    expect(MOTION_FEELS.CINEMATIC.push).toBeGreaterThan(0);
    expect(MOTION_FEELS.PLAYFUL.rotate).toBeGreaterThan(0);
    expect(resolveThemedTransition("STAT_CARD", "enter", "AUTO", "CALM")).toBe("FADE");
    expect(resolveThemedTransition("NUMBER_COUNTER", "enter", "AUTO", "CINEMATIC")).toBe("BLUR");
  });
});
