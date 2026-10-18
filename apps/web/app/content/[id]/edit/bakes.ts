"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { GRAPHIC_BAKE_FPS, graphicBakeKey, type EditTimeline, type GraphicBakeInput, type TimelineVisual, type VisualInteraction } from "@chris/media/timeline";
import type { GraphicBakeState } from "@chris/domain";

/** POST /api/editor/bakes — a Route Handler, so polling never queues in front of Save. */
async function requestBakes(contentItemId: string, wanted: Array<{ key: string; input: GraphicBakeInput }>): Promise<{ states: GraphicBakeState[]; started: boolean; message?: string }> {
  const res = await fetch("/api/editor/bakes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contentItemId, wanted }) });
  if (!res.ok) throw new Error(`bakes ${res.status}`);
  return (await res.json()) as { states: GraphicBakeState[]; started: boolean; message?: string };
}
import type { PlaybackEngine } from "./playback";
import type { BakeSpec } from "../../../../lib/editor/engine/compositor";

/**
 * Keeps the compositor's baked graphics in sync with the edit (docs/decisions-pending/
 * editor-rebuild.md): every graphic as placed (AUTO placements solved) + its interaction track
 * → a bake key; ready bakes go to the engine, missing ones are requested (a background job
 * renders them) and polled. Graphics without a ready bake stay on the live (lite) layer.
 * Debounced, so dragging a graphic doesn't request a bake per frame.
 *
 * Returns the ids of visuals the compositor draws (the live layer skips them).
 */
export function useGraphicBakes(
  engine: PlaybackEngine,
  itemId: string,
  visuals: TimelineVisual[],
  interactions: Record<string, VisualInteraction>,
  canvas: EditTimeline["canvas"],
  motionTheme: EditTimeline["motionTheme"],
  /** false until the inputs are final (the footage analysis changes interaction looks) */
  inputsReady = true,
): Set<string> {
  const enabled = engine.kind === "compositor" && inputsReady;
  const wanted = useMemo(() => {
    if (!enabled) return [];
    return visuals.map((v) => {
      const input: GraphicBakeInput = { visual: v as unknown as GraphicBakeInput["visual"], interaction: interactions[v.id] ?? null, canvas, motionTheme: motionTheme ?? null, fps: GRAPHIC_BAKE_FPS };
      return { v, key: graphicBakeKey(input), input };
    });
  }, [enabled, visuals, interactions, canvas, motionTheme]);
  const [ready, setReady] = useState<Map<string, { url: string; frames: number; fps: number }>>(new Map());
  const pollRef = useRef(0);

  // request + poll (debounced)
  const signature = wanted.map((w) => w.key).join(",");
  useEffect(() => {
    if (!enabled || !wanted.length) return;
    let cancelled = false;
    let tries = 0;
    const ask = async () => {
      if (cancelled) return;
      tries++;
      try {
        const r = await requestBakes(
          itemId,
          wanted.filter((w) => !ready.has(w.key)).map((w) => ({ key: w.key, input: w.input })),
        );
        if (cancelled) return;
        if (r.message) console.warn("[ed] graphic bakes:", r.message);
        const fresh = r.states.filter((s) => s.status === "READY" && s.storageKey && s.frames);
        if (fresh.length)
          setReady((cur) => {
            const next = new Map(cur);
            for (const s of fresh) next.set(s.key, { url: `/api/media/${s.storageKey}`, frames: s.frames!, fps: s.fps });
            return next;
          });
        const pending = r.states.some((s) => s.status === "PENDING");
        if (pending && tries < 90) pollRef.current = window.setTimeout(ask, tries < 5 ? 2500 : 5000);
      } catch {
        if (tries < 10) pollRef.current = window.setTimeout(ask, 8000);
      }
    };
    pollRef.current = window.setTimeout(ask, 900);
    return () => {
      cancelled = true;
      window.clearTimeout(pollRef.current);
    };
    // `ready` deliberately not a dependency: polling owns it; the signature restarts the cycle
  }, [enabled, signature, itemId]);

  // hand ready bakes to the engine
  const specs = useMemo<BakeSpec[]>(() => {
    const out: BakeSpec[] = [];
    for (const w of wanted) {
      const r = ready.get(w.key);
      if (r) out.push({ visualId: w.v.id, start: w.v.start, end: w.v.end, fps: r.fps, frames: r.frames, url: r.url });
    }
    return out;
  }, [wanted, ready]);
  useEffect(() => {
    if (engine.kind === "compositor") engine.setBakes(specs);
  }, [engine, specs]);
  return useMemo(() => new Set(specs.map((s) => s.visualId)), [specs]);
}
