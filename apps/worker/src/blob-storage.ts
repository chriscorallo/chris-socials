import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { put, get, del, issueSignedToken, presignUrl } from "@vercel/blob";
import type { StorageAdapter } from "@chris/media";

/** Files above this go up as a multipart upload (parallel parts, per-part retry). */
const MULTIPART_THRESHOLD_BYTES = 50 * 1024 * 1024;

/**
 * Vercel Blob storage — a PRIVATE store. Nothing is publicly readable by URL; reads go
 * through the read-write token server-side, and anything that must hand a URL to someone
 * else (the browser's <video> tag, Instagram's servers fetching a Reel) gets a short-lived
 * presigned GET URL scoped to exactly one pathname. Enabled automatically when
 * BLOB_READ_WRITE_TOKEN is set — see lib/storage.ts and /docs/DECISIONS.md ("Production
 * storage: private Vercel Blob + presigned URLs").
 */
export class VercelBlobStorageAdapter implements StorageAdapter {
  async put(key: string, data: Buffer | Uint8Array, contentType?: string): Promise<{ url: string }> {
    const result = await put(key, Buffer.from(data), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
      multipart: data.byteLength > MULTIPART_THRESHOLD_BYTES,
    });
    return { url: result.url };
  }

  async get(key: string): Promise<Buffer> {
    const result = await get(key, { access: "private", useCache: false });
    if (!result) throw new Error(`Blob not found: ${key}`);
    const chunks: Buffer[] = [];
    for await (const chunk of Readable.fromWeb(result.stream as never)) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  /** The blob's bytes as a web stream (the app streams editor-preview files same-origin when the
   * browser can't read the presigned URL cross-origin), or null if missing. */
  async stream(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const result = await get(key, { access: "private" });
    return result && result.statusCode === 200 ? result.stream : null;
  }

  /** Streams a blob to a local file without buffering it all in memory (raw takes can be
   * hundreds of MB). */
  async downloadToFile(key: string, filePath: string): Promise<void> {
    const result = await get(key, { access: "private", useCache: false });
    if (!result) throw new Error(`Blob not found: ${key}`);
    await pipeline(Readable.fromWeb(result.stream as never), createWriteStream(filePath));
  }

  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const validUntil = Date.now() + expiresInSeconds * 1000;
    const token = await issueSignedToken({ pathname: key, operations: ["get"], validUntil });
    const { presignedUrl } = await presignUrl(token, {
      operation: "get",
      pathname: key,
      validUntil,
      access: "private",
    });
    return presignedUrl;
  }

  async delete(key: string): Promise<void> {
    await del(key);
  }
}
