"use server";

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { prisma, parseTranscriptWords } from "@chris/domain";
import { displayDimensions, measureWordLoudness, outputEmphasisWords, sampleSceneStatsForVisuals, type WordLoudness } from "@chris/media";
import { EditTimelineSchema, type EmphasisWord, type SceneStats } from "@chris/media/timeline";
import { requireSession } from "../../../../lib/session";
import { downloadToFile, getLocalStorage } from "../../../../lib/storage";

/**
 * Footage measurements for the editor's Motion v2 preview — the SAME deterministic numbers the
 * render job computes (packages/media scene-analysis.ts): scene stats behind each graphic
 * (scene match / light wrap / shadow colour) and per-word vocal emphasis (hit timing). Run on
 * demand (debounced) when graphics move or change; results are pure data the client feeds to
 * buildVisualInteractions. Never throws — a failure returns empty results (neutral look,
 * template timing) and the render still measures for itself.
 */

export interface FootageAnalysis {
  sceneStats: Record<string, SceneStats | null>;
  emphasisWords: EmphasisWord[] | null;
  /** mediaAssetId → display size the stats were measured against. */
  sourceDimensions: Record<string, { width: number; height: number } | null>;
  error?: string;
}

const loudnessCache = new Map<string, WordLoudness[]>();
const dimsCache = new Map<string, { width: number; height: number }>();

async function localPathFor(storageKey: string, name: string): Promise<string> {
  const local = getLocalStorage();
  if (local) return local.pathFor(storageKey);
  const dir = join(tmpdir(), "chris-editor-footage");
  await mkdir(dir, { recursive: true });
  const p = join(dir, `${storageKey.replace(/[^a-zA-Z0-9._-]/g, "_")}${extname(name) || ".mp4"}`);
  if (!existsSync(p)) await downloadToFile(storageKey, p);
  return p;
}

export async function analyzeFootageAction(contentItemId: string, timelineInput: unknown): Promise<FootageAnalysis> {
  await requireSession();
  const empty: FootageAnalysis = { sceneStats: {}, emphasisWords: null, sourceDimensions: {} };
  const parsed = EditTimelineSchema.safeParse(timelineInput);
  if (!parsed.success) return { ...empty, error: "invalid timeline" };
  const timeline = parsed.data;
  try {
    const ids = [...new Set(timeline.clips.map((c) => c.mediaAssetId))];
    const assets = await prisma.mediaAsset.findMany({ where: { id: { in: ids }, contentItemId, kind: "RAW_TAKE", removedAt: null } });
    const sources: Record<string, string> = {};
    const words: Record<string, ReturnType<typeof parseTranscriptWords>> = {};
    const dims: FootageAnalysis["sourceDimensions"] = {};
    for (const a of assets) {
      sources[a.id] = await localPathFor(a.storageKey, a.originalFilename);
      words[a.id] = parseTranscriptWords(a.transcriptWords);
      let d = dimsCache.get(a.storageKey);
      if (!d) {
        d = await displayDimensions(sources[a.id]!);
        dimsCache.set(a.storageKey, d);
      }
      dims[a.id] = d;
    }
    const loud: Record<string, WordLoudness[] | null> = {};
    for (const a of assets) {
      const w = words[a.id];
      if (!w?.length || a.hasAudio === false) continue;
      const key = `${a.storageKey}:${w.length}:${w[0]!.start}:${w[w.length - 1]!.end}`;
      let l = loudnessCache.get(key);
      if (!l) {
        l = await measureWordLoudness(sources[a.id]!, w);
        loudnessCache.set(key, l);
      }
      loud[a.id] = l;
    }
    const emphasisWords = outputEmphasisWords(timeline, loud, words);
    const sceneStats = timeline.visuals.length ? await sampleSceneStatsForVisuals(timeline, sources, dims) : {};
    return { sceneStats, emphasisWords, sourceDimensions: dims };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}
