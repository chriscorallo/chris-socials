-- Graphics library: per-user favourite + recently used presets. New table only (additive);
-- no existing rows change. See docs/decisions-pending/animation-library.md.

-- CreateTable
CREATE TABLE "GraphicPresetPref" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "favoritedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphicPresetPref_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GraphicPresetPref_userId_presetId_key" ON "GraphicPresetPref"("userId", "presetId");

-- CreateIndex
CREATE INDEX "GraphicPresetPref_userId_lastUsedAt_idx" ON "GraphicPresetPref"("userId", "lastUsedAt");
