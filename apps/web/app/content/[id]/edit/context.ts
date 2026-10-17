"use client";

import { createContext, useContext } from "react";
import type { InteractionContext, PlacementResult, TimelineCaptionChunk, TimelineVisual, TranscriptWord, VisualInteraction } from "@chris/media/timeline";
import type { EditorAction, EditorState } from "../../../../lib/editor/reducer";
import type { EditorAsset, EditorDoc, EditorMusicAsset, Selection } from "../../../../lib/editor/types";
import type { PlatformId } from "../../../../lib/editor/platform-profiles";
import type { PlatformWarning } from "../../../../lib/editor/platform-warnings";
import type { PlaybackEngine } from "./playback";
import type { PreviewAudio } from "./preview-audio";

export type InspectorTab = "selection" | "captions" | "look" | "cover" | "visuals" | "sound" | "style";
export type PlatformView = "ALL" | PlatformId;

/** Bottom sheets of the touch (phone/tablet) shell. */
export type SheetId = "clip" | "volume" | "text" | "zoom" | "captions" | "look" | "media" | "cover" | "platforms" | "visuals" | "sound" | "style";

export interface EditorUi {
  reframe: boolean;
  platformView: PlatformView;
  tab: InspectorTab;
  /** Pixels per second on the timeline. */
  pxPerSec: number;
  /** Touch shell: the open bottom sheet, if any. */
  sheet: SheetId | null;
  /** The text element being typed into (inline editor on desktop, keyboard bar on touch). */
  editingTextId: string | null;
}

/** The "Style cut" state of the version being edited (StyleCutPanel). */
export interface EditorStyleCut {
  /** The selected take has word timings (a style cut is possible). */
  hasWords: boolean;
  /** The current version is a style cut. */
  active: boolean;
  summary: string | null;
  profileNote: string | null;
}

export interface EditorContextValue {
  state: EditorState;
  doc: EditorDoc;
  dispatch: (a: EditorAction) => void;
  /** Applies a pure recipe. Pass `coalesce` for continuous gestures (one undo step per gesture). */
  apply: (recipe: (d: EditorDoc) => EditorDoc, opts?: { coalesce?: string; select?: Selection }) => void;
  commit: () => void;
  engine: PlaybackEngine;
  assets: EditorAsset[];
  assetMap: Map<string, EditorAsset>;
  wordsByAsset: Record<string, TranscriptWord[] | null>;
  chunks: TimelineCaptionChunk[];
  ui: EditorUi;
  setUi: (patch: Partial<EditorUi>) => void;
  warnings: PlatformWarning[];
  /** Changes whenever a webfont finishes loading — layout memos depend on it. */
  fontsVersion: number;
  /** Selects an item and moves the playhead into it if it's off-screen in time. */
  focus: (sel: Selection) => void;
  toast: (message: string, tone?: "ok" | "warn" | "error") => void;
  /** True in the touch (phone/tablet) shell. */
  touch: boolean;

  // ---- motion graphics + sound design
  itemId: string;
  /** Placement engine output for the current doc (AUTO visuals solved, warnings, footprints). */
  placement: PlacementResult;
  /** resolveVisualPlacements bound to this editor's subject tracks / words / glyph measure. */
  solvePlacements: (d: EditorDoc) => TimelineVisual[];
  /** Motion v2 per-visual interaction data at PREVIEW_FPS (buildVisualInteractions). */
  interactions: Record<string, VisualInteraction>;
  /** Subject tracks + source sizes, for anchorOffsetFor etc. */
  interactionCtx: InteractionContext;
  music: EditorMusicAsset[];
  setMusic: (m: EditorMusicAsset[]) => void;
  audio: PreviewAudio;
  storageMode: "blob" | "local";
  dirty: boolean;
  /** Saves the current doc as a new version (same as the Save button). */
  save: () => Promise<boolean>;
  /** Replaces the doc with a version the SERVER just saved (e.g. AI visuals) — undoable. */
  loadSavedVersion: (doc: EditorDoc, state?: string) => void;
  styleCut: EditorStyleCut;
  setStyleCut: (s: EditorStyleCut) => void;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor outside EditorContext");
  return ctx;
}
