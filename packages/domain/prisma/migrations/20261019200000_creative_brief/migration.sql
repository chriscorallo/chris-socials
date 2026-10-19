-- Content Intelligence (docs/DECISIONS.md "Creative Brief"): one append-only creative plan per
-- video revision, plus the item's series. Additive: existing items keep series NULL.
-- AlterTable
ALTER TABLE "ContentItem" ADD COLUMN "series" TEXT;

-- CreateTable
CREATE TABLE "CreativeBrief" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "scriptVersionId" TEXT,
    "source" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "primaryObjective" TEXT NOT NULL,
    "hookMechanism" TEXT,
    "brief" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeBrief_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreativeBrief_contentItemId_createdAt_idx" ON "CreativeBrief"("contentItemId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeBrief_series_idx" ON "CreativeBrief"("series");

-- AddForeignKey
ALTER TABLE "CreativeBrief" ADD CONSTRAINT "CreativeBrief_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
