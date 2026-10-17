/**
 * Fonts available to the finishing editor and the renderer — pure data (no Node imports), so
 * the browser editor can import it for its font picker and @font-face preview. Every file
 * lives in packages/media/assets/fonts/ and is open-licensed (OFL); the license files sit
 * next to them. The renderer resolves `file` against that directory; the web app serves the
 * same files at /api/fonts/<file> for the preview, so preview and render use the same glyphs.
 */
export interface RegisteredFont {
  id: string;
  /** CSS font-family name used by the preview's @font-face. */
  family: string;
  label: string;
  weight: number;
  file: string;
}

export const FONT_REGISTRY: RegisteredFont[] = [
  { id: "inter-semibold", family: "Inter SemiBold", label: "Inter SemiBold", weight: 600, file: "Inter-SemiBold.ttf" },
  { id: "inter-display-bold", family: "Inter Display Bold", label: "Inter Display Bold", weight: 700, file: "InterDisplay-Bold.ttf" },
  { id: "inter-display-extrabold", family: "Inter Display ExtraBold", label: "Inter Display ExtraBold", weight: 800, file: "InterDisplay-ExtraBold.ttf" },
];

export const DEFAULT_TEXT_FONT_ID = "inter-display-extrabold";
export const DEFAULT_CAPTION_FONT_ID = "inter-display-bold";

export function findFont(id: string): RegisteredFont | undefined {
  return FONT_REGISTRY.find((f) => f.id === id);
}
