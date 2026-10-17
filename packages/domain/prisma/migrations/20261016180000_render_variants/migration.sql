-- CreateTable
CREATE TABLE "RenderVariant" (
    "id" TEXT NOT NULL,
    "renderId" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "platform" "ContentPlatform" NOT NULL,
    "profileVersion" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "coverStorageKey" TEXT,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "fps" DOUBLE PRECISION NOT NULL,
    "durationSeconds" DOUBLE PRECISION NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "videoBitrateKbps" INTEGER,
    "audioBitrateKbps" INTEGER,
    "integratedLufs" DOUBLE PRECISION,
    "truePeakDbtp" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RenderVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RenderVariant_contentItemId_idx" ON "RenderVariant"("contentItemId");

-- CreateIndex
CREATE UNIQUE INDEX "RenderVariant_renderId_platform_profileVersion_key" ON "RenderVariant"("renderId", "platform", "profileVersion");

-- AddForeignKey
ALTER TABLE "RenderVariant" ADD CONSTRAINT "RenderVariant_renderId_fkey" FOREIGN KEY ("renderId") REFERENCES "Render"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

