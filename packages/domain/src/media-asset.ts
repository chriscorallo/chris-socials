import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";
import { applyTransition } from "./state-machine";

/**
 * Raw media ingestion — spec §9 step 10. Phase 1 only recorded the fact of an upload
 * (storageKey + metadata); Phase 3 adds the technical/transcript analysis fields on this
 * same table (see /docs/DATA_MODEL.md) and the analyzeMediaAsset function below.
 */
export const CreateMediaAssetSchema = z.object({
  contentItemId: z.string().min(1),
  kind: z.enum(["RAW_TAKE"]),
  storageKey: z.string().min(1),
  originalFilename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});

export type CreateMediaAssetInput = z.infer<typeof CreateMediaAssetSchema>;

export async function createMediaAsset(
  prisma: PrismaClient,
  input: CreateMediaAssetInput,
  actor: { actorId: string },
) {
  const parsed = CreateMediaAssetSchema.parse(input);
  const asset = await prisma.mediaAsset.create({ data: parsed });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "MEDIA_ASSET_UPLOADED",
    entityType: "ContentItem",
    entityId: parsed.contentItemId,
    after: {
      mediaAssetId: asset.id,
      originalFilename: asset.originalFilename,
      sizeBytes: asset.sizeBytes,
    },
  });

  return asset;
}

