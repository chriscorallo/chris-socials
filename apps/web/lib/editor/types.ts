import type { EditTimeline, TranscriptWord } from "@chris/media/timeline";

/** The finishing editor's document: exactly the committed EditTimeline contract
 * (including its top-level `coverFrameSeconds`). */
export type EditorDoc = EditTimeline;

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
