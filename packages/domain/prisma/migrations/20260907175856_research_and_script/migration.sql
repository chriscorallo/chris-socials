-- CreateEnum
CREATE TYPE "ResearchStatus" AS ENUM ('READY', 'NEEDS_MORE_RESEARCH', 'UNSUPPORTED', 'OUT_OF_SCOPE');

-- CreateTable
CREATE TABLE "ResearchPacket" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "primaryClaim" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "citations" JSONB NOT NULL,
    "numericInputs" JSONB NOT NULL,
    "calculationNotes" TEXT,
    "caveats" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "contradictoryEvidence" JSONB NOT NULL,
    "prohibitedClaims" JSONB NOT NULL,
    "contentSafeWording" TEXT NOT NULL,
    "status" "ResearchStatus" NOT NULL,
    "stopResearching" BOOLEAN NOT NULL,
    "claimsGateResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchPacket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScriptVersion" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "researchPacketId" TEXT,
    "spokenScript" TEXT NOT NULL,
    "beats" JSONB NOT NULL,
    "intendedPauses" JSONB NOT NULL,
    "emphasizedWords" JSONB NOT NULL,
    "visualBeats" JSONB NOT NULL,
    "requiredFactualCaveats" JSONB NOT NULL,
    "targetRuntimeSeconds" INTEGER NOT NULL,
    "estimatedSpeakingRuntimeSeconds" INTEGER NOT NULL,
    "followUpIdeas" JSONB NOT NULL,
    "brandGuardianReport" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScriptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResearchPacket_contentItemId_idx" ON "ResearchPacket"("contentItemId");

-- CreateIndex
CREATE INDEX "ScriptVersion_contentItemId_idx" ON "ScriptVersion"("contentItemId");

-- AddForeignKey
ALTER TABLE "ResearchPacket" ADD CONSTRAINT "ResearchPacket_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptVersion" ADD CONSTRAINT "ScriptVersion_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

