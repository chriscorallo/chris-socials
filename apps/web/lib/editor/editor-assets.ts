import { parsePreviewMeta, parseSubjectTrackRecord, parseTranscriptWords } from "@chris/domain";
import { TAKE_COLORS, type EditorAsset } from "./types";

/** The MediaAsset columns the editor needs (a Prisma MediaAsset row satisfies it). */
export interface EditorAssetRow {
  id: string;
  originalFilename: string;
  storageKey: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  transcriptWords: unknown;
  transcript: string | null;
  subjectTrack: unknown;
  matteStorageKey: string | null;
  proxyStorageKey: string | null;
  filmstripStorageKey: string | null;
  previewMeta: unknown;
}

/**
 * Raw takes → the editor's assets. The preview plays the take's 720p PROXY when one exists
 * (fast to download, a keyframe every 0.5 s for instant seeks/cuts) and falls back to the
 * camera original; renders never look at this (they always read the original).
 */
export function editorAssetsFrom(rows: EditorAssetRow[]): EditorAsset[] {
  return rows.map((a, i) => {
    const meta = parsePreviewMeta(a.previewMeta);
    const proxied = !!a.proxyStorageKey && !!meta;
    const originalUrl = `/api/media/${a.storageKey}`;
    return {
      id: a.id,
      name: a.originalFilename.replace(/\.[^.]+$/, ""),
      url: proxied ? `/api/media/${a.proxyStorageKey}` : originalUrl,
      originalUrl,
      proxied,
      filmstrip: a.filmstripStorageKey && meta ? { url: `/api/media/${a.filmstripStorageKey}`, ...meta.filmstrip } : null,
      peaks: meta?.peaks ?? null,
      duration: a.durationSeconds ?? 0,
      width: a.width,
      height: a.height,
      words: parseTranscriptWords(a.transcriptWords),
      transcript: a.transcript,
      color: TAKE_COLORS[i % TAKE_COLORS.length]!,
      // Where Chris is in the frame (motion-graphics placement) — null until the take is tracked.
      subjectTrack: parseSubjectTrackRecord(a.subjectTrack),
      // Person matte (graphics behind Chris) — null until computed.
      matteUrl: a.matteStorageKey ? `/api/media/${a.matteStorageKey}` : null,
    };
  });
}
