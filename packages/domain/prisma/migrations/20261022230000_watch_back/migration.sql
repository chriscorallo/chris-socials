-- Watch-back gate (docs/PREMIUM_EDITOR_PLAN.md round 2): verdicts per render and Chris's one-tap
-- ratings (the autonomy label). Append-only tables; additive migration.
-- CreateTable
CREATE TABLE "WatchVerdict" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "renderId" TEXT NOT NULL,
    "editPlanId" TEXT,
    "loop" INTEGER NOT NULL DEFAULT 0,
    "verdict" TEXT NOT NULL,
    "checklist" JSONB NOT NULL,
    "fixes" JSONB NOT NULL,
    "audits" JSONB NOT NULL,
    "hookTest" JSONB,
    "coldViewer" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputSummary" JSONB NOT NULL,
    "costUsd" DOUBLE PRECISION,
    "jobRunId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchVerdict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchRating" (
    "id" TEXT NOT NULL,
    "watchVerdictId" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "rating" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchRating_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WatchVerdict_contentItemId_createdAt_idx" ON "WatchVerdict"("contentItemId", "createdAt");

-- CreateIndex
CREATE INDEX "WatchVerdict_renderId_idx" ON "WatchVerdict"("renderId");

-- CreateIndex
CREATE INDEX "WatchRating_contentItemId_createdAt_idx" ON "WatchRating"("contentItemId", "createdAt");

-- AddForeignKey
ALTER TABLE "WatchRating" ADD CONSTRAINT "WatchRating_watchVerdictId_fkey" FOREIGN KEY ("watchVerdictId") REFERENCES "WatchVerdict"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
