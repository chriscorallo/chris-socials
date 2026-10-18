-- Mini-movie Studio: Film / FilmVersion / FilmArtifact. New tables only (additive); no existing rows
-- change. Versions and artifacts are append-only. See docs/decisions-pending/studio-crew.md.
-- CreateTable
CREATE TABLE "Film" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "idea" TEXT NOT NULL,
    "targetSeconds" INTEGER NOT NULL,
    "look" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "voiceEngine" TEXT NOT NULL,
    "aiMode" TEXT NOT NULL DEFAULT 'CHATGPT',
    "status" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL DEFAULT 1,
    "counters" JSONB NOT NULL,
    "limits" JSONB NOT NULL,
    "currentVersionId" TEXT,
    "pending" JSONB,
    "engineJob" JSONB,
    "confirmedClaims" JSONB NOT NULL,
    "chrisNotes" JSONB NOT NULL,
    "skipCreativeReview" BOOLEAN NOT NULL DEFAULT false,
    "statusMessage" TEXT,
    "blockedReasons" JSONB NOT NULL,
    "lastError" TEXT,
    "sourceContentItemId" TEXT,
    "contentItemId" TEXT,
    "leaseHolder" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Film_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilmVersion" (
    "id" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "parentVersionId" TEXT,
    "dsl" JSONB NOT NULL,
    "script" JSONB,
    "brief" JSONB,
    "note" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FilmVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilmArtifact" (
    "id" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "versionId" TEXT,
    "kind" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "promptVersion" TEXT,
    "iteration" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "gate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FilmArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Film_status_updatedAt_idx" ON "Film"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "Film_contentItemId_idx" ON "Film"("contentItemId");

-- CreateIndex
CREATE UNIQUE INDEX "FilmVersion_filmId_version_key" ON "FilmVersion"("filmId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "FilmArtifact_idempotencyKey_key" ON "FilmArtifact"("idempotencyKey");

-- CreateIndex
CREATE INDEX "FilmArtifact_filmId_createdAt_idx" ON "FilmArtifact"("filmId", "createdAt");

-- AddForeignKey
ALTER TABLE "FilmVersion" ADD CONSTRAINT "FilmVersion_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilmArtifact" ADD CONSTRAINT "FilmArtifact_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

