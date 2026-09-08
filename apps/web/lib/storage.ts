import { join } from "node:path";
import { LocalFsStorageAdapter } from "@chris/media";

/**
 * Local-fs storage for Phase 1. Swappable for a Vercel Blob implementation later purely by
 * changing this file — nothing upstream depends on which adapter is behind it. See
 * /docs/ARCHITECTURE.md and /docs/DECISIONS.md.
 */
const STORAGE_LOCAL_DIR = process.env.STORAGE_LOCAL_DIR ?? join(process.cwd(), "..", "..", ".storage");

export const storage = new LocalFsStorageAdapter({ baseDir: STORAGE_LOCAL_DIR });
