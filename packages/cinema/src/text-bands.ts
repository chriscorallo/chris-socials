/**
 * Vertical extent (fraction of frame height) of each on-screen text band — mirrors the overlay's
 * layout (src/remotion/overlay.tsx BANDS: UPPER 0.235, CENTER 0.47, LOWER 0.64 plus the type that
 * sits around them). Pure; used to measure text contrast on stills.
 */
export const BANDS_FOR_METRICS: Record<"UPPER" | "CENTER" | "LOWER", [number, number]> = {
  UPPER: [0.14, 0.32],
  CENTER: [0.4, 0.56],
  LOWER: [0.58, 0.72],
};

/** Which band a text beat is drawn in (same defaults as the overlay). */
export function bandOf(beat: { style: string; position?: "UPPER" | "CENTER" | "LOWER" }): "UPPER" | "CENTER" | "LOWER" {
  return beat.position ?? (beat.style === "LABEL" ? "LOWER" : beat.style === "TITLE" ? "CENTER" : "UPPER");
}
