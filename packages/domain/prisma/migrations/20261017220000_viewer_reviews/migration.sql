-- Viewer Panel: versioned AI first-time-viewer reviews of a render or a reference video.
-- New table only (additive); no existing rows change. Append-only by convention (a re-run is a
-- new row). See docs/decisions-pending/viewer-panel.md.

-- CreateTable
CREATE TABLE "ViewerReview" (
    "id" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL,
    "contentItemId" TEXT,
    "renderId" TEXT,
    "editPlanId" TEXT,
    "referenceContentId" TEXT,
    "mediaStorageKey" TEXT NOT NULL,
    "platform" "ContentPlatform" NOT NULL,
    "persona" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "review" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "inputSummary" JSONB NOT NULL,
    "verdictTier" TEXT NOT NULL,
    "estimatedCostUsd" DOUBLE PRECISION NOT NULL,
    "costUsd" DOUBLE PRECISION,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "jobRunId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ViewerReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ViewerReview_contentItemId_createdAt_idx" ON "ViewerReview"("contentItemId", "createdAt");

-- CreateIndex
CREATE INDEX "ViewerReview_referenceContentId_createdAt_idx" ON "ViewerReview"("referenceContentId", "createdAt");

-- CreateIndex
CREATE INDEX "ViewerReview_renderId_idx" ON "ViewerReview"("renderId");

-- AddForeignKey
ALTER TABLE "ViewerReview" ADD CONSTRAINT "ViewerReview_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ViewerReview" ADD CONSTRAINT "ViewerReview_renderId_fkey" FOREIGN KEY ("renderId") REFERENCES "Render"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ViewerReview" ADD CONSTRAINT "ViewerReview_editPlanId_fkey" FOREIGN KEY ("editPlanId") REFERENCES "EditPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ViewerReview" ADD CONSTRAINT "ViewerReview_referenceContentId_fkey" FOREIGN KEY ("referenceContentId") REFERENCES "ReferenceContent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
