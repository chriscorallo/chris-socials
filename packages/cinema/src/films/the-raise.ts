import type { Film } from "../dsl/schema";

/**
 * Proof film: "The Raise" — lifestyle creep in 40 seconds.
 *
 * Hook (0–2 s): coins are still raining onto the pedestal while "$10,000" assembles — and the
 *   narrator says it's already gone. Image = desire, line = loss: the gap is the hook.
 * Metaphor: the raise is a physical pile of gold (100 coins = $10,000/yr, $100 a coin). Taxes
 *   evaporate 35 coins; the apartment, the car and the "small" subscriptions literally pull the
 *   rest away (36 + 22 + 7 coins = $3,600 + $2,160 + $720 a year = $300 + $180 + $60 a month).
 * Twist: the pile is gone but the things stay — a glowing plane ("your baseline") rises to the
 *   height the raise used to be. You didn't spend a raise; you raised your floor.
 * Payoff: flip it — invest half ($270/mo) and the same coins become a 20-column sculpture of
 *   compound growth: $140,650 after 20 years at a hypothetical 7%, $75,850 of it growth.
 *
 * Numbers (checked): 22% federal + 7.65% FICA + ~5% state ≈ 34.65% marginal → "35%";
 *   $10,000 × 0.65 = $6,500/yr ≈ $541/mo; half ≈ $270/mo. FV of $270/mo, 7%/12 monthly,
 *   240 months = $140,650.20; contributions $64,800 → growth $75,850 (53.9%).
 */

const YEAR_VALUES = [3.35, 6.93, 10.78, 14.91, 19.33, 24.07, 29.16, 34.61, 40.46, 46.73, 53.46, 60.67, 68.4, 76.69, 85.58, 95.11, 105.33, 116.29, 128.05, 140.65];
const YEAR_PRINCIPAL = [3.24, 6.48, 9.72, 12.96, 16.2, 19.44, 22.68, 25.92, 29.16, 32.4, 35.64, 38.88, 42.12, 45.36, 48.6, 51.84, 55.08, 58.32, 61.56, 64.8];
const CHART_SPACING = 1.1;
/** x of the last (year 20) column. */
const LAST_X = (19 - 9.5) * CHART_SPACING;

