import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markGraphicBakeFailed, markGraphicBakeReady, pendingGraphicBakes, type PrismaClient } from "@chris/domain";
import { GRAPHIC_BAKE_SCALE, graphicBakeKey, type GraphicBakeInput, type StorageAdapter, type VisualInteraction, type EditTimeline } from "@chris/media";
import { defaultLoadMotion, type MotionModule } from "./render-job";

/**
 * `graphics-bake` heavy job (docs/decisions-pending/editor-rebuild.md): renders a video's
 * PENDING GraphicBake rows — each motion graphic, by the real Remotion renderer at half size,
 * colour over stacked alpha in one H.264 stream — so the editor preview composites a decoded
 * video instead of running live DOM with CSS/SVG filters (0.5–1 s per frame in WebKit).
 * Preview cache only: renders never read bakes. A failed bake just leaves that graphic on the
 * live preview path.
 */

export interface GraphicBakeJobResult {
  baked: number;
  failed: number;
  results: Array<{ key: string; status: "READY" | "FAILED"; ms?: number; error?: string }>;
}

export function bakeStorageKey(contentItemId: string, key: string): string {
  return `bakes/${contentItemId}/${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.mp4`;
}

export async function bakeGraphicsForContentItem(
  db: PrismaClient,
  storage: StorageAdapter,
  contentItemId: string,
  options: { load?: () => Promise<MotionModule>; onProgress?: (done: number, total: number) => void } = {},
): Promise<GraphicBakeJobResult> {
  const out: GraphicBakeJobResult = { baked: 0, failed: 0, results: [] };
  const motion = await (options.load ?? defaultLoadMotion)();
  if (!motion.renderVisualBake) throw new Error("This worker's motion engine can't bake preview graphics.");
  // Keep going while new rows arrive (Chris keeps editing) — bounded.
  for (let round = 0; round < 4; round++) {
    const rows = await pendingGraphicBakes(db, contentItemId);
    if (!rows.length) break;
    for (const [i, row] of rows.entries()) {
      options.onProgress?.(i, rows.length);
      const input = row.input as unknown as GraphicBakeInput;
      // The key is recomputed from the stored input — a row is only ever filled with what it names.
      if (graphicBakeKey(input) !== row.key) {
        await markGraphicBakeFailed(db, row.id, "input does not match its key");
        out.failed++;
        out.results.push({ key: row.key, status: "FAILED", error: "key mismatch" });
        continue;
      }
      const work = await mkdtemp(join(tmpdir(), "chris-bake-"));
      try {
        const file = join(work, "bake.mp4");
        const r = await motion.renderVisualBake({
          visual: input.visual,
          interaction: (input.interaction ?? null) as VisualInteraction | null,
          canvas: input.canvas,
          motionTheme: (input.motionTheme ?? null) as EditTimeline["motionTheme"] | null,
          fps: input.fps,
          scale: GRAPHIC_BAKE_SCALE,
          outputPath: file,
          workDir: work,
        });
        const storageKey = bakeStorageKey(contentItemId, row.key);
        await storage.put(storageKey, await readFile(file), "video/mp4");
        await markGraphicBakeReady(db, row.id, { storageKey, frames: r.frames, width: r.width, height: r.height, fps: input.fps });
        out.baked++;
        out.results.push({ key: row.key, status: "READY", ms: r.ms });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await markGraphicBakeFailed(db, row.id, msg).catch(() => undefined);
        out.failed++;
        out.results.push({ key: row.key, status: "FAILED", error: msg.slice(0, 200) });
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }
  }
  return out;
}
