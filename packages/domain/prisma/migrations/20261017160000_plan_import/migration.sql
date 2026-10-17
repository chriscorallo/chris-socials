-- AlterTable
ALTER TABLE "ContentItem" ADD COLUMN     "planImportId" TEXT;

-- CreateTable
CREATE TABLE "PlanImport" (
    "id" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceRef" TEXT,
    "rawInputHash" TEXT NOT NULL,
    "rawInputExcerpt" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneBy" TEXT,

    CONSTRAINT "PlanImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanImport_idempotencyKey_idx" ON "PlanImport"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ContentItem_planImportId_idx" ON "ContentItem"("planImportId");

-- AddForeignKey
ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_planImportId_fkey" FOREIGN KEY ("planImportId") REFERENCES "PlanImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
