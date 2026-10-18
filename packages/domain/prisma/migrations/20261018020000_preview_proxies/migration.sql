-- Editor preview proxies: additive nullable columns on MediaAsset (no existing row changes;
-- takes without a proxy keep playing their original in the editor until one is generated).
-- See docs/decisions-pending/editor-smoothness-fullscreen-platform-ui.md.

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "filmstripStorageKey" TEXT,
ADD COLUMN     "previewMeta" JSONB,
ADD COLUMN     "proxyStorageKey" TEXT;
