-- Content Intelligence: follower conversion fields on performance snapshots (additive, nullable —
-- filled only where a platform returns them; never estimated).
-- AlterTable
ALTER TABLE "PerformanceSnapshot" ADD COLUMN "followsGained" INTEGER,
ADD COLUMN "profileVisits" INTEGER;
