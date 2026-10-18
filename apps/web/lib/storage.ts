import { join, basename } from "node:path";
import { copyFile } from "node:fs/promises";
import { LocalFsStorageAdapter, type StorageAdapter } from "@chris/media";
import { VercelBlobStorageAdapter } from "./blob-storage";

/**
 * One storage backend per deployment, chosen by environment — nothing upstream depends on
 * which one it is (packages/media's StorageAdapter interface).
 *
 * - "blob": private Vercel Blob store, used whenever BLOB_READ_WRITE_TOKEN is set (i.e. on
 *   Vercel once a Blob store is connected). Serverless functions have no persistent disk, so
 *   this is the only mode that works in production.
 * - "local": files on this machine's disk under STORAGE_LOCAL_DIR (default <repo>/.storage),
 *   for local use.
 *
 * See /docs/DECISIONS.md ("Production storage: private Vercel Blob + presigned URLs").
 */
export type StorageMode = "blob" | "local";

export const storageMode: StorageMode = process.env.BLOB_READ_WRITE_TOKEN ? "blob" : "local";

const STORAGE_LOCAL_DIR = process.env.STORAGE_LOCAL_DIR ?? join(process.cwd(), "..", "..", ".storage");

const localAdapter = storageMode === "local" ? new LocalFsStorageAdapter({ baseDir: STORAGE_LOCAL_DIR }) : null;
const blobAdapter = storageMode === "blob" ? new VercelBlobStorageAdapter() : null;

export const storage: StorageAdapter = (blobAdapter ?? localAdapter)!;

/** The local adapter when running in local mode (for streaming disk reads/writes). */
export function getLocalStorage(): LocalFsStorageAdapter | null {
  return localAdapter;
}

/** A stored object's bytes as a stream (blob mode; local mode serves from disk itself). */
export async function streamFromStorage(key: string): Promise<ReadableStream<Uint8Array> | null> {
  if (!blobAdapter) return null;
  try {
    return await blobAdapter.stream(key);
  } catch {
    return null;
  }
}

/** Copies a stored object to a local file path, streaming where the backend allows it. */
export async function downloadToFile(key: string, filePath: string): Promise<void> {
  if (blobAdapter) return blobAdapter.downloadToFile(key, filePath);
  await copyFile(localAdapter!.pathFor(key), filePath);
}

/**
 * A URL a third party's servers can fetch WITHOUT a session — Instagram's Content Publishing
 * API requires one for Reels (it pulls the video itself). Only possible in blob mode
 * (presigned, single-pathname, expires); in local mode there is no publicly reachable URL,
 * so this returns null and the Instagram publish records a clear FAILED reason instead of
 * pretending. Two hours covers Instagram's container processing window.
 */
export async function getPublicVideoUrl(storageKey: string): Promise<string | null> {
  if (!blobAdapter) return null;
  return blobAdapter.signedUrl(storageKey, 2 * 60 * 60);
}

/** Storage-key-safe version of a user-supplied filename (no path components, no odd chars). */
export function safeFilename(name: string): string {
  const base = basename(name || "upload").replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
  return (base || "upload").slice(-120);
}
