-- CreateEnum
CREATE TYPE "AutonomySubsystem" AS ENUM ('TAKE_SELECTION', 'EDIT_PLANNING', 'QUALITY_GATE', 'SCHEDULING', 'PUBLISHING');

-- CreateTable
CREATE TABLE "AutonomyLevel" (
    "id" TEXT NOT NULL,
    "subsystem" "AutonomySubsystem" NOT NULL,
    "productionTier" "ProductionTier" NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "approvedOutcomeCount" INTEGER NOT NULL DEFAULT 0,
    "ceilingLevel" INTEGER NOT NULL DEFAULT 4,
    "lastEscalatedAt" TIMESTAMP(3),
    "lastEscalationReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutonomyLevel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutonomyLevel_subsystem_productionTier_key" ON "AutonomyLevel"("subsystem", "productionTier");

