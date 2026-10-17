/**
 * Fonts available to the finishing editor and the renderer — pure data (no Node imports), so
 * the browser editor can import it for its font picker and @font-face preview. Every file
 * lives in packages/media/assets/fonts/ and is open-licensed (OFL); the license files live in
 * packages/media/assets/licenses/ (NOT in fonts/ — libass loads every file in its fontsdir). The renderer resolves `file` against that directory; the web app serves the
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
  { id: "montserrat-extrabold", family: "Montserrat ExtraBold", label: "Montserrat ExtraBold", weight: 800, file: "Montserrat-ExtraBold.ttf" },
  { id: "montserrat-black", family: "Montserrat Black", label: "Montserrat Black", weight: 900, file: "Montserrat-Black.ttf" },
  { id: "poppins-bold", family: "Poppins Bold", label: "Poppins Bold", weight: 700, file: "Poppins-Bold.ttf" },
  { id: "poppins-extrabold", family: "Poppins ExtraBold", label: "Poppins ExtraBold", weight: 800, file: "Poppins-ExtraBold.ttf" },
  { id: "archivo-black", family: "Archivo Black", label: "Archivo Black", weight: 400, file: "ArchivoBlack-Regular.ttf" },
  { id: "space-grotesk-bold", family: "Space Grotesk Bold", label: "Space Grotesk Bold", weight: 700, file: "SpaceGrotesk-Bold.ttf" },
  { id: "bebas-neue", family: "Bebas Neue", label: "Bebas Neue (condensed caps)", weight: 400, file: "BebasNeue-Regular.ttf" },
  { id: "anton", family: "Anton", label: "Anton (condensed)", weight: 400, file: "Anton-Regular.ttf" },
  { id: "oswald-bold", family: "Oswald Bold", label: "Oswald Bold (condensed)", weight: 700, file: "Oswald-Bold.ttf" },
  { id: "roboto-condensed-bold", family: "Roboto Condensed Bold", label: "Roboto Condensed Bold", weight: 700, file: "RobotoCondensed-Bold.ttf" },
  { id: "dm-serif-display", family: "DM Serif Display", label: "DM Serif Display (serif)", weight: 400, file: "DMSerifDisplay-Regular.ttf" },
  { id: "playfair-display-bold", family: "Playfair Display Bold", label: "Playfair Display Bold (serif)", weight: 700, file: "PlayfairDisplay-Bold.ttf" },
];

export const DEFAULT_TEXT_FONT_ID = "inter-display-extrabold";
export const DEFAULT_CAPTION_FONT_ID = "inter-display-bold";

export function findFont(id: string): RegisteredFont | undefined {
  return FONT_REGISTRY.find((f) => f.id === id);
}
