-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('SUCCESS', 'FAILED', 'DRAFT');

-- AlterTable
ALTER TABLE "ScheduleEntry" ADD COLUMN     "targetPlatforms" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "PlatformPackage" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "platform" "ContentPlatform" NOT NULL,
    "caption" TEXT NOT NULL,
    "title" TEXT,
    "hashtags" JSONB NOT NULL,
    "coverFrameSeconds" DOUBLE PRECISION,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Publication" (
    "id" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "platform" "ContentPlatform" NOT NULL,
    "platformPackageId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT NOT NULL,
    "status" "PublicationStatus" NOT NULL,
    "platformPostId" TEXT,
    "url" TEXT,
    "mediaHash" TEXT,
    "rawResponse" JSONB,
    "errorMessage" TEXT,
    "publishedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformCredential" (
    "id" TEXT NOT NULL,
    "platform" "ContentPlatform" NOT NULL,
    "accountId" TEXT NOT NULL,
    "encryptedAccessToken" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformPackage_contentItemId_idx" ON "PlatformPackage"("contentItemId");

-- CreateIndex
CREATE INDEX "PlatformPackage_contentItemId_platform_idx" ON "PlatformPackage"("contentItemId", "platform");

-- CreateIndex
CREATE INDEX "Publication_contentItemId_idx" ON "Publication"("contentItemId");

-- CreateIndex
CREATE INDEX "Publication_contentItemId_platform_idx" ON "Publication"("contentItemId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformCredential_platform_key" ON "PlatformCredential"("platform");

-- AddForeignKey
ALTER TABLE "PlatformPackage" ADD CONSTRAINT "PlatformPackage_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_platformPackageId_fkey" FOREIGN KEY ("platformPackageId") REFERENCES "PlatformPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

