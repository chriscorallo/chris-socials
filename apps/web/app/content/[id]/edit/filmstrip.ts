"use client";

import { useEffect, useState } from "react";
import type { EditorAsset } from "../../../../lib/editor/types";

/**
 * Filmstrip thumbnails for timeline clips: frames grabbed in the browser from the take itself
 * (hidden <video> + canvas), cached per take for the session. Generation is queued one take
 * at a time so it never competes with playback for bandwidth. If frames can't be read (e.g.
 * a cross-origin storage redirect without CORS taints the canvas) the clip simply shows its
 * color and name.
 */

export interface Filmstrip {
  /** Seconds between frames. */
  step: number;
  frames: string[];
  aspect: number;
}

const cache = new Map<string, Filmstrip | "failed">();
const waiters = new Map<string, Set<() => void>>();
let queue: Promise<void> = Promise.resolve();

const FRAME_H = 72;
const MAX_FRAMES = 48;

function notify(id: string) {
  for (const fn of waiters.get(id) ?? []) fn();
}

async function generate(asset: EditorAsset): Promise<void> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = asset.url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("load failed"));
      setTimeout(() => reject(new Error("timeout")), 20000);
    });
    const duration = asset.duration || video.duration || 1;
    const count = Math.max(2, Math.min(MAX_FRAMES, Math.ceil(duration)));
    const step = duration / count;
    const aspect = (video.videoWidth || 9) / (video.videoHeight || 16);
    const canvas = document.createElement("canvas");
    canvas.height = FRAME_H * 2;
    canvas.width = Math.round(FRAME_H * 2 * aspect);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    const frames: string[] = [];
    for (let i = 0; i < count; i++) {
      const t = Math.min(duration - 0.05, i * step + step / 2);
      await new Promise<void>((resolve) => {
        const done = () => {
          video.removeEventListener("seeked", done);
          resolve();
        };
        video.addEventListener("seeked", done);
        video.currentTime = Math.max(0, t);
        setTimeout(done, 3000);
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", 0.6)); // throws if the canvas is tainted
      if (i === 0 || i % 6 === 5) {
        cache.set(asset.id, { step, frames: [...frames], aspect });
        notify(asset.id);
      }
    }
    cache.set(asset.id, { step, frames, aspect });
  } catch {
    if (!cache.get(asset.id) || cache.get(asset.id) === "failed") cache.set(asset.id, "failed");
  } finally {
    video.removeAttribute("src");
    video.load();
    notify(asset.id);
  }
}

/**
 * Client-side frame grabbing is the FALLBACK: a take with a server sprite (preview proxy job)
 * never decodes here, and a big camera original without a proxy yet (> 1080p) isn't decoded
 * either — a third 4K decoder + its download competing with playback on an iPhone is exactly
 * the load-time jank to avoid; its clips show their colour until the proxy's sprite arrives.
 */
function clientFramesAllowed(asset: EditorAsset): boolean {
  if (asset.filmstrip) return false;
  if (asset.proxied) return true;
  return (asset.width ?? 0) * (asset.height ?? 0) <= 1920 * 1080 * 1.05;
}

export function useFilmstrip(asset: EditorAsset | undefined): Filmstrip | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (!asset || !clientFramesAllowed(asset)) return;
    const fn = () => force((n) => n + 1);
    if (!waiters.has(asset.id)) waiters.set(asset.id, new Set());
    waiters.get(asset.id)!.add(fn);
    if (!cache.has(asset.id)) {
      cache.set(asset.id, { step: 1, frames: [], aspect: 9 / 16 });
      queue = queue.then(() => generate(asset));
    }
    return () => {
      waiters.get(asset.id)?.delete(fn);
    };
  }, [asset]);
  if (!asset || !clientFramesAllowed(asset)) return null;
  const v = cache.get(asset.id);
  return v && v !== "failed" && v.frames.length ? v : null;
}

/** The frame nearest to source time `t`. */
export function frameAt(strip: Filmstrip, t: number): string | undefined {
  const i = Math.max(0, Math.min(strip.frames.length - 1, Math.floor(t / strip.step)));
  return strip.frames[i];
}
