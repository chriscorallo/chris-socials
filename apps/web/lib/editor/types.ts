import type { EditTimeline, TranscriptWord } from "@chris/media/timeline";

/**
 * The finishing editor's document: the committed EditTimeline contract plus the fields the
 * editor already needs but the schema hasn't formalized yet (see
 * docs/decisions-pending/editor-ui.md — INTEGRATION NOTES). `EditTimelineSchema.parse` strips
 * unknown keys, so these are re-attached after validation when saving.
 */
export type EditorDoc = EditTimeline & {
  /** Cover/thumbnail frame on the OUTPUT timeline (seconds); null/undefined = platform default. */
  coverFrameSeconds?: number | null;
};

/** One raw take available to the editor (media bin). Serializable — passed from the server page. */
export interface EditorAsset {
  id: string;
  name: string;
  /** `/api/media/<storageKey>` */
  url: string;
  duration: number;
  width: number | null;
  height: number | null;
  words: TranscriptWord[] | null;
  transcript: string | null;
  /** Stable per-take accent used on timeline clips. */
  color: string;
}

export type Selection =
  | { kind: "clip"; id: string }
  | { kind: "text"; id: string }
  | { kind: "zoom"; id: string }
  | { kind: "captions" }
  | null;

/** Minimum length of a clip / text / zoom, in seconds. */
export const MIN_ITEM_SECONDS = 0.1;

export const TAKE_COLORS = ["#8f76ff", "#e5a94a", "#34c58c", "#ee6b52", "#5aa9ff", "#ff7ac6", "#b6d45a"];
