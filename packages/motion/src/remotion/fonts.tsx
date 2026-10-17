import { createContext, useContext, useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender, getRemotionEnvironment, staticFile } from "remotion";
import { MOTION_FONTS } from "./theme";

/**
 * Where font files are fetched from. In a Remotion render the bundle's public dir is
 * packages/media/assets, so fonts resolve via staticFile("fonts/<file>"). In the browser
 * Player, the web app serves the same files at /api/fonts/<file> — pass `fontBaseUrl`.
 */
export interface MotionAssets {
  fontBaseUrl: string | null;
}

export const MotionAssetsContext = createContext<MotionAssets>({ fontBaseUrl: null });

export function fontUrl(file: string, base: string | null): string {
  if (base) return `${base.replace(/\/$/, "")}/${file}`;
  return staticFile(`fonts/${file}`);
}

const loaded = new Map<string, Promise<void>>();

function loadFace(family: string, url: string, weight: number): Promise<void> {
  const key = `${family}|${url}`;
  let p = loaded.get(key);
  if (!p) {
    const face = new FontFace(family, `url("${url}") format("truetype")`, { weight: String(weight), style: "normal" });
    p = face.load().then((f) => {
      document.fonts.add(f);
    });
    loaded.set(key, p);
  }
  return p;
}

/**
 * Blocks the frame (delayRender) until every motion font is loaded, so no frame is ever
 * captured with a fallback face. Missing fonts fail loudly in render (cancel), and degrade to
 * the CSS fallback stack in the preview.
 */
export function useMotionFonts(): boolean {
  const { fontBaseUrl } = useContext(MotionAssetsContext);
  const [ready, setReady] = useState(false);
  const [handle] = useState(() => delayRender("Loading motion fonts", { timeoutInMilliseconds: 60000 }));
  useEffect(() => {
    let cancelled = false;
    Promise.all(Object.values(MOTION_FONTS).map((f) => loadFace(f.family, fontUrl(f.file, fontBaseUrl), f.weight)))
      .catch((err) => {
        if (getRemotionEnvironment().isRendering) cancelRender(err);
        else console.error("motion fonts failed to load", err);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
        continueRender(handle);
      });
    return () => {
      cancelled = true;
    };
  }, [fontBaseUrl, handle]);
  return ready;
}
