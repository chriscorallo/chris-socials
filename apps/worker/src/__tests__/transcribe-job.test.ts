import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma, createContentItem, createMediaAsset, recordTranscript } from "@chris/domain";
import { MockTranscriptionProvider } from "@chris/agents";
import { LocalFsStorageAdapter } from "@chris/media";
import { transcribeMediaAsset, transcribeContentItemTakes } from "../transcribe-job";

/**
 * Orchestration test with a deterministic provider (the real Whisper path is exercised in
 * packages/media's RUN_WHISPER_TESTS suite). Proves: bytes go from storage to the provider,
 * text + word timings + provenance land on the MediaAsset, failures degrade safely, and a
 * human's manual transcript is never silently overwritten.
 */
describe("transcribe job", () => {
  let storageDir: string;
  let storage: LocalFsStorageAdapter;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "chris-transcribe-storage-"));
    storage = new LocalFsStorageAdapter({ baseDir: storageDir });
  });

  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  async function makeAsset(name = "take-1.mp4") {
    const item = await createContentItem(prisma, { title: "Transcribe job test" }, { actorId: "t" });
    const storageKey = `raw/${item.id}/${name}`;
    await storage.put(storageKey, Buffer.from("not really a video"));
    const asset = await createMediaAsset(
      prisma,
      {
        contentItemId: item.id,
        kind: "RAW_TAKE",
        storageKey,
        originalFilename: name,
        mimeType: "video/mp4",
        sizeBytes: 18,
      },
      { actorId: "chris" },
    );
    return { item, asset };
  }

  const provider = Object.assign(
    new MockTranscriptionProvider(() => ({
      text: "Hello world.",
      words: [
        { word: "Hello", start: 0.1, end: 0.4 },
        { word: "world.", start: 0.4, end: 0.8 },
      ],
    })),
    { model: "mock-whisper" },
  );

  it("persists text, word timings and provenance", async () => {
    const { asset } = await makeAsset();
    const result = await transcribeMediaAsset(prisma, storage, asset.id, { provider }, { actorId: "job" });
    expect(result).toMatchObject({ status: "SUCCESS", wordCount: 2, model: "mock-whisper" });
    const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.transcript).toBe("Hello world.");
    expect(row.transcriptSource).toBe("LOCAL_WHISPER");
    expect(row.transcriptWords).toEqual([
      { word: "Hello", start: 0.1, end: 0.4 },
      { word: "world.", start: 0.4, end: 0.8 },
    ]);
    expect(provider.calls.at(-1)).toMatch(/take\.mp4$/);
  });

  it("fails safely: a provider error returns FAILED and leaves the existing transcript alone", async () => {
    const { asset } = await makeAsset();
    await recordTranscript(prisma, { mediaAssetId: asset.id, text: "typed", words: null, source: "MANUAL" }, { actorId: "chris" });
    const broken = new MockTranscriptionProvider(() => {
      throw new Error("onnxruntime failed to load");
    });
    const result = await transcribeMediaAsset(prisma, storage, asset.id, { provider: broken }, { actorId: "job" });
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toContain("onnxruntime");
    const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.transcript).toBe("typed");
  });

  it("batch: skips manual transcripts and already-timed takes unless forced", async () => {
    const { item, asset: manual } = await makeAsset("a.mp4");
    await recordTranscript(prisma, { mediaAssetId: manual.id, text: "typed", words: null, source: "MANUAL" }, { actorId: "chris" });
    const fresh = await createMediaAsset(
      prisma,
      { contentItemId: item.id, kind: "RAW_TAKE", storageKey: manual.storageKey, originalFilename: "b.mp4", mimeType: "video/mp4", sizeBytes: 18 },
      { actorId: "chris" },
    );
    const results = await transcribeContentItemTakes(prisma, storage, item.id, { provider }, { actorId: "job" });
    expect(results.find((r) => r.mediaAssetId === manual.id)?.status).toBe("SKIPPED");
    expect(results.find((r) => r.mediaAssetId === fresh.id)?.status).toBe("SUCCESS");
    const again = await transcribeContentItemTakes(prisma, storage, item.id, { provider }, { actorId: "job" });
    expect(again.every((r) => r.status === "SKIPPED")).toBe(true);
  });
});
