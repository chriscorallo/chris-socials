"use client";

import { useEffect, useState } from "react";
import { FONT_REGISTRY, findFont, type MeasureText } from "@chris/media/timeline";

/**
 * Browser glyph measurement injected into the shared layout functions (layoutTimelineText /
 * layoutCaptionChunk), per PREVIEW PARITY NOTES: canvas measureText with the registry font at
 * its registry weight, kerning off. Results are cached per (font, px, text) and the cache is
 * dropped whenever a webfont finishes loading (fallback-font widths would otherwise stick).
 */

let ctx: CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();

export const browserMeasureText: MeasureText = (text, fontId, fontPx) => {
  const key = `${fontId}|${fontPx}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const f = findFont(fontId);
  if (typeof document === "undefined" || !f) return text.length * fontPx * 0.5;
  if (!ctx) ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return text.length * fontPx * 0.5;
  ctx.font = `${f.weight} ${fontPx}px "${f.family}"`;
  (ctx as CanvasRenderingContext2D & { fontKerning: string }).fontKerning = "none";
  const w = ctx.measureText(text).width;
  cache.set(key, w);
  return w;
};

/** `@font-face` rules for every registered font, at its registry weight (no synthetic bold). */
export const FONT_FACE_CSS = FONT_REGISTRY.map(
  (f) =>
    `@font-face{font-family:"${f.family}";src:url("/api/fonts/${encodeURIComponent(f.file)}") format("${
      f.file.endsWith(".woff2") ? "woff2" : f.file.endsWith(".otf") ? "opentype" : "truetype"
    }");font-weight:${f.weight};font-style:normal;font-display:block;}`,
).join("\n");

/**
 * Loads the fonts the document uses (then the rest in the background) and returns a version
 * number that changes whenever any font finishes loading — layouts depend on it.
 */
export function useFontsVersion(usedFontIds: string[]): number {
  const [version, setVersion] = useState(0);
  const key = [...new Set(usedFontIds)].sort().join(",");
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) return;
    let cancelled = false;
    const bump = () => {
      cache.clear();
      if (!cancelled) setVersion((v) => v + 1);
    };
    const load = (id: string) => {
      const f = findFont(id);
      return f ? document.fonts.load(`${f.weight} 32px "${f.family}"`).catch(() => []) : Promise.resolve([]);
    };
    void Promise.all(key.split(",").filter(Boolean).map(load)).then(bump);
    document.fonts.addEventListener("loadingdone", bump);
    return () => {
      cancelled = true;
      document.fonts.removeEventListener("loadingdone", bump);
    };
  }, [key]);
  return version;
}
