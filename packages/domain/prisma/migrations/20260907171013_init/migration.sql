-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ContentState" AS ENUM ('IDEA', 'SELECTED', 'CONTRACTED', 'RESEARCHING', 'RESEARCH_BLOCKED', 'RESEARCHED', 'SCRIPTING', 'SCRIPTED', 'READY_TO_FILM', 'FILMED', 'MEDIA_INGESTED', 'TAKE_SELECTED', 'EDIT_PLANNED', 'EDITING', 'RENDERED', 'QC_REPAIR', 'QC_BLOCKED', 'READY', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'MEASURING', 'ARCHIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('HUMAN', 'SYSTEM', 'JOB');

-- CreateEnum
CREATE TYPE "BrandMemoryKind" AS ENUM ('CONSTITUTION', 'CHRIS_BRAIN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentItem" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "currentState" "ContentState" NOT NULL DEFAULT 'IDEA',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentStateTransition" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "fromState" "ContentState" NOT NULL,
    "toState" "ContentState" NOT NULL,
    "reason" TEXT,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentStateTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionJournalEntry" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "selectedDecision" TEXT NOT NULL,
    "alternatives" JSONB,
    "rationale" TEXT NOT NULL,
    "evidenceIds" JSONB,
    "confidence" DOUBLE PRECISION,
    "decisionOwner" TEXT NOT NULL,
    "agentOrModel" TEXT,
    "userOverride" BOOLEAN NOT NULL DEFAULT false,
    "laterOutcome" TEXT,
    "retrospective" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionJournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandConstitutionVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandConstitutionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandMemory" (
    "id" TEXT NOT NULL,
    "kind" "BrandMemoryKind" NOT NULL,
    "version" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ContentStateTransition_idempotencyKey_key" ON "ContentStateTransition"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ContentStateTransition_contentItemId_idx" ON "ContentStateTransition"("contentItemId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_key_key" ON "FeatureFlag"("key");

-- CreateIndex
CREATE UNIQUE INDEX "BrandConstitutionVersion_version_key" ON "BrandConstitutionVersion"("version");

-- CreateIndex
CREATE UNIQUE INDEX "BrandMemory_kind_version_key" ON "BrandMemory"("kind", "version");

-- AddForeignKey
ALTER TABLE "ContentStateTransition" ADD CONSTRAINT "ContentStateTransition_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

