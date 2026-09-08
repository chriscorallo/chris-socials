-- CreateEnum
CREATE TYPE "HardGateStatus" AS ENUM ('PASS', 'BLOCK');

-- CreateEnum
CREATE TYPE "QCSeverity" AS ENUM ('INFO', 'MINOR', 'MAJOR', 'BLOCKING');

-- CreateTable
CREATE TABLE "QCReport" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "renderId" TEXT NOT NULL,
    "factualStatus" "HardGateStatus" NOT NULL,
    "technicalStatus" "HardGateStatus" NOT NULL,
    "brandStatus" "HardGateStatus" NOT NULL,
    "creativeStatus" "HardGateStatus" NOT NULL,
    "overallStatus" "HardGateStatus" NOT NULL,
    "reasons" JSONB NOT NULL,
    "visualQAImpression" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QCReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QCIssue" (
    "id" TEXT NOT NULL,
    "qcReportId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "QCSeverity" NOT NULL,
    "timestampSeconds" DOUBLE PRECISION,
    "recommendedRepair" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QCIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QCReport_contentItemId_idx" ON "QCReport"("contentItemId");

-- CreateIndex
CREATE INDEX "QCReport_renderId_idx" ON "QCReport"("renderId");

-- CreateIndex
CREATE INDEX "QCIssue_qcReportId_idx" ON "QCIssue"("qcReportId");

-- AddForeignKey
ALTER TABLE "QCReport" ADD CONSTRAINT "QCReport_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QCReport" ADD CONSTRAINT "QCReport_renderId_fkey" FOREIGN KEY ("renderId") REFERENCES "Render"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QCIssue" ADD CONSTRAINT "QCIssue_qcReportId_fkey" FOREIGN KEY ("qcReportId") REFERENCES "QCReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