export const PROOF_FILM: Film = {
  dsl: 1,
  id: "the-raise",
  title: "The Raise",
  logline: "Your $10,000 raise disappears into a nicer life — then the same money, flipped, becomes $140,650.",
  format: { width: 1080, height: 1920, fps: 30 },
  look: "GOLD_STUDIO",
  narration: { engine: "KOKORO", voice: "af_heart", speed: 0.92, gapSeconds: 0.22 },
  music: { source: "PROCEDURAL", bpm: 84, key: "D minor", levelDb: -20, seed: 11 },
  captions: "PHRASES",
  autoSfx: true,
  seed: 1729,
  cast: [
    { id: "pedestal", kind: "PEDESTAL", position: [0, 0, 0], visible: true, params: { radius: 1.75, height: 0.6 } },
    { id: "raise", kind: "COIN_STACK", position: [0, 0.6, 0], params: { count: 100, columns: 7, jitter: 0.6 }, note: "100 coins = $10,000/yr" },
    { id: "building", kind: "BUILDING", position: [-3.1, 0, -0.9], rotation: [0, 18, 0], params: { floors: 7, width: 1.3, glow: 0.9 } },
    { id: "car", kind: "CAR", position: [8.5, 0, 2.4], rotation: [0, 200, 0], params: { color: "#26252B" } },
    {
      id: "subs",
      kind: "CARD_FAN",
      position: [0, 0.75, 0],
      scale: 1.5, params: { count: 7, radius: 1.75, labels: ["Streaming|$15.99", "Music|$10.99", "Cloud|$2.99", "Fitness app|$12.99", "News|$4.99", "Delivery+|$9.99", "Photos|$2.99"] },
    },
    { id: "shaft", kind: "LIGHT_SHAFT", position: [0, 0.6, 0], params: { width: 1.9, strength: 0.9 }, note: "the empty spotlight" },
    { id: "baseline", kind: "BASELINE", position: [0, 0, 0], params: { level: 0.02, size: 16, label: "YOUR BASELINE" } },
    { id: "chart", kind: "COIN_CHART", position: [0, 0, 0], params: { values: YEAR_VALUES, split: YEAR_PRINCIPAL, spacing: CHART_SPACING, progress: 0, glow: 0 }, note: "one column per year; lower part = what you put in" },
  ],
  scenes: [
    {
      id: "the-raise",
      set: { kind: "INFINITY_STUDIO", floorGloss: 0.55, haze: 0.3, particles: 0.5 },
      shots: [
        {
          id: "hook",
          purpose: "HOOK — image says 'you got paid', line says 'it's gone'",
          line: "Your ten-thousand-dollar raise is already gone.",
          say: "Your ten thousand dollar raise... is already gone.",
          hold: 0.35,
          camera: { rig: "PUSH_IN", target: "raise", from: { distance: 9.2, azimuth: -20, elevation: 6, lift: 0.3 }, to: { distance: 6.6, azimuth: -9, elevation: 10, lift: 0.35 }, lens: { focalLength: 32, fStop: 2.0 }, drift: 0.15, shake: { at: { word: "gone" }, strength: 0.35 } },
          actions: [{ do: "ENTER", actor: "raise", style: "BUILD", at: 0, duration: 1.25 }],
          text: [
            { text: "YOUR RAISE", style: "KICKER", at: 0.1, until: { word: "gone", offset: 0.4 }, position: "UPPER" },
            { text: "$10,000", style: "HERO_NUMBER", at: 0.15, until: { word: "gone", offset: 0.4 }, position: "UPPER", strikeAt: { word: "gone" } },
          ],
          sfx: [
            { sound: "COIN_CLINK", at: 0.35, gainDb: -4 },
            { sound: "COIN_CLINK", at: 0.8, gainDb: -6 },
            { sound: "COIN_CLINK", at: 1.25, gainDb: -8 },
            { sound: "SUB_DROP", at: { word: "gone" }, gainDb: -2 },
          ],
          music: { intensity: 0.35, hit: true },
          transitionOut: { type: "WHIP" },
        },
        {
          id: "where",
          line: "Here's where it went.",
          camera: { rig: "ORBIT", target: "raise", from: { distance: 6.4, azimuth: 38, elevation: 16, lift: 0.1 }, to: { distance: 6.0, azimuth: 66, elevation: 22, lift: 0.2 }, lens: { focalLength: 30, fStop: 2.8 }, drift: 0.12 },
          music: { intensity: 0.5 },
        },
        {
          id: "taxes",
          purpose: "SETUP 1 — the first bite is the one nobody negotiates",
          line: "Taxes take thirty-five percent.",
          hold: 0.35,
          camera: { rig: "CRANE_UP", target: "raise", from: { distance: 6.2, azimuth: -28, elevation: 3, lift: -0.1 }, to: { distance: 6.8, azimuth: -14, elevation: 20, lift: 0.5 }, lens: { focalLength: 32, fStop: 2.2 }, drift: 0.1 },
          lighting: { preset: "TOP_SPOT", blendSeconds: 0.5 },
          actions: [{ do: "SET", actor: "raise", param: "count", to: 65, at: { word: "thirty" }, duration: 1.3, ease: "EASE_IN_OUT" }],
          text: [
            { text: "AFTER TAX", style: "KICKER", at: { word: "taxes" }, position: "UPPER" },
            { text: "$6,500", style: "HERO_NUMBER", at: { word: "taxes" }, countFrom: 10000, position: "UPPER" },
            { text: "22% federal + 7.65% FICA + ~5% state, on the raise", style: "FOOTNOTE", at: { word: "percent" } },
          ],
          sfx: [{ sound: "SHIMMER", at: { word: "thirty" }, gainDb: -6 }],
          music: { intensity: 0.55 },
        },
        {
          id: "apartment",
          line: "The nicer apartment? Three hundred more a month.",
          camera: { rig: "ORBIT", target: [-1.5, 1.3, -0.4], from: { distance: 9.0, azimuth: -38, elevation: 8 }, to: { distance: 8.0, azimuth: -18, elevation: 14 }, lens: { focalLength: 30, fStop: 2.8, focus: "building" }, rackFocus: { to: "raise", at: { word: "three" }, duration: 0.6 }, drift: 0.1 },
          lighting: { preset: "KEY_RIM", blendSeconds: 0.5 },
          actions: [
            { do: "ENTER", actor: "building", style: "BUILD", at: 0, duration: 1.1 },
            { do: "FLOW", actor: "raise", into: "building", amount: 36, at: { word: "three" }, duration: 1.4 },
            { do: "PULSE", actor: "building", at: { word: "month" }, strength: 0.8 },
          ],
          text: [{ text: "Rent|+$300/mo", style: "LABEL", at: { word: "three" }, position: "UPPER" }],
          sfx: [
            { sound: "SWOOSH_UP", at: 0, gainDb: -6 },
            { sound: "COIN_CLINK", at: { word: "month" }, gainDb: -6 },
          ],
          music: { intensity: 0.6 },
          transitionOut: { type: "WHIP" },
        },
        {
          id: "car",
          line: "The car upgrade. One-eighty.",
          say: "The car upgrade. One eighty.",
          camera: { rig: "DOLLY", target: [2.6, 0.7, 0.5], from: { distance: 6.8, azimuth: 34, elevation: 6 }, to: { distance: 5.8, azimuth: 16, elevation: 10 }, lens: { focalLength: 40, fStop: 2.4, focus: "car" }, drift: 0.1 },
          actions: [
            { do: "ENTER", actor: "car", style: "FADE", at: 0, duration: 0.01 },
            { do: "MOVE", actor: "car", to: [3.1, 0, 0.9], at: 0, duration: 1.2, ease: "EASE_OUT" },
            { do: "FLOW", actor: "raise", into: "car", amount: 22, at: { word: "one" }, duration: 1.0 },
          ],
          text: [{ text: "Car|+$180/mo", style: "LABEL", at: { word: "one" }, position: "UPPER" }],
          sfx: [{ sound: "WHOOSH", at: 0, gainDb: -4 }],
          music: { intensity: 0.65 },
        },
        {
          id: "subs",
          line: "And sixty bucks of “small” subscriptions.",
          camera: { rig: "ORBIT", target: "raise", from: { distance: 8.0, azimuth: 105, elevation: 13 }, to: { distance: 8.6, azimuth: 150, elevation: 19 }, lens: { focalLength: 28, fStop: 2.8 }, drift: 0.1 },
          actions: [
            { do: "ENTER", actor: "subs", style: "GROW", at: 0, duration: 1.1 },
            { do: "SET", actor: "raise", param: "count", to: 0, at: { word: "small" }, duration: 1.0, ease: "LINEAR" },
          ],
          text: [{ text: "Subscriptions|+$60/mo", style: "LABEL", at: { word: "sixty" }, position: "UPPER" }],
          sfx: [
            { sound: "SOFT_POP", at: 0.15, gainDb: -8 },
            { sound: "SOFT_POP", at: 0.45, gainDb: -9 },
            { sound: "TICK", at: { word: "small" }, gainDb: -6 },
            { sound: "TICK", at: { word: "subscriptions" }, gainDb: -6 },
          ],
          music: { intensity: 0.7 },
          transitionOut: { type: "CUT" },
        },
        {
          id: "gone",
          purpose: "BEAT — silence, empty pedestal in a single pool of light",
          line: "Gone.",
          hold: 1.2,
          camera: { rig: "CRANE_DOWN", target: "pedestal", from: { distance: 12.5, azimuth: 8, elevation: 62, lift: 0.2 }, to: { distance: 11.2, azimuth: 12, elevation: 56, lift: 0.2 }, lens: { focalLength: 35, fStop: 4 }, drift: 0.06 },
          lighting: { preset: "BLACKOUT_SPOT", blendSeconds: 0.12, focusOn: "pedestal" },
          actions: [{ do: "ENTER", actor: "shaft", style: "FADE", at: { word: "gone" }, duration: 0.4 }],
          text: [{ text: "$0", style: "HERO_NUMBER", at: { word: "gone" }, position: "UPPER", accent: false }],
          sfx: [{ sound: "SUB_DROP", at: { word: "gone" }, gainDb: -4 }],
          music: { intensity: 0.1, drop: true },
          transitionOut: { type: "DIP_TO_BLACK", duration: 0.5 },
        },
      ],
    },
    {
      id: "the-twist",
      set: { kind: "INFINITY_STUDIO", floorGloss: 0.55, haze: 0.35, particles: 0.6 },
      shots: [
        {
          id: "nobody",
          purpose: "TWIST setup",
          line: "But here's the part nobody tells you.",
          camera: { rig: "PUSH_IN", target: [0, 1.5, 0], from: { distance: 17, azimuth: 2, elevation: 2, lift: 0.6 }, to: { distance: 14.5, azimuth: -3, elevation: 3, lift: 0.6 }, lens: { focalLength: 45, fStop: 2.8, focus: "pedestal" }, drift: 0.12 },
          lighting: { preset: "LOW_DRAMA", blendSeconds: 0 },
          actions: [{ do: "EXIT", actor: "subs", style: "SHRINK", at: 0, duration: 0.01 }],
          text: [{ text: "THE PART NOBODY TELLS YOU", style: "KICKER", at: { word: "part" }, position: "UPPER", accent: true }],
          music: { intensity: 0.4 },
        },
        {
          id: "didnt",
          line: "You didn't just spend the raise.",
          camera: { rig: "DOLLY", target: [3.1, 0.55, 0.9], from: { position: [4.9, 0.55, 4.9], lookAt: [1.4, 0.8, 0.6] }, to: { position: [4.3, 0.75, 4.2], lookAt: [1.2, 0.9, 0.5] }, lens: { focalLength: 32, fStop: 1.6, focus: "car" }, rackFocus: { to: "building", at: { word: "spend" }, duration: 0.8 }, drift: 0.1 },
          sfx: [{ sound: "RISER", at: { word: "spend" }, gainDb: -8 }],
          music: { intensity: 0.55 },
          transitionOut: { type: "SMASH" },
        },
        {
          id: "baseline",
          purpose: "TWIST — the floor itself rises to where the raise used to be",
          line: "You raised your baseline.",
          hold: 1.0,
          camera: { rig: "CRANE_UP", target: [0, 1.2, 0], from: { distance: 11.5, azimuth: 24, elevation: 4 }, to: { distance: 12.5, azimuth: 32, elevation: 17 }, lens: { focalLength: 32, fStop: 3.2 }, drift: 0.1 },
          lighting: { preset: "KEY_RIM", blendSeconds: 0.4 },
          actions: [
            { do: "ENTER", actor: "baseline", style: "FADE", at: 0, duration: 0.6 },
            { do: "SET", actor: "baseline", param: "level", to: 1.8, at: { word: "raised" }, duration: 1.7, ease: "EASE_IN_OUT" },
          ],
          text: [{ text: "You raised your baseline.", style: "STATEMENT", at: { word: "raised" }, position: "UPPER" }],
          sfx: [{ sound: "IMPACT", at: { word: "baseline" }, gainDb: -3 }],
          music: { intensity: 0.75, hit: true },
          transitionOut: { type: "FLASH", duration: 0.3 },
        },
      ],
    },
    {
      id: "the-flip",
      set: { kind: "INFINITY_STUDIO", floorGloss: 0.5, haze: 0.25, particles: 0.7 },
      shots: [
        {
          id: "flip",
          purpose: "PAYOFF setup — the same money, pointed the other way",
          line: "So flip it. Invest half of every raise before you ever see it.",
          camera: { rig: "DOLLY", target: [-9.9, 0.3, 0], from: { position: [-12.4, 0.75, 2.6] }, to: { position: [-9.4, 1.05, 3.4], lookAt: [-7.2, 0.55, 0] }, lens: { focalLength: 40, fStop: 2.0 }, drift: 0.12 },
          lighting: { preset: "SOFT_DAWN", blendSeconds: 0 },
          actions: [
            { do: "EXIT", actor: "pedestal", style: "SINK", at: 0, duration: 0.01 },
            { do: "EXIT", actor: "building", style: "SINK", at: 0, duration: 0.01 },
            { do: "EXIT", actor: "car", style: "SINK", at: 0, duration: 0.01 },
            { do: "EXIT", actor: "baseline", style: "FADE", at: 0, duration: 0.01 },
            { do: "EXIT", actor: "shaft", style: "FADE", at: 0, duration: 0.01 },
            { do: "EXIT", actor: "raise", style: "SHRINK", at: 0, duration: 0.01 },
            { do: "ENTER", actor: "chart", style: "FADE", at: 0, duration: 0.01 },
            { do: "SET", actor: "chart", param: "progress", to: 0.4, at: 0, duration: 3.8, ease: "EASE_OUT" },
          ],
          text: [{ text: "Invest half|$270/mo", style: "LABEL", at: { word: "half" }, position: "UPPER" }],
          music: { intensity: 0.6, hit: true },
        },
        {
          id: "years",
          line: "Two seventy a month, at seven percent, for twenty years,",
          camera: { rig: "TRUCK", target: [0, 1, 0], from: { position: [-9.2, 1.4, 5.2], lookAt: [-6, 0.9, 0] }, to: { position: [3.2, 3.0, 7.2], lookAt: [6, 2.6, 0] }, lens: { focalLength: 35, fStop: 2.4 }, ease: "EASE_IN_OUT", drift: 0.1 },
          actions: [{ do: "SET", actor: "chart", param: "progress", to: 0.86, at: 0, duration: 3.6, ease: "EASE_IN_OUT" }],
          text: [
            { text: "20 YEARS", style: "KICKER", at: { word: "twenty" }, position: "UPPER", accent: true },
            { text: "Hypothetical 7% average annual return, compounded monthly. Not a guarantee.", style: "FOOTNOTE", at: { word: "seven" } },
          ],
          music: { intensity: 0.75 },
        },
        {
          id: "total",
          purpose: "PAYOFF — the number",
          line: "is about a hundred and forty thousand dollars.",
          hold: 0.6,
          camera: { rig: "CRANE_UP", target: [LAST_X, 5.5, 0], from: { distance: 12.5, azimuth: -18, elevation: 2, lift: -3.2 }, to: { distance: 13.5, azimuth: -10, elevation: 10, lift: 4.6 }, lens: { focalLength: 35, fStop: 2.8, focus: [LAST_X, 6, 0] }, drift: 0.1 },
          actions: [{ do: "SET", actor: "chart", param: "progress", to: 1, at: 0, duration: 1.3, ease: "EASE_OUT" }],
          text: [
            { text: "IN 20 YEARS", style: "KICKER", at: { word: "hundred" }, position: "UPPER" },
            { text: "$140,650", style: "HERO_NUMBER", at: { word: "hundred" }, countFrom: 0, position: "UPPER" },
          ],
          sfx: [{ sound: "IMPACT", at: { word: "dollars" }, gainDb: -5 }],
          music: { intensity: 0.9 },
        },
        {
          id: "growth",
          line: "More than half of it, you never had to earn.",
          camera: { rig: "ORBIT", target: [LAST_X - 2, 7, 0], from: { distance: 13, azimuth: -14, elevation: 6 }, to: { distance: 12, azimuth: 18, elevation: 12 }, lens: { focalLength: 35, fStop: 2.8 }, drift: 0.1 },
          actions: [{ do: "SET", actor: "chart", param: "glow", to: 1, at: { word: "half" }, duration: 0.9 }],
          text: [
            { text: "Growth|$75,850", style: "LABEL", at: { word: "half" }, position: "UPPER" },
            { text: "You put in $64,800. The rest is compounding.", style: "FOOTNOTE", at: { word: "never" } },
          ],
          sfx: [{ sound: "SHIMMER", at: { word: "half" }, gainDb: -6 }],
          music: { intensity: 0.85 },
          transitionOut: { type: "FOCUS_PULL", duration: 0.7 },
        },
        {
          id: "end",
          purpose: "PAYOFF line",
          line: "Same raise. Different life.",
          hold: 1.7,
          camera: { rig: "PULL_OUT", target: [1, 3.2, 0], from: { distance: 14, azimuth: 16, elevation: 9, lift: 2.2 }, to: { distance: 24, azimuth: 26, elevation: 15, lift: 4.5 }, lens: { focalLength: 28, fStop: 5.6 }, drift: 0.08 },
          post: { letterbox: 0.55 },
          text: [
            { text: "Same raise.", style: "TITLE", at: { word: "same" }, until: { word: "different", offset: -0.15 }, position: "UPPER" },
            { text: "Different life.", style: "TITLE", at: { word: "different" }, position: "UPPER", accent: true },
          ],
          music: { intensity: 0.7 },
        },
      ],
    },
  ],
};
