-- Reference videos: uploaded media + deterministic style measurements on ReferenceContent.
-- Additive and nullable only — existing notes-only rows are untouched (no backfill needed).

-- CreateEnum
CREATE TYPE "ReferenceAnalysisStatus" AS ENUM ('PENDING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "ReferenceContent" ADD COLUMN     "analysisError" TEXT,
ADD COLUMN     "analysisStatus" "ReferenceAnalysisStatus",
ADD COLUMN     "analyzedAt" TIMESTAMP(3),
ADD COLUMN     "mediaDeletedAt" TIMESTAMP(3),
ADD COLUMN     "mediaFilename" TEXT,
ADD COLUMN     "mediaMimeType" TEXT,
ADD COLUMN     "mediaSizeBytes" DOUBLE PRECISION,
ADD COLUMN     "mediaStorageKey" TEXT,
ADD COLUMN     "mediaUploadedAt" TIMESTAMP(3),
ADD COLUMN     "metrics" JSONB,
ADD COLUMN     "metricsVersion" INTEGER;

-- CreateIndex
CREATE INDEX "ReferenceContent_analysisStatus_idx" ON "ReferenceContent"("analysisStatus");
