-- Segmented recording + drafts: RecordingSession (the draft attached to a video) and
-- RecordingSegment (one per recorded segment). New tables only (additive); no existing rows
-- change. See docs/decisions-pending/segmented-recording-drafts.md.

-- CreateEnum
CREATE TYPE "RecordingSessionStatus" AS ENUM ('DRAFT', 'FINISHED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "RecordingSegmentStatus" AS ENUM ('ACTIVE', 'DELETED');

-- CreateTable
CREATE TABLE "RecordingSession" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "status" "RecordingSessionStatus" NOT NULL DEFAULT 'DRAFT',
    "scriptPosition" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "scriptFingerprint" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "discardedAt" TIMESTAMP(3),

    CONSTRAINT "RecordingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordingSegment" (
    "id" TEXT NOT NULL,
    "recordingSessionId" TEXT NOT NULL,
    "clientKey" TEXT NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "status" "RecordingSegmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "mediaAssetId" TEXT,
    "durationSeconds" DOUBLE PRECISION,
    "scriptPositionStart" DOUBLE PRECISION,
    "scriptPositionEnd" DOUBLE PRECISION,
    "originalFilename" TEXT,
    "sizeBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RecordingSegment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecordingSession_contentItemId_status_idx" ON "RecordingSession"("contentItemId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RecordingSegment_mediaAssetId_key" ON "RecordingSegment"("mediaAssetId");

-- CreateIndex
CREATE INDEX "RecordingSegment_recordingSessionId_segmentIndex_idx" ON "RecordingSegment"("recordingSessionId", "segmentIndex");

-- CreateIndex
CREATE UNIQUE INDEX "RecordingSegment_recordingSessionId_clientKey_key" ON "RecordingSegment"("recordingSessionId", "clientKey");

-- AddForeignKey
ALTER TABLE "RecordingSession" ADD CONSTRAINT "RecordingSession_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordingSegment" ADD CONSTRAINT "RecordingSegment_recordingSessionId_fkey" FOREIGN KEY ("recordingSessionId") REFERENCES "RecordingSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordingSegment" ADD CONSTRAINT "RecordingSegment_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
