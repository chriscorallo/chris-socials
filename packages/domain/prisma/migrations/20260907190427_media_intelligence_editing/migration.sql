-- CreateEnum
CREATE TYPE "RenderStatus" AS ENUM ('SUCCESS', 'FAILED');

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "audioCodec" TEXT,
ADD COLUMN     "durationSeconds" DOUBLE PRECISION,
ADD COLUMN     "frameRate" DOUBLE PRECISION,
ADD COLUMN     "hasAudio" BOOLEAN,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "transcript" TEXT,
ADD COLUMN     "videoCodec" TEXT,
ADD COLUMN     "width" INTEGER;

-- CreateTable
CREATE TABLE "TakeSelection" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "selectedMediaAssetId" TEXT NOT NULL,
    "backupMediaAssetId" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "materialDefects" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TakeSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EditPlan" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "takeSelectionId" TEXT NOT NULL,
    "productionTier" "ProductionTier" NOT NULL,
    "targetDurationSeconds" DOUBLE PRECISION NOT NULL,
    "doNothingElse" BOOLEAN NOT NULL DEFAULT false,
    "plan" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Render" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "editPlanId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "RenderStatus" NOT NULL,
    "storageKey" TEXT,
    "durationSeconds" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "fileSizeBytes" INTEGER,
    "technicalQCReport" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Render_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TakeSelection_contentItemId_idx" ON "TakeSelection"("contentItemId");

-- CreateIndex
CREATE INDEX "EditPlan_contentItemId_idx" ON "EditPlan"("contentItemId");

-- CreateIndex
CREATE INDEX "Render_contentItemId_idx" ON "Render"("contentItemId");

-- CreateIndex
CREATE INDEX "Render_editPlanId_idx" ON "Render"("editPlanId");

-- AddForeignKey
ALTER TABLE "TakeSelection" ADD CONSTRAINT "TakeSelection_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TakeSelection" ADD CONSTRAINT "TakeSelection_selectedMediaAssetId_fkey" FOREIGN KEY ("selectedMediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditPlan" ADD CONSTRAINT "EditPlan_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditPlan" ADD CONSTRAINT "EditPlan_takeSelectionId_fkey" FOREIGN KEY ("takeSelectionId") REFERENCES "TakeSelection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Render" ADD CONSTRAINT "Render_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Render" ADD CONSTRAINT "Render_editPlanId_fkey" FOREIGN KEY ("editPlanId") REFERENCES "EditPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

