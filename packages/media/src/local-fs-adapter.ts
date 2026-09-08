import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, normalize, isAbsolute } from "node:path";
import type { StorageAdapter } from "./index";

export interface LocalFsStorageAdapterOptions {
  baseDir: string;
  /** Prefix used to build the value signedUrl() returns. Phase 1's local adapter
   * approximates a signed URL with an authenticated app route (see apps/web's
   * /api/media/[assetId] route) rather than a real time-limited signature — true signed
   * URLs arrive with the Vercel Blob implementation. See /docs/SECURITY.md. */
  publicPathPrefix?: string;
}

/** Rejects any key that would escape baseDir (e.g. "../../etc/passwd") — storageKeys are
 * generated server-side, not taken directly from user input, but this is defensive per
 * CLAUDE.md's "treat external input as untrusted" rule regardless of the current call sites. */
function resolveSafePath(baseDir: string, key: string): string {
  if (isAbsolute(key)) {
    throw new Error(`Storage key must be relative: "${key}"`);
  }
  const resolved = normalize(join(baseDir, key));
  if (!resolved.startsWith(normalize(baseDir))) {
    throw new Error(`Storage key escapes base directory: "${key}"`);
  }
  return resolved;
}

export class LocalFsStorageAdapter implements StorageAdapter {
  private readonly baseDir: string;
  private readonly publicPathPrefix: string;

  constructor(options: LocalFsStorageAdapterOptions) {
    this.baseDir = options.baseDir;
    this.publicPathPrefix = options.publicPathPrefix ?? "/api/media";
  }

  async put(key: string, data: Buffer | Uint8Array): Promise<{ url: string }> {
    const filePath = resolveSafePath(this.baseDir, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return { url: `file://${filePath}` };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(resolveSafePath(this.baseDir, key));
  }

  async signedUrl(key: string, _expiresInSeconds: number): Promise<string> {
    // Encode each path segment individually (not the whole key) so a Next.js catch-all
    // route ([...key]) can split the URL back into the same segments — encoding the slashes
    // themselves (e.g. via a single encodeURIComponent(key) call) would collapse them into
    // one opaque segment instead.
    const encodedSegments = key.split("/").map(encodeURIComponent).join("/");
    return `${this.publicPathPrefix}/${encodedSegments}`;
  }

  async delete(key: string): Promise<void> {
    await rm(resolveSafePath(this.baseDir, key), { force: true });
  }
}
