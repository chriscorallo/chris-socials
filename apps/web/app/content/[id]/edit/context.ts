"use client";

import { createContext, useContext } from "react";
import type { TimelineCaptionChunk, TranscriptWord } from "@chris/media/timeline";
import type { EditorAction, EditorState } from "../../../../lib/editor/reducer";
import type { EditorAsset, EditorDoc, Selection } from "../../../../lib/editor/types";
import type { PlatformId } from "../../../../lib/editor/platform-profiles";
import type { PlatformWarning } from "../../../../lib/editor/platform-warnings";
import type { PlaybackEngine } from "./playback";

export type InspectorTab = "selection" | "captions" | "look" | "cover";
export type PlatformView = "ALL" | PlatformId;

/** Bottom sheets of the touch (phone/tablet) shell. */
export type SheetId = "clip" | "volume" | "text" | "zoom" | "captions" | "look" | "media" | "cover" | "platforms";

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
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor outside EditorContext");
  return ctx;
}
