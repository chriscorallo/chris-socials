import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prisma,
  createContentItem,
  applyTransition,
  createMediaAsset,
  analyzeMediaAsset,
  recordTakeSelection,
  recordEditPlan,
} from "@chris/domain";
import { FFMPEG_PATH, LocalFsStorageAdapter, probeMedia } from "@chris/media";
import { renderContentItem } from "../render-job";

/**
 * The real proof of Phase 3's acceptance criterion (/docs/PHASE_PLAN.md): "a raw fixture
 * video produces a valid EditPlan, renders deterministically via ffmpeg, output passes basic
 * technical QC." Every step here is real — a real ContentItem moved through the real state
 * machine, a real file in a real (local-fs) StorageAdapter, a real ffmpeg render, real
 * ffprobe-based QC. Only the EditPlan's *content* is hand-constructed rather than coming from
 * a live model call — that agent call itself is already proven separately (with a mock
 * provider) in packages/agents; this test proves the render pipeline actually consumes a
 * real EditPlan correctly, which is the part that couldn't be proven there.
 */
const DEV_FONT_PATH = "/System/Library/Fonts/Supplemental/Arial.ttf";

function runFfmpegRaw(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args);
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-1000)))));
  });
}

describe("renderContentItem (real ffmpeg, real storage, real state machine)", () => {
  let storageDir: string;
  let storage: LocalFsStorageAdapter;
  let fixtureBytes: Buffer;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "chris-worker-storage-"));
    storage = new LocalFsStorageAdapter({ baseDir: storageDir });

    const genDir = await mkdtemp(join(tmpdir(), "chris-worker-fixture-"));
    const fixturePath = join(genDir, "fixture.mp4");
    await runFfmpegRaw([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x480:duration=8:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:duration=8",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      fixturePath,
    ]);
    const { readFile } = await import("node:fs/promises");
    fixtureBytes = await readFile(fixturePath);
    await rm(genDir, { recursive: true, force: true });
  }, 30000);

  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  async function makeEditPlannedItemWithRealMedia() {
    const item = await createContentItem(prisma, { title: "Render job test idea" }, {
      actorId: "test-user",
    });
    for (const to of [
      "SELECTED",
      "CONTRACTED",
      "RESEARCHING",
      "RESEARCHED",
      "SCRIPTING",
      "SCRIPTED",
      "READY_TO_FILM",
      "FILMED",
    ] as const) {
      await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
    }

    const storageKey = `raw/${item.id}/take-1.mp4`;
    await storage.put(storageKey, fixtureBytes);

    const asset = await createMediaAsset(
      prisma,
      {
        contentItemId: item.id,
        kind: "RAW_TAKE",
        storageKey,
        originalFilename: "take-1.mp4",
        mimeType: "video/mp4",
        sizeBytes: fixtureBytes.byteLength,
      },
      { actorId: "chris" },
    );

    const probed = await probeMedia(join(storageDir, storageKey));
    await analyzeMediaAsset(
      prisma,
      asset.id,
      {
        durationSeconds: probed.durationSeconds,
        width: probed.width,
        height: probed.height,
        frameRate: probed.frameRate,
        hasAudio: probed.hasAudio,
        videoCodec: probed.videoCodec,
        audioCodec: probed.audioCodec,
        transcript: "This is a real take about a synthetic test pattern.",
      },
      { actorId: "chris" },
    );

    const selection = await recordTakeSelection(
      prisma,
      {
        contentItemId: item.id,
        selectedMediaAssetId: asset.id,
        confidence: 0.9,
        reason: "Only take available.",
      },
      { actorId: "chris" },
    );

    const editPlan = await recordEditPlan(
      prisma,
      {
        contentItemId: item.id,
        takeSelectionId: selection.id,
        productionTier: "FAST",
        targetDurationSeconds: 4,
        plan: {
          segments: [{ startSeconds: 1, endSeconds: 5 }],
          targetDimensions: { width: 1080, height: 1920 },
          textOverlays: [
            {
              text: "A real headline from a real EditPlan",
              startSeconds: 0,
              endSeconds: 2,
              position: "BOTTOM",
              style: "HEADLINE",
            },
          ],
          normalizeAudio: true,
          bRollRequests: [],
          musicTrack: null,
          sfxEvents: [],
          transitions: [],
          targetDurationSeconds: 4,
          productionTier: "FAST",
          doNothingElse: false,
          rationale: "Trim to the strongest 4 seconds and add the hook headline.",
        },
      },
      { actorId: "chris" },
    );

    return { item, asset, selection, editPlan, sourceStorageKey: storageKey };
  }

  it(
    "renders end-to-end and lands the ContentItem at RENDERED with a passing technical QC report",
    async () => {
      const { item } = await makeEditPlannedItemWithRealMedia();

      const result = await renderContentItem(
        prisma,
        storage,
        item.id,
        { fontPath: DEV_FONT_PATH },
        { actorId: "chris" },
      );

      expect(result.status).toBe("SUCCESS");
      expect(result.outputStorageKey).toBeTruthy();
      const qc = result.technicalQCReport as { overall: string };
      expect(qc.overall).toBe("PASS");

      // The rendered file genuinely exists in storage and is a real, valid video.
      const outputBytes = await storage.get(result.outputStorageKey!);
      expect(outputBytes.byteLength).toBeGreaterThan(1000);

      const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(updated.currentState).toBe("RENDERED");

      const renderRow = await prisma.render.findFirst({
        where: { contentItemId: item.id },
        orderBy: { createdAt: "desc" },
      });
      expect(renderRow?.width).toBe(1080);
      expect(renderRow?.height).toBe(1920);
    },
    30000,
  );

  it(
    "an EditPlan with a segment past the source duration fails the render, not silently truncates",
    async () => {
      const { item, editPlan } = await makeEditPlannedItemWithRealMedia();

      // Overwrite with an out-of-bounds plan directly (bypassing the agent's own bounds
      // check, which is tested separately in packages/agents) to prove the renderer itself
      // surfaces a real ffmpeg error rather than producing a corrupt/truncated file.
      await prisma.editPlan.update({
        where: { id: editPlan.id },
        data: {
          plan: {
            segments: [{ startSeconds: 0, endSeconds: 9999 }],
            targetDimensions: null,
            textOverlays: [],
            normalizeAudio: false,
            bRollRequests: [],
            musicTrack: null,
            sfxEvents: [],
            transitions: [],
            targetDurationSeconds: 9999,
            productionTier: "FAST",
            doNothingElse: false,
            rationale: "deliberately invalid for this test",
          },
        },
      });

      const result = await renderContentItem(
        prisma,
        storage,
        item.id,
        { fontPath: DEV_FONT_PATH },
        { actorId: "chris" },
      );

      expect(result.status).toBe("FAILED");
      expect(result.errorMessage).toBeTruthy();

      // Stays in EDITING — a technical execution failure isn't a QC finding (see
      // render-record.ts), so no transition happens and it's clear this needs a real retry.
      const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(updated.currentState).toBe("EDITING");
    },
    30000,
  );

  it(
    "a repair re-render from QC_REPAIR does not try (and fail) to re-enter EDITING first",
    async () => {
      const { item } = await makeEditPlannedItemWithRealMedia();

      // Drive the item to QC_REPAIR the same way the real repair loop would: a first
      // render whose (fabricated) QC result fails.
      await applyTransition(prisma, { contentItemId: item.id, to: "EDITING", actorType: "SYSTEM" });
      await applyTransition(prisma, { contentItemId: item.id, to: "RENDERED", actorType: "SYSTEM" });
      await applyTransition(prisma, {
        contentItemId: item.id,
        to: "QC_REPAIR",
        actorType: "SYSTEM",
        reason: "simulated prior QC failure",
      });

      const result = await renderContentItem(
        prisma,
        storage,
        item.id,
        { fontPath: DEV_FONT_PATH },
        { actorId: "chris" },
      );

      expect(result.status).toBe("SUCCESS");
      const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(updated.currentState).toBe("RENDERED");
    },
    30000,
  );
});
