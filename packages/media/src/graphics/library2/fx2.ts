import type { GraphicPreset } from "../presets";
import { preset } from "./kit";

/** Library 2 — three more full-frame screen effects (2026-10-19): money rain, shockwave, gold dust. */
const fx = (id: string, name: string, description: string, tags: string[], data: Parameters<typeof preset>[6], opts: Parameters<typeof preset>[7] = {}) =>
  preset(id, name, description, "REACTIONS", ["fx", "effect", "vfx", ...tags], "SCREEN_FX", data, { placement: { mode: "MANUAL", x: 0.5, y: 0.5, scale: 1 }, ...opts });

export const FX2_PRESETS: GraphicPreset[] = [
  fx("fx-money-rain", "Money rain", "Bills and coins fall across the frame; the centre stays clear for Chris.", ["money rain", "cash", "bills", "coins", "falling", "payday", "jackpot"], { variant: "MONEY_RAIN" }, { seconds: 3, enterSfx: "SHIMMER", featured: true }),
  fx("fx-money-rain-word", "Money rain — with a word", "Money rain under a slammed word.", ["money rain", "cash", "word", "payday"], { variant: "MONEY_RAIN", title: "Payday" }, { seconds: 3, enterSfx: "SHIMMER" }),
  fx("fx-shockwave", "Shockwave", "A ring punches out from the centre with a chromatic edge — for the big reveal.", ["shockwave", "impact", "punch", "reveal", "boom", "hit"], { variant: "SHOCKWAVE" }, { seconds: 1.5, enterSfx: "IMPACT", featured: true }),
  fx("fx-shockwave-word", "Shockwave — with a word", "The shockwave with the reveal word slammed in.", ["shockwave", "impact", "word", "reveal"], { variant: "SHOCKWAVE", title: "Wrong." }, { seconds: 2, enterSfx: "IMPACT" }),
  fx("fx-gold-dust", "Gold dust", "Fine gold particles drift up through the frame — premium, quiet, cinematic.", ["gold dust", "sparkle", "particles", "premium", "luxury", "cinematic"], { variant: "GOLD_DUST" }, { seconds: 4, enterSfx: null }),
  fx("fx-gold-dust-word", "Gold dust — with a word", "Gold dust under a serif word.", ["gold dust", "sparkle", "word", "cinematic"], { variant: "GOLD_DUST", title: "Compound interest" }, { seconds: 4, enterSfx: null }),
];
