-- AlterEnum
ALTER TYPE "MediaAssetKind" ADD VALUE 'MUSIC';

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "subjectTrack" JSONB;

