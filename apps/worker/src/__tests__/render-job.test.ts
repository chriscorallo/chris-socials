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
  recordTranscript,
  saveFinishingEdit,
} from "@chris/domain";
import { EditPlanOutputSchema } from "@chris/agents";
import { mapEditPlanToRenderInstructions, listUnexecutedPlanInstructions } from "../render-job";
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
        {},
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
        {},
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
        {},
        { actorId: "chris" },
      );

      expect(result.status).toBe("SUCCESS");
      const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(updated.currentState).toBe("RENDERED");
    },
    30000,
  );

  it(
    "burns in captions from the take's word timings, executes punch-ins, and records unexecuted plan instructions",
    async () => {
      const { item, asset, editPlan } = await makeEditPlannedItemWithRealMedia();
      await recordTranscript(
        prisma,
        {
          mediaAssetId: asset.id,
          text: "This is a real take about a synthetic test pattern.",
          words: [
            { word: "This", start: 1.2, end: 1.4 },
            { word: "is", start: 1.4, end: 1.5 },
            { word: "a", start: 1.5, end: 1.6 },
            { word: "real", start: 1.6, end: 1.9 },
            { word: "take.", start: 1.9, end: 2.3 },
            { word: "About", start: 3.0, end: 3.3 },
            { word: "a", start: 3.3, end: 3.4 },
            { word: "pattern.", start: 3.4, end: 3.9 },
          ],
          source: "LOCAL_WHISPER",
        },
        { actorId: "job" },
      );
      const plan = editPlan.plan as Record<string, unknown>;
      await prisma.editPlan.update({
        where: { id: editPlan.id },
        data: {
          plan: {
            ...plan,
            captions: { enabled: true, style: "BOLD_HIGHLIGHT", position: "LOWER" },
            punchIns: [{ startSeconds: 1, endSeconds: 2, zoom: 1.2, focus: "UPPER_THIRD" }],
            bRollRequests: ["city skyline at dusk"],
          },
        },
      });

      const result = await renderContentItem(prisma, storage, item.id, {}, { actorId: "chris" });
      expect(result.status).toBe("SUCCESS");
      expect(result.unexecutedInstructions).toEqual([
        'B-roll request not executed (no asset library): "city skyline at dusk"',
      ]);
      const report = result.technicalQCReport as {
        overall: string;
        unexecutedInstructions: string[];
        captions: { rendered: number };
      };
      expect(report.overall).toBe("PASS");
      expect(report.captions.rendered).toBeGreaterThanOrEqual(2);
      const row = await prisma.render.findFirst({
        where: { contentItemId: item.id },
        orderBy: { createdAt: "desc" },
      });
      expect((row?.technicalQCReport as { unexecutedInstructions: string[] }).unexecutedInstructions).toHaveLength(1);
    },
    60000,
  );
});

