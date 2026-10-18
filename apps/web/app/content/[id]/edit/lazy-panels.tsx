"use client";

import dynamic from "next/dynamic";

/**
 * Panels that only appear on demand (a sheet / tab / modal Chris opens), split out of the
 * editor's first-load bundle so the editor is interactive sooner on a phone. Each loads the
 * first time it's opened (a spinner for that first open only).
 */
function PanelLoading() {
  return (
    <div className="flex items-center justify-center py-10" role="status" aria-label="Loading">
      <span className="ed-spinner" />
    </div>
  );
}

export const VisualsPanel = dynamic(() => import("./VisualsPanel").then((m) => m.VisualsPanel), { ssr: false, loading: PanelLoading });
export const VisualEditor = dynamic(() => import("./VisualsPanel").then((m) => m.VisualEditor), { ssr: false, loading: PanelLoading });
export const SoundPanel = dynamic(() => import("./SoundPanel").then((m) => m.SoundPanel), { ssr: false, loading: PanelLoading });
export const StyleCutPanel = dynamic(() => import("./StyleCutPanel").then((m) => m.StyleCutPanel), { ssr: false, loading: PanelLoading });
export const FinishModal = dynamic(() => import("./FinishModal").then((m) => m.FinishModal), { ssr: false });