export async function listMediaAssetsForContentItem(
  prisma: PrismaClient,
  contentItemId: string,
) {
  return prisma.mediaAsset.findMany({
    where: { contentItemId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getMediaAsset(prisma: PrismaClient, id: string) {
  return prisma.mediaAsset.findUnique({ where: { id } });
}

const MediaAnalysisSchema = z.object({
  durationSeconds: z.number().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  frameRate: z.number().positive().nullable(),
  hasAudio: z.boolean(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
  transcript: z.string().nullable().optional(),
});
export type MediaAnalysisInput = z.input<typeof MediaAnalysisSchema>;

/**
 * Records deterministic technical analysis (packages/media's probeMedia — no LLM judgment)
 * for a MediaAsset. This is the canonical trigger for FILMED -> MEDIA_INGESTED: analyzing
 * the first take for a ContentItem still in FILMED is what "ingestion" means, per spec §9
 * step 10 — same "issuing X advances state" pattern as ProductionContract/CreatorCard.
 */
export async function analyzeMediaAsset(
  prisma: PrismaClient,
  mediaAssetId: string,
  analysis: MediaAnalysisInput,
  actor: { actorId: string },
) {
  const parsed = MediaAnalysisSchema.parse(analysis);

  const asset = await prisma.mediaAsset.update({
    where: { id: mediaAssetId },
    data: {
      durationSeconds: parsed.durationSeconds,
      width: parsed.width,
      height: parsed.height,
      frameRate: parsed.frameRate,
      hasAudio: parsed.hasAudio,
      videoCodec: parsed.videoCodec,
      audioCodec: parsed.audioCodec,
      transcript: parsed.transcript ?? undefined,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "MEDIA_ASSET_ANALYZED",
    entityType: "ContentItem",
    entityId: asset.contentItemId,
    after: { mediaAssetId: asset.id, durationSeconds: asset.durationSeconds },
  });

  const item = await prisma.contentItem.findUnique({ where: { id: asset.contentItemId } });
  if (item?.currentState === "FILMED") {
    await applyTransition(prisma, {
      contentItemId: asset.contentItemId,
      to: "MEDIA_INGESTED",
      actorType: "HUMAN",
      actorId: actor.actorId,
      reason: "Raw media analyzed",
    });
  }

  return asset;
}

// ---------------------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------------------

export const TranscriptWordSchema = z.object({
  word: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});
export type TranscriptWordRecord = z.infer<typeof TranscriptWordSchema>;

export const TranscriptSourceSchema = z.enum(["LOCAL_WHISPER", "MANUAL"]);
export type TranscriptSource = z.infer<typeof TranscriptSourceSchema>;

const RecordTranscriptSchema = z.object({
  mediaAssetId: z.string().min(1),
  text: z.string(),
  /** Word timings on the source timeline, or null (e.g. a manually typed transcript). */
  words: z.array(TranscriptWordSchema).nullable(),
  source: TranscriptSourceSchema,
  /** Provenance detail, e.g. the Whisper model id. Audit-logged, not stored on the row. */
  model: z.string().optional(),
});
export type RecordTranscriptInput = z.input<typeof RecordTranscriptSchema>;

/**
 * Writes a take's transcript (+ word timings + provenance) and audit-logs it. Re-recording
 * replaces the row's current transcript, but the previous value's provenance is preserved
 * in the AuditLog `before` — the audit trail is the history (CLAUDE.md: never silently
 * delete an audit trail). A MANUAL transcript (words=null) clears stale word timings, since
 * typed text no longer matches them.
 */
export async function recordTranscript(
  prisma: PrismaClient,
  input: RecordTranscriptInput,
  actor: { actorId: string; actorType?: "HUMAN" | "SYSTEM" | "JOB" },
) {
  const parsed = RecordTranscriptSchema.parse(input);
  const words = parsed.words
    ? [...parsed.words]
        .sort((a, b) => a.start - b.start)
        .map((w) => ({ word: w.word, start: w.start, end: Math.max(w.start, w.end) }))
    : null;

  const before = await prisma.mediaAsset.findUniqueOrThrow({
    where: { id: parsed.mediaAssetId },
  });

  const asset = await prisma.mediaAsset.update({
    where: { id: parsed.mediaAssetId },
    data: {
      transcript: parsed.text,
      transcriptWords: words ?? Prisma.DbNull,
      transcriptSource: parsed.source,
      transcribedAt: new Date(),
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: actor.actorType ?? (parsed.source === "MANUAL" ? "HUMAN" : "JOB"),
    action: "MEDIA_ASSET_TRANSCRIBED",
    entityType: "ContentItem",
    entityId: asset.contentItemId,
    before: {
      mediaAssetId: before.id,
      transcriptSource: before.transcriptSource,
      transcriptLength: before.transcript?.length ?? 0,
      transcribedAt: before.transcribedAt,
    },
    after: {
      mediaAssetId: asset.id,
      transcriptSource: parsed.source,
      transcriptLength: parsed.text.length,
      wordCount: words?.length ?? null,
    },
    metadata: parsed.model ? { model: parsed.model } : undefined,
  });

  return asset;
}

/** Parses MediaAsset.transcriptWords (Json) defensively; null when absent or malformed. */
export function parseTranscriptWords(value: unknown): TranscriptWordRecord[] | null {
  if (value == null) return null;
  const result = z.array(TranscriptWordSchema).safeParse(value);
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------------------
// Subject track (where Chris is on screen over time)
// ---------------------------------------------------------------------------------------

/** One subject-track sample: SOURCE-timeline seconds + the protected head region as source
 * frame fractions (null = no face found). Mirrors packages/media's SubjectTrackSchema — the
 * domain validates the persisted shape itself (package-boundary rule). */
export const SubjectTrackSampleRecordSchema = z.object({
  t: z.number().nonnegative(),
  box: z
    .object({
      x: z.number().min(-0.01).max(1.01),
      y: z.number().min(-0.01).max(1.01),
      w: z.number().min(0).max(1.01),
      h: z.number().min(0).max(1.01),
    })
    .nullable(),
});
export const SubjectTrackRecordSchema = z.array(SubjectTrackSampleRecordSchema).max(20000);
export type SubjectTrackRecord = z.infer<typeof SubjectTrackRecordSchema>;

/**
 * Stores a take's subject track (from the deterministic face tracker) and audit-logs it with
 * provenance. Re-recording replaces the row's current track — the previous one's summary is
 * kept in the AuditLog `before` (same pattern as recordTranscript). No state transition: this
 * is analysis metadata, it never moves the content item.
 */
export async function recordSubjectTrack(
  prisma: PrismaClient,
  mediaAssetId: string,
  track: unknown,
  actor: { actorId: string; actorType?: "HUMAN" | "SYSTEM" | "JOB" },
  provenance: { model?: string; fps?: number; framesAnalyzed?: number; framesWithFace?: number } = {},
) {
  const parsed = SubjectTrackRecordSchema.parse(track);
  const sorted = [...parsed].sort((a, b) => a.t - b.t);
  const before = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaAssetId } });
  const previous = parseSubjectTrackRecord(before.subjectTrack);

  const asset = await prisma.mediaAsset.update({
    where: { id: mediaAssetId },
    data: { subjectTrack: sorted as never },
  });

  const withFace = sorted.filter((s) => s.box !== null).length;
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: actor.actorType ?? "JOB",
    action: "MEDIA_ASSET_SUBJECT_TRACKED",
    entityType: "ContentItem",
    entityId: asset.contentItemId,
    before: {
      mediaAssetId,
      hadTrack: previous !== null,
      samples: previous?.length ?? 0,
    },
    after: {
      mediaAssetId,
      samples: sorted.length,
      samplesWithFace: withFace,
      coverage: sorted.length ? Math.round((withFace / sorted.length) * 1000) / 1000 : 0,
    },
    metadata: provenance,
  });

  return asset;
}

/** Parses MediaAsset.subjectTrack (Json) defensively; null when absent or malformed. */
export function parseSubjectTrackRecord(value: unknown): SubjectTrackRecord | null {
  if (value == null) return null;
  const r = SubjectTrackRecordSchema.safeParse(value);
  return r.success ? r.data : null;
}
