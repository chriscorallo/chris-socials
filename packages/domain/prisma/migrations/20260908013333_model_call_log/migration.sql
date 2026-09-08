-- CreateEnum
CREATE TYPE "LlmModelClass" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateTable
CREATE TABLE "ModelCallLog" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "modelClass" "LlmModelClass" NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "latencyMs" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "contentItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelCallLog_promptId_idx" ON "ModelCallLog"("promptId");

-- CreateIndex
CREATE INDEX "ModelCallLog_createdAt_idx" ON "ModelCallLog"("createdAt");

-- CreateIndex
CREATE INDEX "ModelCallLog_contentItemId_idx" ON "ModelCallLog"("contentItemId");
