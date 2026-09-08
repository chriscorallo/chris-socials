-- CreateEnum
CREATE TYPE "EvidenceSourceType" AS ENUM ('PERFORMANCE_SNAPSHOT', 'EXPERIMENT', 'AUDIENCE_INSIGHT', 'DECISION_JOURNAL', 'MANUAL');

-- CreateEnum
CREATE TYPE "BeliefStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED', 'RETIRED');

-- CreateEnum
CREATE TYPE "ExperimentStatus" AS ENUM ('PROPOSED', 'RUNNING', 'CONCLUDED', 'INCONCLUSIVE');

-- CreateTable
CREATE TABLE "EvidenceEntry" (
    "id" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "sourceType" "EvidenceSourceType" NOT NULL,
    "sourceId" TEXT,
    "contentItemId" TEXT,
    "platform" "ContentPlatform",
    "confidence" DOUBLE PRECISION NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Belief" (
    "id" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "causalClaim" TEXT,
    "isExperimentalEvidence" BOOLEAN NOT NULL,
    "status" "BeliefStatus" NOT NULL DEFAULT 'PROPOSED',
    "evidenceIds" JSONB NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "applicablePlatform" "ContentPlatform",
    "applicableTopic" TEXT,
    "applicableFormat" TEXT,
    "dateRangeStart" TIMESTAMP(3),
    "dateRangeEnd" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION NOT NULL,
    "confounders" JSONB NOT NULL,
    "contradictoryEvidence" JSONB NOT NULL,
    "firstObserved" TIMESTAMP(3),
    "lastEvaluated" TIMESTAMP(3),
    "retestConditions" TEXT,
    "proposedBy" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Belief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TasteFeedback" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT,
    "artifactType" TEXT NOT NULL,
    "rawFeedback" TEXT NOT NULL,
    "normalizedTag" TEXT NOT NULL,
    "productionTier" "ProductionTier",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TasteFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChrisAcceptanceProbability" (
    "id" TEXT NOT NULL,
    "artifactType" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "probability" DOUBLE PRECISION NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "generalizes" BOOLEAN NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChrisAcceptanceProbability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandEra" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandEra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "status" "ExperimentStatus" NOT NULL DEFAULT 'PROPOSED',
    "confounders" JSONB NOT NULL,
    "minSampleSize" INTEGER NOT NULL,
    "minDurationDays" INTEGER NOT NULL,
    "portfolioMapping" TEXT,
    "conclusion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concludedAt" TIMESTAMP(3),

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentVariant" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "contentItemId" TEXT,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyBrief" (
    "id" TEXT NOT NULL,
    "weekStartDate" TIMESTAMP(3) NOT NULL,
    "whatHappened" TEXT NOT NULL,
    "whatItMeans" TEXT NOT NULL,
    "stillUncertain" JSONB NOT NULL,
    "recommendationsForNextWeek" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeeklyBrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdversarialCritique" (
    "id" TEXT NOT NULL,
    "artifactType" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "contentItemId" TEXT,
    "concerns" JSONB NOT NULL,
    "noMaterialWeaknessesFound" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdversarialCritique_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvidenceEntry_sourceType_idx" ON "EvidenceEntry"("sourceType");

-- CreateIndex
CREATE INDEX "TasteFeedback_contentItemId_idx" ON "TasteFeedback"("contentItemId");

-- CreateIndex
CREATE INDEX "TasteFeedback_normalizedTag_idx" ON "TasteFeedback"("normalizedTag");

-- CreateIndex
CREATE INDEX "ChrisAcceptanceProbability_artifactType_tag_idx" ON "ChrisAcceptanceProbability"("artifactType", "tag");

-- CreateIndex
CREATE INDEX "ExperimentVariant_experimentId_idx" ON "ExperimentVariant"("experimentId");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyBrief_weekStartDate_key" ON "WeeklyBrief"("weekStartDate");

-- CreateIndex
CREATE INDEX "AdversarialCritique_contentItemId_idx" ON "AdversarialCritique"("contentItemId");

-- AddForeignKey
ALTER TABLE "TasteFeedback" ADD CONSTRAINT "TasteFeedback_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentVariant" ADD CONSTRAINT "ExperimentVariant_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentVariant" ADD CONSTRAINT "ExperimentVariant_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdversarialCritique" ADD CONSTRAINT "AdversarialCritique_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

