import { createContext, useContext } from "react";

/**
 * Editor-preview quality knobs (VisualsLayerProps.previewQuality). Renders never set it, so the
 * renderer draws exactly as before; the preview uses it to keep the 3D layer cheap:
 *  - `maxDpr`: cap on a ThreeCanvas's device-pixel ratio. The preview shows the 1080-wide
 *    composition at ~200–400 CSS px, so the 3D canvas only needs (preview width / 1080) ×
 *    devicePixelRatio — while PLAYING the editor asks for a fraction of that, while paused the
 *    full on-screen resolution;
 *  - `preserveDrawingBuffer: false` (renders need true to capture frames; a preview doesn't).
 */
export interface PreviewQuality {
  maxDpr: number;
  /**
   * Mount 3D scenes from the start (hidden) instead of 3 s ahead. The editor turns this on once
   * it's idle after opening, so the WebGL setup happens while Chris looks at the first frame —
   * never during playback and never in the way of the first paint.
   */
  premount3d?: boolean;
}

export const PreviewQualityContext = createContext<PreviewQuality | null>(null);

export function usePreviewQuality(): PreviewQuality | null {
  return useContext(PreviewQualityContext);
}
