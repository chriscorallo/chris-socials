-- CreateEnum
CREATE TYPE "SnapshotOffset" AS ENUM ('T_PLUS_1H', 'T_PLUS_6H', 'T_PLUS_24H', 'T_PLUS_72H', 'T_PLUS_7D', 'T_PLUS_30D');

-- CreateTable
CREATE TABLE "PerformanceSnapshot" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "platform" "ContentPlatform" NOT NULL,
    "offset" "SnapshotOffset" NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "viewCount" INTEGER,
    "likeCount" INTEGER,
    "commentCount" INTEGER,
    "shareCount" INTEGER,
    "saveCount" INTEGER,
    "reach" INTEGER,
    "avgWatchTimeSeconds" DOUBLE PRECISION,
    "rawResponse" JSONB,

    CONSTRAINT "PerformanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "platform" "ContentPlatform" NOT NULL,
    "platformCommentId" TEXT NOT NULL,
    "authorHandle" TEXT,
    "text" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3),
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudienceInsight" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "supportingCommentCount" INTEGER NOT NULL,
    "exampleQuotes" JSONB NOT NULL,
    "actionableSuggestion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudienceInsight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PerformanceSnapshot_contentItemId_idx" ON "PerformanceSnapshot"("contentItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceSnapshot_contentItemId_platform_offset_key" ON "PerformanceSnapshot"("contentItemId", "platform", "offset");

-- CreateIndex
CREATE INDEX "Comment_contentItemId_idx" ON "Comment"("contentItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Comment_contentItemId_platform_platformCommentId_key" ON "Comment"("contentItemId", "platform", "platformCommentId");

-- AddForeignKey
ALTER TABLE "PerformanceSnapshot" ADD CONSTRAINT "PerformanceSnapshot_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

