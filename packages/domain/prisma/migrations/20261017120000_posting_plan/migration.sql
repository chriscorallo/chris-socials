-- CreateTable
CREATE TABLE "PostingPlan" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "readyLeadDays" INTEGER NOT NULL DEFAULT 1,
    "filmLeadDays" INTEGER NOT NULL DEFAULT 3,
    "sameForAll" BOOLEAN NOT NULL DEFAULT false,
    "cadences" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostingPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NudgeDismissal" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NudgeDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PostingPlan_version_key" ON "PostingPlan"("version");

-- CreateIndex
CREATE INDEX "PostingPlan_active_idx" ON "PostingPlan"("active");

-- CreateIndex
CREATE UNIQUE INDEX "NudgeDismissal_key_day_key" ON "NudgeDismissal"("key", "day");

