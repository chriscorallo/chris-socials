-- CreateEnum
CREATE TYPE "Pillar" AS ENUM ('SKILL', 'MINDSET', 'LIFESTYLE', 'PASSIONS');

-- CreateEnum
CREATE TYPE "ProductionTier" AS ENUM ('RAW', 'FAST', 'MEDIUM', 'HERO');

-- CreateEnum
CREATE TYPE "ResearchDepth" AS ENUM ('NONE', 'LIGHT', 'STANDARD', 'DEEP');

-- CreateEnum
CREATE TYPE "FactualRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "FilmingSetup" AS ENUM ('DESK', 'STANDING', 'CASUAL', 'WALKING', 'SKIT', 'SPECIAL');

-- CreateEnum
CREATE TYPE "MediaAssetKind" AS ENUM ('RAW_TAKE');

-- AlterTable
ALTER TABLE "ContentItem" ADD COLUMN     "description" TEXT,
ADD COLUMN     "format" TEXT,
ADD COLUMN     "pillar" "Pillar";

-- CreateTable
CREATE TABLE "ProductionContract" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "primaryIdea" TEXT NOT NULL,
    "audiencePromise" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "productionTier" "ProductionTier" NOT NULL,
    "targetLengthMinSeconds" INTEGER NOT NULL,
    "targetLengthMaxSeconds" INTEGER NOT NULL,
    "researchDepth" "ResearchDepth" NOT NULL,
    "factualRisk" "FactualRisk" NOT NULL,
    "experiment" TEXT,
    "platformOpportunities" JSONB NOT NULL,
    "humanEditingBudgetMinutes" INTEGER,
    "requiredAssets" JSONB NOT NULL,
    "scope" TEXT NOT NULL,
    "doNotExpandInto" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorCard" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "talkingPoints" JSONB NOT NULL,
    "setup" "FilmingSetup" NOT NULL,
    "estimatedMinutes" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "kind" "MediaAssetKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleEntry" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "scheduledDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductionContract_contentItemId_key" ON "ProductionContract"("contentItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorCard_contentItemId_key" ON "CreatorCard"("contentItemId");

-- CreateIndex
CREATE INDEX "MediaAsset_contentItemId_idx" ON "MediaAsset"("contentItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleEntry_contentItemId_key" ON "ScheduleEntry"("contentItemId");

-- AddForeignKey
ALTER TABLE "ProductionContract" ADD CONSTRAINT "ProductionContract_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorCard" ADD CONSTRAINT "CreatorCard_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleEntry" ADD CONSTRAINT "ScheduleEntry_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

