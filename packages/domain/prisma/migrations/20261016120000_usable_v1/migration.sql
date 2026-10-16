-- AlterTable
ALTER TABLE "EditPlan" ADD COLUMN     "revisionOfEditPlanId" TEXT,
ADD COLUMN     "revisionReason" TEXT;

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "transcribedAt" TIMESTAMP(3),
ADD COLUMN     "transcriptSource" TEXT,
ADD COLUMN     "transcriptWords" JSONB;

-- AlterTable
ALTER TABLE "PlatformCredential" ADD COLUMN     "metadata" JSONB;

-- AlterTable
ALTER TABLE "ScriptVersion" ADD COLUMN     "authorType" TEXT NOT NULL DEFAULT 'AGENT',
ADD COLUMN     "revisedFromId" TEXT,
ADD COLUMN     "revisionNote" TEXT,
ADD COLUMN     "scriptClaimsGateResult" JSONB;

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "summary" JSONB,
    "error" TEXT,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobRun_kind_startedAt_idx" ON "JobRun"("kind", "startedAt");

