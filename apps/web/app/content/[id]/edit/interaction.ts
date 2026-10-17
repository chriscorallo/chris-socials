"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildVisualInteractions, type InteractionContext, type TimelineVisual, type VisualInteraction } from "@chris/media/timeline";
import type { EditorAsset, EditorDoc } from "../../../../lib/editor/types";
import { analyzeFootageAction, type FootageAnalysis } from "./interaction-actions";
import { PREVIEW_FPS } from "./preview-fps";

/**
 * Motion v2 in the preview: the SAME `buildVisualInteractions` the render job runs (subject
 * anchor + camera coupling track, emphasis hit frame, scene look), fed with the same inputs —
 * subject tracks from the page, scene stats + vocal emphasis measured server-side by
 * `analyzeFootageAction` (debounced; graphics show v1 behaviour until it answers).
 */
export function useFootageInteractions(itemId: string, doc: EditorDoc, placed: TimelineVisual[], assets: EditorAsset[]) {
  const [analysis, setAnalysis] = useState<FootageAnalysis | null>(null);
  const seq = useRef(0);
  // Only what changes the measurements: clips, and each graphic's footprint/time/template.
  const key = useMemo(
    () =>
      placed.length === 0
        ? ""
        : JSON.stringify({
            c: doc.clips.map((c) => [c.mediaAssetId, c.sourceStart, c.sourceEnd, c.crop]),
            z: doc.zooms,
            g: doc.grade,
            v: placed.map((v) => [v.id, v.template, v.start, v.end, v.placement.x, v.placement.y, v.placement.scale]),
          }),
    [doc.clips, doc.zooms, doc.grade, placed],
  );
  useEffect(() => {
    if (!key) return;
    const n = ++seq.current;
    const timer = setTimeout(() => {
      void analyzeFootageAction(itemId, { ...doc, visuals: placed })
        .then((r) => {
          if (n === seq.current) setAnalysis(r);
        })
        .catch(() => undefined);
    }, 700);
    return () => clearTimeout(timer);
    // `key` captures exactly the inputs that matter; doc/placed identity churns every edit.
  }, [key, itemId]);

  const ctx = useMemo<InteractionContext>(() => {
    const subjectTracks: InteractionContext["subjectTracks"] = {};
    const sourceDimensions: NonNullable<InteractionContext["sourceDimensions"]> = {};
    for (const a of assets) {
      subjectTracks[a.id] = a.subjectTrack;
      sourceDimensions[a.id] = analysis?.sourceDimensions[a.id] ?? (a.width && a.height ? { width: a.width, height: a.height } : null);
    }
    return { subjectTracks, sourceDimensions };
  }, [assets, analysis]);

  const interactions = useMemo<Record<string, VisualInteraction>>(
    () =>
      placed.length
        ? buildVisualInteractions({ ...doc, visuals: placed }, { ...ctx, sceneStats: analysis?.sceneStats, emphasisWords: analysis?.emphasisWords }, PREVIEW_FPS)
        : {},
    [doc, placed, ctx, analysis],
  );
  return { interactions, interactionCtx: ctx, analysis };
}
