import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRenderVariant, recordRenderVariant, type PrismaClient, type ContentPlatform } from "@chris/domain";
import { encodePlatformVariant, PLATFORM_PROFILES, type PlatformId, type StorageAdapter } from "@chris/media";

/** Stable short fingerprint of a platform profile — a changed profile yields a new variant. */
export function platformProfileVersion(platform: ContentPlatform): string {
  return createHash("sha256").update(JSON.stringify(PLATFORM_PROFILES[platform as PlatformId])).digest("hex").slice(0, 12);
}

export class VariantBlockedError extends Error {
  constructor(platform: ContentPlatform, issues: string[]) {
    super(`${platform} version of this video doesn't meet ${platform}'s upload spec: ${issues.join("; ")}`);
    this.name = "VariantBlockedError";
  }
}

export interface EnsuredVariant {
  renderVariantId: string;
  storageKey: string;
  bytes: Buffer;
  sha256: string;
  durationSeconds: number;
}

/**
 * The upload file for one platform: the master render re-encoded to that platform's preferred
 * profile (codec/bitrate/audio/loudness/size cap/faststart — packages/media platform-profiles.ts)
 * — spec §9 step 17 "one master + lightweight variants". Created once per (render, platform,
 * profile version) and reused on retries. A variant that fails its profile's BLOCKING checks
 * (or can't fit the size cap) throws, failing only that platform.
 */
export async function ensurePlatformVariant(
  db: PrismaClient,
  storage: StorageAdapter,
  input: { renderId: string; platform: ContentPlatform; coverFrameSeconds?: number | null },
  actor: { actorId: string },
): Promise<EnsuredVariant> {
  const profileVersion = platformProfileVersion(input.platform);
  const existing = await findRenderVariant(db, { renderId: input.renderId, platform: input.platform, profileVersion });
  if (existing) {
    const bytes = await storage.get(existing.storageKey);
    return {
      renderVariantId: existing.id,
      storageKey: existing.storageKey,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      durationSeconds: existing.durationSeconds,
    };
  }

  const render = await db.render.findUniqueOrThrow({ where: { id: input.renderId } });
  if (!render.storageKey) throw new Error(`Render ${render.id} has no stored output.`);

  const workDir = await mkdtemp(join(tmpdir(), "chris-variant-"));
  try {
    const masterPath = join(workDir, "master.mp4");
    await writeFile(masterPath, await storage.get(render.storageKey));
    const outputPath = join(workDir, `${input.platform}.mp4`);
    const result = await encodePlatformVariant({
      masterPath,
      outputPath,
      profile: PLATFORM_PROFILES[input.platform as PlatformId],
      coverFrameSeconds: input.coverFrameSeconds ?? undefined,
    });
    const blocking = result.issues.filter((i) => i.severity === "BLOCKING").map((i) => i.message);
    if (blocking.length > 0) throw new VariantBlockedError(input.platform, blocking);

    const bytes = await readFile(outputPath);
    const base = `variants/${render.contentItemId}/${render.id}-${input.platform}-${profileVersion}`;
    await storage.put(`${base}.mp4`, bytes, "video/mp4");
    let coverStorageKey: string | null = null;
    if (result.coverImagePath) {
      coverStorageKey = `${base}-cover.jpg`;
      await storage.put(coverStorageKey, await readFile(result.coverImagePath), "image/jpeg");
    }
    const variant = await recordRenderVariant(
      db,
      {
        renderId: render.id,
        contentItemId: render.contentItemId,
        platform: input.platform,
        profileVersion,
        storageKey: `${base}.mp4`,
        coverStorageKey,
        width: result.width,
        height: result.height,
        fps: result.fps,
        durationSeconds: result.durationSeconds,
        fileSizeBytes: result.fileSizeBytes,
        videoBitrateKbps: result.videoBitrateKbps ?? null,
        audioBitrateKbps: result.audioBitrateKbps ?? null,
        integratedLufs: result.integratedLufs ?? null,
        truePeakDbtp: result.truePeakDbtp ?? null,
      },
      actor,
    );
    return {
      renderVariantId: variant.id,
      storageKey: variant.storageKey,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      durationSeconds: variant.durationSeconds,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
