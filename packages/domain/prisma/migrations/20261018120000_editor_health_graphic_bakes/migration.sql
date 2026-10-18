-- Editor rebuild (docs/decisions-pending/editor-rebuild.md): editor health telemetry reports
-- and baked preview graphics. New tables only (additive); no existing rows change.
-- CreateTable
CREATE TABLE "EditorHealthReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contentItemId" TEXT,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "engine" TEXT,
    "userAgent" TEXT,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditorHealthReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphicBake" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "input" JSONB NOT NULL,
    "storageKey" TEXT,
    "fps" INTEGER NOT NULL DEFAULT 30,
    "frames" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphicBake_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EditorHealthReport_createdAt_idx" ON "EditorHealthReport"("createdAt");

-- CreateIndex
CREATE INDEX "EditorHealthReport_sessionId_createdAt_idx" ON "EditorHealthReport"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "GraphicBake_contentItemId_status_idx" ON "GraphicBake"("contentItemId", "status");

-- CreateIndex
CREATE INDEX "GraphicBake_storageKey_idx" ON "GraphicBake"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "GraphicBake_contentItemId_key_key" ON "GraphicBake"("contentItemId", "key");

