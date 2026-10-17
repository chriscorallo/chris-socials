/**
 * Vertical metrics of every FONT_REGISTRY font, extracted from the TTFs (GENERATED — a test
 * asserts these match the files). PURE data, shared by the renderer and the browser preview so
 * both place baselines identically. See timeline-layout.ts for how they are used:
 * - libass draws a font at ASS Fontsize = emPx * (winAscent + winDescent) / unitsPerEm, and puts
 *   the baseline winAscent * emPx / unitsPerEm below a line's \an7 top (measured, all fonts).
 * - Text/caption lines are laid out so the CAP HEIGHT is vertically centred in each line box.
 * - `fullName` (name table ID 4) is the name libass resolves the font by (via fontsdir).
 */
export interface FontMetrics {
  fullName: string;
  unitsPerEm: number;
  winAscent: number;
  winDescent: number;
  capHeight: number;
  xHeight: number;
}

export const FONT_METRICS: Record<string, FontMetrics> = {
  "inter-semibold": { fullName: "Inter SemiBold", unitsPerEm: 2048, winAscent: 1984, winDescent: 494, capHeight: 1490, xHeight: 1118 },
  "inter-display-bold": { fullName: "Inter Display Bold", unitsPerEm: 2048, winAscent: 1984, winDescent: 494, capHeight: 1490, xHeight: 1056 },
  "inter-display-extrabold": { fullName: "Inter Display ExtraBold", unitsPerEm: 2048, winAscent: 1984, winDescent: 494, capHeight: 1490, xHeight: 1056 },
  "montserrat-extrabold": { fullName: "Montserrat ExtraBold", unitsPerEm: 1000, winAscent: 1109, winDescent: 453, capHeight: 700, xHeight: 542 },
  "montserrat-black": { fullName: "Montserrat Black", unitsPerEm: 1000, winAscent: 1109, winDescent: 453, capHeight: 700, xHeight: 547 },
  "poppins-bold": { fullName: "Poppins Bold", unitsPerEm: 1000, winAscent: 1135, winDescent: 627, capHeight: 705, xHeight: 558 },
  "poppins-extrabold": { fullName: "Poppins ExtraBold", unitsPerEm: 1000, winAscent: 1135, winDescent: 627, capHeight: 709, xHeight: 561 },
  "archivo-black": { fullName: "Archivo Black Regular", unitsPerEm: 1000, winAscent: 1035, winDescent: 312, capHeight: 688, xHeight: 528 },
  "space-grotesk-bold": { fullName: "Space Grotesk Bold", unitsPerEm: 1000, winAscent: 1150, winDescent: 292, capHeight: 700, xHeight: 486 },
  "bebas-neue": { fullName: "Bebas Neue Regular", unitsPerEm: 1000, winAscent: 950, winDescent: 350, capHeight: 700, xHeight: 700 },
  "anton": { fullName: "Anton Regular", unitsPerEm: 2048, winAscent: 2876, winDescent: 674, capHeight: 1760, xHeight: 1500 },
  "oswald-bold": { fullName: "Oswald Bold", unitsPerEm: 1000, winAscent: 1325, winDescent: 377, capHeight: 810, xHeight: 578 },
  "roboto-condensed-bold": { fullName: "Roboto Condensed Bold", unitsPerEm: 2048, winAscent: 1946, winDescent: 512, capHeight: 1456, xHeight: 1082 },
  "dm-serif-display": { fullName: "DM Serif Display Regular", unitsPerEm: 1000, winAscent: 1036, winDescent: 335, capHeight: 660, xHeight: 481 },
  "playfair-display-bold": { fullName: "Playfair Display Bold", unitsPerEm: 1000, winAscent: 1159, winDescent: 251, capHeight: 708, xHeight: 514 },
};