describe("renderContentItem with a finishing-edit timeline (multi-take)", () => {
  let storageDir: string;
  let storage: LocalFsStorageAdapter;
  let takeBytes: Buffer[];

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "chris-worker-storage-"));
    storage = new LocalFsStorageAdapter({ baseDir: storageDir });
    const genDir = await mkdtemp(join(tmpdir(), "chris-worker-fixture-"));
    const { readFile } = await import("node:fs/promises");
    takeBytes = [];
    // Take 1: 640x480@30 with audio. Take 2: portrait 720x1280@25, no audio.
    await runFfmpegRaw(["-y", "-f", "lavfi", "-i", "testsrc=size=640x480:duration=6:rate=30", "-f", "lavfi", "-i", "sine=frequency=500:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(genDir, "t1.mp4")]);
    await runFfmpegRaw(["-y", "-f", "lavfi", "-i", "testsrc2=size=720x1280:duration=6:rate=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(genDir, "t2.mp4")]);
    takeBytes.push(await readFile(join(genDir, "t1.mp4")), await readFile(join(genDir, "t2.mp4")));
    await rm(genDir, { recursive: true, force: true });
  }, 30000);

  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  async function itemWithTwoTakes() {
    const item = await createContentItem(prisma, { title: "Finishing edit render" }, { actorId: "test-user" });
    for (const to of ["SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED", "READY_TO_FILM", "FILMED"] as const) {
      await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
    }
    const assets = [];
    for (const [i, bytes] of takeBytes.entries()) {
      const storageKey = `raw/${item.id}/take-${i + 1}.mp4`;
      await storage.put(storageKey, bytes);
      assets.push(
        await createMediaAsset(
          prisma,
          { contentItemId: item.id, kind: "RAW_TAKE", storageKey, originalFilename: `take-${i + 1}.mp4`, mimeType: "video/mp4", sizeBytes: bytes.byteLength },
          { actorId: "chris" },
        ),
      );
      const probed = await probeMedia(join(storageDir, storageKey));
      await analyzeMediaAsset(
        prisma,
        assets[i]!.id,
        {
          durationSeconds: probed.durationSeconds, width: probed.width, height: probed.height, frameRate: probed.frameRate,
          hasAudio: probed.hasAudio, videoCodec: probed.videoCodec, audioCodec: probed.audioCodec, transcript: `take ${i + 1}`,
        },
        { actorId: "chris" },
      );
    }
    await recordTranscript(prisma, { mediaAssetId: assets[0]!.id, text: "first take words", words: [{ word: "first", start: 1.1, end: 1.5 }, { word: "take", start: 1.5, end: 1.9 }, { word: "words.", start: 1.9, end: 2.4 }], source: "LOCAL_WHISPER" }, { actorId: "job" });
    await recordTranscript(prisma, { mediaAssetId: assets[1]!.id, text: "second take", words: [{ word: "second", start: 3.2, end: 3.6 }, { word: "take.", start: 3.6, end: 4.0 }], source: "LOCAL_WHISPER" }, { actorId: "job" });
    const selection = await recordTakeSelection(prisma, { contentItemId: item.id, selectedMediaAssetId: assets[0]!.id, confidence: 0.9, reason: "best" }, { actorId: "chris" });
    const editPlan = await recordEditPlan(
      prisma,
      {
        contentItemId: item.id,
        takeSelectionId: selection.id,
        productionTier: "FAST",
        targetDurationSeconds: 3,
        plan: {
          segments: [{ startSeconds: 1, endSeconds: 4 }], targetDimensions: { width: 1080, height: 1920 }, textOverlays: [], normalizeAudio: true,
          bRollRequests: [], musicTrack: null, sfxEvents: [], transitions: [], targetDurationSeconds: 3, productionTier: "FAST", doNothingElse: false, rationale: "base",
        },
      },
      { actorId: "chris" },
    );
    return { item, assets, editPlan };
  }

  it(
    "renders Chris's timeline: clips from BOTH takes, his texts/grade/captions — not the AI plan",
    async () => {
      const { item, assets } = await itemWithTwoTakes();
      const timeline = {
        version: 2,
        clips: [
          { id: "a", mediaAssetId: assets[0]!.id, sourceStart: 1, sourceEnd: 2.5 },
          { id: "b", mediaAssetId: assets[1]!.id, sourceStart: 3, sourceEnd: 4.5, crop: { zoom: 1.2, panX: 0.5, panY: 0 } },
        ],
        texts: [{ id: "t", text: "Chris's own headline", start: 0, end: 3, fontId: "bebas-neue", fontSize: 110, color: "#FFFFFF", backgroundColor: "#000000AA" }],
        captions: { preset: "KARAOKE", fontId: "montserrat-black", fontSize: 70, color: "#FFFFFF", highlightColor: "#FFD84D" },
        zooms: [{ id: "z", start: 2, end: 2.8, zoom: 1.3, mode: "EASE", easeSeconds: 0.4 }],
        grade: { preset: "CINEMATIC" },
      };
      await saveFinishingEdit(prisma, { contentItemId: item.id, timeline, durationSeconds: 3, actorId: "chris" });

      const result = await renderContentItem(prisma, storage, item.id, { encode: { preset: "ultrafast" } }, { actorId: "chris" });
      expect(result.status).toBe("SUCCESS");
      const report = result.technicalQCReport as { overall: string; timelineSource: string; renderEngine: string; captions: { rendered: number } };
      expect(report.overall).toBe("PASS");
      expect(report.timelineSource).toBe("FINISHING_EDIT");
      expect(report.renderEngine).toBe("timeline-v2");
      expect(report.captions.rendered).toBe(2); // one phrase per take
      expect(result.unexecutedInstructions).toEqual([expect.stringMatching(/clip 2 \(b\): source has no audio/)]);
      const row = await prisma.render.findFirst({ where: { contentItemId: item.id }, orderBy: { createdAt: "desc" } });
      expect(row?.durationSeconds).toBeGreaterThan(2.9);
      expect(row?.durationSeconds).toBeLessThan(3.1);
      expect(row?.width).toBe(1080);
    },
    90000,
  );

  it("an invalid finishing-edit timeline fails the render instead of silently rendering the AI plan", async () => {
    const { item, editPlan } = await itemWithTwoTakes();
    await prisma.editPlan.update({
      where: { id: editPlan.id },
      data: { plan: { ...(editPlan.plan as Record<string, unknown>), timeline: { version: 2, clips: [] } } },
    });
    const result = await renderContentItem(prisma, storage, item.id, {}, { actorId: "chris" });
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toMatch(/finishing-edit timeline/);
  }, 30000);

  it("refuses a timeline that pulls media from another content item", async () => {
    const { item, editPlan } = await itemWithTwoTakes();
    const other = await itemWithTwoTakes();
    await prisma.editPlan.update({
      where: { id: editPlan.id },
      data: {
        plan: {
          ...(editPlan.plan as Record<string, unknown>),
          timeline: {
            version: 2,
            clips: [{ id: "x", mediaAssetId: other.assets[0]!.id, sourceStart: 0, sourceEnd: 2 }],
            captions: { fontId: "inter-display-bold", fontSize: 64, color: "#FFFFFF", highlightColor: "#FFD84D" },
          },
        },
      },
    });
    const result = await renderContentItem(prisma, storage, item.id, {}, { actorId: "chris" });
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toMatch(/don't belong to this item/);
  }, 30000);
});

describe("mapEditPlanToRenderInstructions (pure)", () => {
  const legacy = EditPlanOutputSchema.parse({
    segments: [{ startSeconds: 0, endSeconds: 2 }],
    targetDimensions: { width: 1080, height: 1920 },
    textOverlays: [{ text: "Hi", startSeconds: 0, endSeconds: 1, position: "TOP", style: "NUMBER_CALLOUT" }],
    normalizeAudio: true,
    bRollRequests: [],
    musicTrack: "lofi",
    sfxEvents: [{ atSeconds: 1, sfx: "whoosh" }],
    transitions: [{ atSeconds: 1, type: "crossfade" }],
    targetDurationSeconds: 2,
    productionTier: "FAST",
    doNothingElse: false,
    rationale: "legacy row without captions/punchIns",
  });

  it("defaults captions on (CLEAN, LOWER) for a legacy plan when word timings exist, off when they don't", () => {
    const words = [{ word: "Hi", start: 0, end: 0.4 }];
    const withWords = mapEditPlanToRenderInstructions(legacy, "/in.mp4", "/out.mp4", undefined, words);
    expect(withWords.captions?.config).toEqual({ enabled: true, style: "CLEAN", position: "LOWER" });
    expect(withWords.textOverlays[0]!.style).toBe("NUMBER_CALLOUT");
    expect(withWords.fontPath).toBeUndefined();
    const without = mapEditPlanToRenderInstructions(legacy, "/in.mp4", "/out.mp4", undefined, null);
    expect(without.captions).toBeNull();
  });

  it("respects an explicit captions-off decision", () => {
    const off = { ...legacy, captions: { enabled: false, style: "CLEAN" as const, position: "LOWER" as const } };
    const words = [{ word: "Hi", start: 0, end: 0.4 }];
    expect(mapEditPlanToRenderInstructions(off, "/in", "/out", undefined, words).captions).toBeNull();
  });

  it("lists music/SFX/transitions as unexecuted rather than dropping them", () => {
    expect(listUnexecutedPlanInstructions(legacy)).toEqual([
      'Music track not executed (no asset library): "lofi"',
      'SFX not executed (no asset library): "whoosh" at 1s',
      'Transition not executed (all cuts are hard cuts): "crossfade" at 1s',
    ]);
  });
});
