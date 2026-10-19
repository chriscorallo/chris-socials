-- Director chat (docs/decisions-pending/director-chat.md): per-take understanding (expression
-- timeline, face boxes, motion, sprite) and the per-video conversation. New tables only
-- (additive); no existing rows change.
-- CreateTable
CREATE TABLE "TakeUnderstanding" (
    "id" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "model" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "spriteKey" TEXT,
    "ms" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TakeUnderstanding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DirectorMessage" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT,
    "text" TEXT NOT NULL,
    "payload" JSONB,
    "baseEditPlanId" TEXT,
    "resultEditPlanId" TEXT,
    "replyToId" TEXT,
    "costUsd" DOUBLE PRECISION,
    "idempotencyKey" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DirectorMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TakeUnderstanding_mediaAssetId_createdAt_idx" ON "TakeUnderstanding"("mediaAssetId", "createdAt");

-- CreateIndex
CREATE INDEX "TakeUnderstanding_contentItemId_idx" ON "TakeUnderstanding"("contentItemId");

-- CreateIndex
CREATE UNIQUE INDEX "DirectorMessage_idempotencyKey_key" ON "DirectorMessage"("idempotencyKey");

-- CreateIndex
CREATE INDEX "DirectorMessage_contentItemId_createdAt_idx" ON "DirectorMessage"("contentItemId", "createdAt");
