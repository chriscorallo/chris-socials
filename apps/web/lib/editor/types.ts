import type { EditTimeline, SubjectTrack, TranscriptWord } from "@chris/media/timeline";

/** The finishing editor's document: exactly the committed EditTimeline contract
 * (including its top-level `coverFrameSeconds`). */
export type EditorDoc = EditTimeline;

/** One raw take available to the editor (media bin). Serializable — passed from the server page. */
export interface EditorAsset {
  id: string;
  name: string;
  /**
   * What the PREVIEW plays: the take's 720p proxy (`/api/media/<proxyStorageKey>`, a keyframe
   * every 0.5 s) when one exists, else the original. Renders always use the original.
   */
  url: string;
  /** `/api/media/<storageKey>` — the camera original. */
  originalUrl?: string;
  /** True when `url` is the preview proxy. */
  proxied?: boolean;
  /** Server-made thumbnail sprite (tile i = source time (i + 0.5) * step), or null. */
  filmstrip?: { url: string; count: number; step: number; cols: number; rows: number; tileW: number; tileH: number } | null;
  /** Audio peak envelope (0–255, `perSecond` values per second of source), or null. */
  peaks?: { perSecond: number; values: number[] } | null;
  duration: number;
  width: number | null;
  height: number | null;
  words: TranscriptWord[] | null;
  transcript: string | null;
  /** Stable per-take accent used on timeline clips. */
  color: string;
  /** Where Chris is in this take over time (motion-graphics placement); null = not analysed. */
  subjectTrack: SubjectTrack | null;
  /** `/api/media/<matteStorageKey>` — the take's person matte (Motion v2 depth), or null. */
  matteUrl?: string | null;
}

/** A music bed uploaded for this video (MediaAsset kind MUSIC). */
export interface EditorMusicAsset {
  id: string;
  name: string;
  /** `/api/media/<storageKey>` */
  url: string;
  duration: number;
}

export type Selection =
  | { kind: "clip"; id: string }
  | { kind: "text"; id: string }
  | { kind: "zoom"; id: string }
  | { kind: "visual"; id: string }
  | { kind: "sfx"; id: string }
  | { kind: "captions" }
  | null;

/** Minimum length of a clip / text / zoom, in seconds. */
export const MIN_ITEM_SECONDS = 0.1;

export const TAKE_COLORS = ["#8f76ff", "#e5a94a", "#34c58c", "#ee6b52", "#5aa9ff", "#ff7ac6", "#b6d45a"];
