import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { applyTransition } from "../state-machine";
import {
  analyzeMediaAsset,
  createMediaAsset,
  listMediaAssetsForContentItem,
  getMediaAsset,
  recordTranscript,
  parseTranscriptWords,
} from "../media-asset";

describe("media assets (raw upload)", () => {
  it("records an uploaded raw take against a content item", async () => {
    const item = await createContentItem(prisma, { title: "Upload test idea" }, {
      actorId: "test-user",
    });

    const asset = await createMediaAsset(
      prisma,
      {
        contentItemId: item.id,
        kind: "RAW_TAKE",
        storageKey: `raw/${item.id}/take-1.mp4`,
        originalFilename: "take-1.mp4",
        mimeType: "video/mp4",
        sizeBytes: 12_345,
      },
      { actorId: "chris" },
    );

    expect(asset.contentItemId).toBe(item.id);

    const listed = await listMediaAssetsForContentItem(prisma, item.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(asset.id);

    const fetched = await getMediaAsset(prisma, asset.id);
    expect(fetched?.originalFilename).toBe("take-1.mp4");
  });

  it("audit-logs the upload against the content item", async () => {
    const item = await createContentItem(prisma, { title: "Upload audit test" }, {
      actorId: "test-user",
    });
    await createMediaAsset(
      prisma,
      {
        contentItemId: item.id,
        kind: "RAW_TAKE",
        storageKey: `raw/${item.id}/take-1.mp4`,
        originalFilename: "take-1.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1,
      },
      { actorId: "chris" },
    );

    const audit = await prisma.auditLog.findMany({
      where: { entityType: "ContentItem", entityId: item.id, action: "MEDIA_ASSET_UPLOADED" },
    });
    expect(audit).toHaveLength(1);
  });
});

describe("recordTranscript", () => {
  async function makeAsset() {
    const item = await createContentItem(prisma, { title: "Transcript test" }, { actorId: "test-user" });
    return createMediaAsset(
      prisma,
      {
        contentItemId: item.id,
        kind: "RAW_TAKE",
        storageKey: `raw/${item.id}/take-1.mp4`,
        originalFilename: "take-1.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1,
      },
      { actorId: "chris" },
    );
  }

  it("stores text, sorted word timings and provenance, and audit-logs with the model", async () => {
    const asset = await makeAsset();
    const updated = await recordTranscript(
      prisma,
      {
        mediaAssetId: asset.id,
        text: "Hello world.",
        words: [
          { word: "world.", start: 0.5, end: 0.9 },
          { word: "Hello", start: 0.1, end: 0.5 },
        ],
        source: "LOCAL_WHISPER",
        model: "onnx-community/whisper-base.en_timestamped",
      },
      { actorId: "transcribe-job", actorType: "JOB" },
    );
    expect(updated.transcript).toBe("Hello world.");
    expect(updated.transcriptSource).toBe("LOCAL_WHISPER");
    expect(updated.transcribedAt).toBeInstanceOf(Date);
    const words = parseTranscriptWords(updated.transcriptWords);
    expect(words?.map((w) => w.word)).toEqual(["Hello", "world."]);

    const audit = await prisma.auditLog.findMany({
      where: { entityType: "ContentItem", entityId: asset.contentItemId, action: "MEDIA_ASSET_TRANSCRIBED" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorType).toBe("JOB");
    expect(audit[0]!.metadata).toMatchObject({ model: "onnx-community/whisper-base.en_timestamped" });
    expect(audit[0]!.after).toMatchObject({ wordCount: 2, transcriptSource: "LOCAL_WHISPER" });
  });

  it("a manual transcript clears stale word timings and keeps the prior provenance in the audit trail", async () => {
    const asset = await makeAsset();
    await recordTranscript(
      prisma,
      { mediaAssetId: asset.id, text: "auto", words: [{ word: "auto", start: 0, end: 0.3 }], source: "LOCAL_WHISPER" },
      { actorId: "job" },
    );
    const manual = await recordTranscript(
      prisma,
      { mediaAssetId: asset.id, text: "What I actually said.", words: null, source: "MANUAL" },
      { actorId: "chris" },
    );
    expect(manual.transcriptWords).toBeNull();
    expect(manual.transcriptSource).toBe("MANUAL");
    const audit = await prisma.auditLog.findMany({
      where: { entityId: asset.contentItemId, action: "MEDIA_ASSET_TRANSCRIBED" },
      orderBy: { createdAt: "asc" },
    });
    expect(audit).toHaveLength(2);
    expect(audit[1]!.actorType).toBe("HUMAN");
    expect(audit[1]!.before).toMatchObject({ transcriptSource: "LOCAL_WHISPER" });
  });

  it("parseTranscriptWords tolerates absent/malformed JSON", () => {
    expect(parseTranscriptWords(null)).toBeNull();
    expect(parseTranscriptWords([{ nope: 1 }])).toBeNull();
  });
});

describe("music assets (MediaAssetKind MUSIC)", () => {
  async function filmedItem(title: string) {
    const item = await createContentItem(prisma, { title }, { actorId: "test-user" });
    for (const to of ["SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED", "READY_TO_FILM", "FILMED"] as const) {
      await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
    }
    return item;
  }
  const music = (contentItemId: string, mimeType = "audio/mpeg") => ({
    contentItemId,
    kind: "MUSIC" as const,
    storageKey: `music/${contentItemId}/bed.mp3`,
    originalFilename: "bed.mp3",
    mimeType,
    sizeBytes: 2048,
  });

  it("records a music bed, keeps it out of the takes list, and never ingests the item", async () => {
    const item = await filmedItem("Music bed test");
    const asset = await createMediaAsset(prisma, music(item.id), { actorId: "chris" });
    expect(asset.kind).toBe("MUSIC");

    expect(await listMediaAssetsForContentItem(prisma, item.id)).toHaveLength(0);
    expect((await listMediaAssetsForContentItem(prisma, item.id, { kind: "MUSIC" })).map((a) => a.id)).toEqual([asset.id]);
    expect(await listMediaAssetsForContentItem(prisma, item.id, { kind: "ALL" })).toHaveLength(1);

    await analyzeMediaAsset(
      prisma,
      asset.id,
      { durationSeconds: 95, width: null, height: null, frameRate: null, hasAudio: true, videoCodec: null, audioCodec: "mp3" },
      { actorId: "chris" },
    );
    const after = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.currentState).toBe("FILMED");
  });

  it("refuses a non-audio file as music", async () => {
    const item = await createContentItem(prisma, { title: "Music mime test" }, { actorId: "test-user" });
    await expect(createMediaAsset(prisma, music(item.id, "video/mp4"), { actorId: "chris" })).rejects.toThrow(/audio file/);
  });
});
