-- CreateEnum
CREATE TYPE "ContentPlatform" AS ENUM ('INSTAGRAM', 'TIKTOK', 'YOUTUBE');

-- CreateTable
CREATE TABLE "ReferenceCreator" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platforms" JSONB NOT NULL,
    "brandPositioning" TEXT NOT NULL,
    "knownAudience" TEXT,
    "formats" JSONB NOT NULL,
    "storytellingTendencies" TEXT,
    "verbalTendencies" TEXT,
    "editingTendencies" TEXT,
    "visualCharacteristics" TEXT,
    "hookArchetypes" JSONB NOT NULL,
    "ctaBehaviors" TEXT,
    "contentEvolution" TEXT,
    "relevanceToChris" TEXT,
    "doNotTransfer" TEXT,
    "sourceProvenance" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferenceCreator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferenceContent" (
    "id" TEXT NOT NULL,
    "referenceCreatorId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "platform" "ContentPlatform",
    "durationSeconds" INTEGER,
    "hook" TEXT,
    "topic" TEXT,
    "publicPerformanceNotes" TEXT,
    "sourceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferenceContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferenceObservation" (
    "id" TEXT NOT NULL,
    "referenceContentId" TEXT NOT NULL,
    "observed" TEXT NOT NULL,
    "likelyPrinciple" TEXT NOT NULL,
    "transferabilityToChris" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "risks" JSONB NOT NULL,
    "testRequired" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferenceObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyProgrammingThesis" (
    "id" TEXT NOT NULL,
    "weekStartDate" TIMESTAMP(3) NOT NULL,
    "thesis" TEXT NOT NULL,
    "primaryObjectives" JSONB NOT NULL,
    "activeExperiments" JSONB NOT NULL,
    "areasToExploit" JSONB NOT NULL,
    "areasToExplore" JSONB NOT NULL,
    "areasToReduce" JSONB NOT NULL,
    "risks" JSONB NOT NULL,
    "contentGaps" JSONB NOT NULL,
    "productionConstraints" JSONB NOT NULL,
    "humanDecisionsNeeded" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeeklyProgrammingThesis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyPortfolioItem" (
    "id" TEXT NOT NULL,
    "weeklyThesisId" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "pillar" "Pillar",
    "topic" TEXT NOT NULL,
    "subtopic" TEXT,
    "format" TEXT NOT NULL,
    "productionTier" "ProductionTier" NOT NULL,
    "targetLengthSeconds" INTEGER,
    "primaryHypothesis" TEXT NOT NULL,
    "historicalAnalogue" TEXT,
    "referenceInfluence" TEXT,
    "whyThisWeek" TEXT NOT NULL,
    "duplicateRisk" TEXT,
    "researchBurden" TEXT,
    "productionBurden" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeeklyPortfolioItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferenceContent_referenceCreatorId_idx" ON "ReferenceContent"("referenceCreatorId");

-- CreateIndex
CREATE INDEX "ReferenceObservation_referenceContentId_idx" ON "ReferenceObservation"("referenceContentId");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyProgrammingThesis_weekStartDate_key" ON "WeeklyProgrammingThesis"("weekStartDate");

-- CreateIndex
CREATE INDEX "WeeklyPortfolioItem_contentItemId_idx" ON "WeeklyPortfolioItem"("contentItemId");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyPortfolioItem_weeklyThesisId_contentItemId_key" ON "WeeklyPortfolioItem"("weeklyThesisId", "contentItemId");

-- AddForeignKey
ALTER TABLE "ReferenceContent" ADD CONSTRAINT "ReferenceContent_referenceCreatorId_fkey" FOREIGN KEY ("referenceCreatorId") REFERENCES "ReferenceCreator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferenceObservation" ADD CONSTRAINT "ReferenceObservation_referenceContentId_fkey" FOREIGN KEY ("referenceContentId") REFERENCES "ReferenceContent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyPortfolioItem" ADD CONSTRAINT "WeeklyPortfolioItem_weeklyThesisId_fkey" FOREIGN KEY ("weeklyThesisId") REFERENCES "WeeklyProgrammingThesis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyPortfolioItem" ADD CONSTRAINT "WeeklyPortfolioItem_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

