import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prisma,
  createContentItem,
  applyTransition,
  createMediaAsset,
  recordTakeSelection,
  recordEditPlan,
  recordRenderAttempt,
  startRendering,
} from "@chris/domain";
import { FFMPEG_PATH, LocalFsStorageAdapter, probeMedia } from "@chris/media";
import { ensurePlatformVariant, platformProfileVersion } from "../platform-variant-job";

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_PATH, args);
    let err = "";
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-800)))));
  });
}

describe("ensurePlatformVariant (real ffmpeg)", () => {
  let dir: string;
  let storage: LocalFsStorageAdapter;
  let renderId: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-variant-test-"));
    storage = new LocalFsStorageAdapter({ baseDir: join(dir, "store") });
    const masterPath = join(dir, "master.mp4");
    await ffmpeg([
      "-y", "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", masterPath,
    ]);

    const item = await createContentItem(prisma, { title: "Variant test" }, { actorId: "t" });
    for (const to of ["SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED", "READY_TO_FILM", "FILMED", "MEDIA_INGESTED"] as const) {
      await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
    }
    const take = await createMediaAsset(prisma, { contentItemId: item.id, kind: "RAW_TAKE", storageKey: `raw/${item.id}/t.mp4`, originalFilename: "t.mp4", mimeType: "video/mp4", sizeBytes: 1 }, { actorId: "t" });
    const sel = await recordTakeSelection(prisma, { contentItemId: item.id, selectedMediaAssetId: take.id, confidence: 1, reason: "only" }, { actorId: "t" });
    const plan = await recordEditPlan(prisma, { contentItemId: item.id, takeSelectionId: sel.id, productionTier: "FAST", targetDurationSeconds: 3, plan: {} }, { actorId: "t" });
    await startRendering(prisma, item.id, { actorId: "t" });
    const key = `renders/${item.id}/master.mp4`;
    await storage.put(key, await readFile(masterPath));
    const render = await recordRenderAttempt(prisma, { contentItemId: item.id, editPlanId: plan.id, status: "SUCCESS", storageKey: key, durationSeconds: 3, technicalQCReport: { overall: "PASS", checks: [] } }, { actorId: "t" });
    renderId = render.id;
  }, 60000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("encodes a TikTok-profile variant once, records it, and reuses it on the next call", async () => {
    const first = await ensurePlatformVariant(prisma, storage, { renderId, platform: "TIKTOK", coverFrameSeconds: 1 }, { actorId: "t" });
    const row = await prisma.renderVariant.findUniqueOrThrow({ where: { id: first.renderVariantId } });
    expect(row.platform).toBe("TIKTOK");
    expect(row.profileVersion).toBe(platformProfileVersion("TIKTOK"));
    expect(row.width).toBe(1080);
    expect(row.height).toBe(1920);
    expect(row.coverStorageKey).toMatch(/cover\.jpg$/);
    const probed = await probeMedia(storage.pathFor(row.storageKey));
    expect(probed.videoCodec).toBe("h264");
    expect(probed.audioCodec).toBe("aac");

    const second = await ensurePlatformVariant(prisma, storage, { renderId, platform: "TIKTOK" }, { actorId: "t" });
    expect(second.renderVariantId).toBe(first.renderVariantId);
    expect(second.sha256).toBe(first.sha256);
    expect(await prisma.renderVariant.count({ where: { renderId } })).toBe(1);
  }, 120000);
});
