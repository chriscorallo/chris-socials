-- Replace footage / delete a clip (docs/decisions-pending/replace-footage.md): soft removal of a
-- take. Additive, nullable: every existing row stays "not removed".
-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN "removedAt" TIMESTAMP(3),
ADD COLUMN "removedReason" TEXT;
