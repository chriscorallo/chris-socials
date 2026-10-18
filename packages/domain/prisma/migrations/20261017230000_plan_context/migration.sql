-- Plan context: Chris's ChatGPT planning conversation(s), versioned. New tables only
-- (additive); no existing rows change. See docs/decisions-pending/plan-context.md.

-- CreateTable
CREATE TABLE "PlanContext" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "conversationId" TEXT,
    "useForAi" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanContextVersion" (
    "id" TEXT NOT NULL,
    "planContextId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "conversationId" TEXT,
    "conversationTitle" TEXT,
    "conversationCreatedAt" TIMESTAMP(3),
    "conversationUpdatedAt" TIMESTAMP(3),
    "messages" JSONB NOT NULL,
    "messageCount" INTEGER NOT NULL,
    "charCount" INTEGER NOT NULL,
    "wordCount" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanContextVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanContext_conversationId_idx" ON "PlanContext"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanContextVersion_planContextId_version_key" ON "PlanContextVersion"("planContextId", "version");

-- CreateIndex
CREATE INDEX "PlanContextVersion_planContextId_contentHash_idx" ON "PlanContextVersion"("planContextId", "contentHash");

-- AddForeignKey
ALTER TABLE "PlanContextVersion" ADD CONSTRAINT "PlanContextVersion_planContextId_fkey" FOREIGN KEY ("planContextId") REFERENCES "PlanContext"("id") ON DELETE CASCADE ON UPDATE CASCADE;
