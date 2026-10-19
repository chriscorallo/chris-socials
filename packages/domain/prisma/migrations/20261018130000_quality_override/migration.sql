-- Owner override: "skip the AI quality check" (Chris's decision as owner, spec §5). New table
-- only (additive); no existing rows change. See docs/decisions-pending/quality-override.md.

-- CreateTable
CREATE TABLE "QualityOverride" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "renderId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "aiUnavailableReason" TEXT,
    "technicalStatus" "HardGateStatus" NOT NULL,
    "technicalIssues" JSONB NOT NULL,
    "skippedChecks" JSONB NOT NULL,
    "unverifiedClaims" JSONB NOT NULL,
    "factualConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "decisionJournalEntryId" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QualityOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QualityOverride_contentItemId_idx" ON "QualityOverride"("contentItemId");

-- CreateIndex
CREATE INDEX "QualityOverride_renderId_idx" ON "QualityOverride"("renderId");

-- AddForeignKey
ALTER TABLE "QualityOverride" ADD CONSTRAINT "QualityOverride_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualityOverride" ADD CONSTRAINT "QualityOverride_renderId_fkey" FOREIGN KEY ("renderId") REFERENCES "Render"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
