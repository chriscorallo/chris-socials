"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildVisualInteractions, type InteractionContext, type TimelineVisual, type VisualInteraction } from "@chris/media/timeline";
import type { EditorAsset, EditorDoc } from "../../../../lib/editor/types";
import type { FootageAnalysis } from "./interaction-actions";

const EMPTY_ANALYSIS: FootageAnalysis = { sceneStats: {}, emphasisWords: null, sourceDimensions: {} };

/** POST /api/editor/analyze — a Route Handler, so this slow call never blocks Server Actions (Save). */
async function analyzeFootage(itemId: string, timeline: unknown): Promise<FootageAnalysis> {
  const res = await fetch("/api/editor/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contentItemId: itemId, timeline }) });
  if (!res.ok) throw new Error(`analyze ${res.status}`);
  return (await res.json()) as FootageAnalysis;
}
import { PREVIEW_FPS } from "./preview-fps";

/**
 * Motion v2 in the preview: the SAME `buildVisualInteractions` the render job runs (subject
 * anchor + camera coupling track, emphasis hit frame, scene look), fed with the same inputs —
 * subject tracks from the page, scene stats + vocal emphasis measured server-side by
 * `analyzeFootageAction` (debounced; graphics show v1 behaviour until it answers).
 */
/** Only what changes the measurements: clips, and each graphic's footprint/time/template. */
function analysisKey(doc: EditorDoc, placed: TimelineVisual[]): string {
  return placed.length === 0
    ? ""
    : JSON.stringify({
        c: doc.clips.map((c) => [c.mediaAssetId, c.sourceStart, c.sourceEnd, c.crop]),
        z: doc.zooms,
        g: doc.grade,
        v: placed.map((v) => [v.id, v.template, v.start, v.end, v.placement.x, v.placement.y, v.placement.scale]),
      });
}

/**
 * The last analysis per video is kept on the device: reopening the editor has the final
 * graphics inputs at once (so baked graphics are found immediately, no seconds of live fallback).
 */
function cachedAnalysis(itemId: string, key: string): FootageAnalysis | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`chris-ed-analysis:${itemId}`);
    if (!raw) return null;
    const c = JSON.parse(raw) as { key: string; analysis: FootageAnalysis };
    return c.key === key ? c.analysis : null;
  } catch {
    return null;
  }
}

function storeAnalysis(itemId: string, key: string, analysis: FootageAnalysis) {
  try {
    window.localStorage.setItem(`chris-ed-analysis:${itemId}`, JSON.stringify({ key, analysis }));
  } catch {
    /* storage full / blocked — just measured again next time */
  }
}

export function useFootageInteractions(itemId: string, doc: EditorDoc, placed: TimelineVisual[], assets: EditorAsset[]) {
  const [analysis, setAnalysis] = useState<FootageAnalysis | null>(() => cachedAnalysis(itemId, analysisKey(doc, placed)));
  const seq = useRef(0);
  const key = useMemo(() => analysisKey(doc, placed), [doc, placed]);
  useEffect(() => {
    if (!key) return;
    const n = ++seq.current;
    if (cachedAnalysis(itemId, key)) return; // already have it (initial state)
    const timer = setTimeout(() => {
      void analyzeFootage(itemId, { ...doc, visuals: placed })
        .then((r) => {
          if (n !== seq.current) return;
          setAnalysis(r);
          if (!r.error) storeAnalysis(itemId, key, r);
        })
        // failed → neutral looks (same as the renderer without stats); graphics still bake
        .catch(() => {
          if (n === seq.current) setAnalysis(EMPTY_ANALYSIS);
        });
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
