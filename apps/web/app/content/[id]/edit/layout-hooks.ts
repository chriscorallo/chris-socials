"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { keyboardInset } from "../../../../lib/editor/touch-math";

/**
 * Which editor shell to show. Mobile-first: the server (and the first hydration pass) renders
 * the phone shell; ≥1024px wide AND ≥560px tall switches to the desktop workspace (media bin |
 * preview | inspector, timeline below). Phones in landscape and iPads in portrait get the
 * touch shell; iPads in landscape and laptops get the desktop one.
 */
const DESKTOP_QUERY = "(min-width: 1024px) and (min-height: 560px)";
const LANDSCAPE_QUERY = "(orientation: landscape) and (max-height: 560px)";

function subscribeQuery(query: string) {
  return (cb: () => void) => {
    if (typeof window === "undefined" || !window.matchMedia) return () => {};
    const mq = window.matchMedia(query);
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  };
}

const subs = new Map<string, (cb: () => void) => () => void>();
function useMediaQuery(query: string): boolean {
  let sub = subs.get(query);
  if (!sub) {
    sub = subscribeQuery(query);
    subs.set(query, sub);
  }
  return useSyncExternalStore(
    sub,
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

export function useEditorLayout(): { desktop: boolean; landscape: boolean } {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const landscape = useMediaQuery(LANDSCAPE_QUERY);
  return { desktop, landscape: !desktop && landscape };
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/** Pixels of the layout viewport currently covered by the on-screen keyboard (0 when closed). */
export function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!active || !vv) {
      setInset(0);
      return;
    }
    const update = () => setInset(keyboardInset(window.innerHeight, vv.height, vv.offsetTop));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [active]);
  return inset;
}

/** Best-effort haptic tick: Vibration API where it exists (Android); a no-op elsewhere. */
export function haptic(ms = 8) {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(ms);
  } catch {
    /* unsupported */
  }
}
