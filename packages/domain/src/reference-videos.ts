import { Prisma, type PrismaClient, type ContentPlatform } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";
import { buildStyleModel, excludedSignals, sampleFromReferenceMetrics, sampleFromTimeline, timelineLike, type StyleModel, type StyleSample, type StyleSignal } from "./style-model";
import { isHandEditReason } from "./style-cut-plan";
import {
  REFERENCE_METRICS_VERSION,
  REFERENCE_VIDEO_KEY_PATTERN,
  ReferenceVideoMetricsSchema,
  aggregateOwnSpeech,
  aggregateStyle,
  parseReferenceVideoMetrics,
  speechMetrics,
  type OwnSpeechProfile,
  type ReferenceVideoMetrics,
  type StyleProfile,
  type TimedWord,
} from "./style-metrics";

/**
 * Reference videos — clips of creators Chris wants his edits to feel like, uploaded for
 * PRIVATE, deterministic style measurement (cuts, pacing, speech, audio balance). They live on
 * ReferenceContent (one row per video), are never rendered or published, and their media can be
 * deleted while the measured numbers stay. See docs/DECISIONS.md ("Reference videos").
 */

/** Storage key prefix for reference videos (private store; never a render input). */
export function referenceVideoKeyPrefix(referenceCreatorId: string): string {
  return `reference/${referenceCreatorId}/`;
}

export function isReferenceVideoKey(key: string, referenceCreatorId: string): boolean {
  return key.startsWith(referenceVideoKeyPrefix(referenceCreatorId)) && !key.includes("..") && REFERENCE_VIDEO_KEY_PATTERN.test(key);
}

/** TikTok / Instagram / YouTube from a link (null otherwise). */
export function platformFromUrl(url: string | null | undefined): ContentPlatform | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/(^|\.)tiktok\.com$/.test(host)) return "TIKTOK";
  if (/(^|\.)instagram\.com$/.test(host)) return "INSTAGRAM";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return "YOUTUBE";
  return null;
}

/** A pasted link, normalized ("tiktok.com/@x/video/1" → "https://tiktok.com/@x/video/1"); null if not a web link. */
export function normalizeSourceUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
    return u.toString().slice(0, 1000);
  } catch {
    return null;
  }
}

/**
 * The creator a batch of videos goes to: an existing one by id, or one found/created by name
 * (case-insensitive match, so "alex hormozi" twice doesn't make two). A new creator gets only
 * its name — the descriptive fields stay empty until Chris fills them in.
 */
export async function findOrCreateReferenceCreator(
  prisma: PrismaClient,
  input: { referenceCreatorId?: string | null; name?: string | null },
  actor: { actorId: string },
): Promise<{ id: string; name: string; created: boolean }> {
  if (input.referenceCreatorId) {
    const c = await prisma.referenceCreator.findUnique({ where: { id: input.referenceCreatorId }, select: { id: true, name: true } });
    if (!c) throw new Error("That creator doesn't exist any more.");
    return { ...c, created: false };
  }
  const name = (input.name ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
  if (!name) throw new Error("Pick a creator or type a name.");
  const existing = await prisma.referenceCreator.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true, name: true } });
  if (existing) return { ...existing, created: false };
  const c = await prisma.referenceCreator.create({
    data: { name, platforms: [], brandPositioning: "", formats: [], hookArchetypes: [], sourceProvenance: "Reference videos uploaded by Chris" },
    select: { id: true, name: true },
  });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "REFERENCE_CREATOR_CREATED",
    entityType: "ReferenceCreator",
    entityId: c.id,
    after: { name: c.name, via: "reference-video-upload" },
  });
  return { ...c, created: true };
}

export const RegisterReferenceVideoSchema = z.object({
  referenceCreatorId: z.string().min(1),
  storageKey: z.string().min(1).max(400),
  filename: z.string().min(1).max(300),
  mimeType: z.string().max(100).optional(),
  sizeBytes: z.number().nonnegative().optional(),
  sourceUrl: z.string().max(2000).nullable().optional(),
});
export type RegisterReferenceVideoInput = z.input<typeof RegisterReferenceVideoSchema>;

/**
 * Records an uploaded reference video (bytes already in storage) as a ReferenceContent row
 * waiting for measurement. Idempotent on the storage key: registering the same upload twice
 * (a retry after a dropped response) returns the first row.
 */
export async function registerReferenceVideo(prisma: PrismaClient, input: RegisterReferenceVideoInput, actor: { actorId: string }) {
  const p = RegisterReferenceVideoSchema.parse(input);
  if (!isReferenceVideoKey(p.storageKey, p.referenceCreatorId)) throw new Error("Storage key does not belong to this creator.");
  if (p.mimeType && !/^video\//.test(p.mimeType)) throw new Error(`Reference videos must be video files (this is ${p.mimeType}).`);
  const existing = await prisma.referenceContent.findFirst({ where: { mediaStorageKey: p.storageKey } });
  if (existing) return existing;
  const sourceUrl = normalizeSourceUrl(p.sourceUrl);
  const row = await prisma.referenceContent.create({
    data: {
      referenceCreatorId: p.referenceCreatorId,
      description: "",
      platform: platformFromUrl(sourceUrl),
      sourceUrl,
      mediaStorageKey: p.storageKey,
      mediaFilename: p.filename,
      mediaMimeType: p.mimeType ?? null,
      mediaSizeBytes: p.sizeBytes ?? null,
      mediaUploadedAt: new Date(),
      analysisStatus: "PENDING",
    },
  });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "REFERENCE_VIDEO_UPLOADED",
    entityType: "ReferenceContent",
    entityId: row.id,
    after: { referenceCreatorId: p.referenceCreatorId, storageKey: p.storageKey, filename: p.filename, sizeBytes: p.sizeBytes ?? null, sourceUrl },
  });
  return row;
}

/** Changes a video's source link (or clears it). */
export async function setReferenceVideoSourceUrl(prisma: PrismaClient, id: string, raw: string | null, actor: { actorId: string }) {
  const sourceUrl = normalizeSourceUrl(raw);
  if (raw && raw.trim() && !sourceUrl) throw new Error("That doesn't look like a web link.");
  const before = await prisma.referenceContent.findUniqueOrThrow({ where: { id }, select: { sourceUrl: true, platform: true } });
  const row = await prisma.referenceContent.update({ where: { id }, data: { sourceUrl, platform: platformFromUrl(sourceUrl) ?? before.platform } });
  await recordAudit(prisma, { actor: actor.actorId, actorType: "HUMAN", action: "REFERENCE_VIDEO_LINK_SET", entityType: "ReferenceContent", entityId: id, before: { sourceUrl: before.sourceUrl }, after: { sourceUrl } });
  return row;
}

/** Videos waiting for measurement (media still present), oldest first. */
export async function listPendingReferenceVideos(prisma: PrismaClient, options: { ids?: string[]; limit?: number } = {}) {
  return prisma.referenceContent.findMany({
    where: { analysisStatus: "PENDING", mediaStorageKey: { not: null }, ...(options.ids ? { id: { in: options.ids } } : {}) },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 200,
  });
}

export async function countPendingReferenceVideos(prisma: PrismaClient): Promise<number> {
  return prisma.referenceContent.count({ where: { analysisStatus: "PENDING", mediaStorageKey: { not: null } } });
}

/** Measured with an older measuring version, file still present — re-measuring would improve them. */
const OUTDATED_WHERE = {
  analysisStatus: "DONE" as const,
  mediaStorageKey: { not: null },
  OR: [{ metricsVersion: null }, { metricsVersion: { lt: REFERENCE_METRICS_VERSION } }],
};

/** How many measured videos (of one creator, or all) predate the current measuring version. */
export async function countOutdatedReferenceVideos(prisma: PrismaClient, options: { referenceCreatorId?: string } = {}): Promise<number> {
  return prisma.referenceContent.count({ where: { ...OUTDATED_WHERE, ...(options.referenceCreatorId ? { referenceCreatorId: options.referenceCreatorId } : {}) } });
}

/**
 * Puts FAILED (or, with `includeDone`, already measured) videos back in the queue — only ones
 * whose file still exists. `outdated` re-queues only measured videos from an older measuring
 * version (their old numbers stay readable until the new ones land).
 */
export async function requeueReferenceVideos(
  prisma: PrismaClient,
  options: { ids?: string[]; includeDone?: boolean; outdated?: boolean } = {},
  actor: { actorId: string },
): Promise<number> {
  const statuses = options.includeDone ? (["FAILED", "DONE"] as const) : (["FAILED"] as const);
  const res = await prisma.referenceContent.updateMany({
    where: options.outdated
      ? { ...OUTDATED_WHERE, ...(options.ids ? { id: { in: options.ids } } : {}) }
      : { analysisStatus: { in: [...statuses] }, mediaStorageKey: { not: null }, ...(options.ids ? { id: { in: options.ids } } : {}) },
    data: { analysisStatus: "PENDING", analysisError: null },
  });
  if (res.count > 0) {
    await recordAudit(prisma, {
      actor: actor.actorId,
      actorType: "HUMAN",
      action: "REFERENCE_VIDEOS_REQUEUED",
      entityType: "ReferenceContent",
      entityId: options.ids?.length === 1 ? options.ids[0]! : "batch",
      after: { count: res.count, ids: options.ids ?? null, includeDone: !!options.includeDone, outdated: !!options.outdated, toVersion: REFERENCE_METRICS_VERSION },
    });
  }
  return res.count;
}

/**
 * Stores one video's measurement (validated against ReferenceVideoMetricsSchema — a malformed
 * result is recorded as a failure, never half-written) or its failure.
 */
export async function recordReferenceAnalysis(
  prisma: PrismaClient,
  id: string,
  outcome: { metrics: ReferenceVideoMetrics } | { error: string },
  actor: { actorId: string },
) {
  if ("metrics" in outcome) {
    const parsed = ReferenceVideoMetricsSchema.safeParse(outcome.metrics);
    if (!parsed.success) {
      return recordReferenceAnalysis(prisma, id, { error: `The measurement came out malformed: ${parsed.error.issues[0]?.message ?? "invalid"}` }, actor);
    }
    const m = parsed.data;
    const before = await prisma.referenceContent.findUniqueOrThrow({ where: { id }, select: { hook: true } });
    const row = await prisma.referenceContent.update({
      where: { id },
      data: {
        analysisStatus: "DONE",
        analysisError: null,
        analyzedAt: new Date(),
        metrics: m as never,
        // The version the numbers were actually measured with (an old runner may still write v1).
        metricsVersion: m.version,
        durationSeconds: Math.round(m.video.durationS),
        hook: before.hook || m.speech?.hookText || null,
      },
    });
    await recordAudit(prisma, {
      actor: actor.actorId,
      actorType: "JOB",
      action: "REFERENCE_VIDEO_MEASURED",
      entityType: "ReferenceContent",
      entityId: id,
      after: { cuts: m.cuts?.count ?? null, shotMedianS: m.cuts?.shotMedianS ?? null, wpm: m.speech?.wpm ?? null, lufs: m.audio?.integratedLufs ?? null },
    });
    return row;
  }
  const row = await prisma.referenceContent.update({
    where: { id },
    data: { analysisStatus: "FAILED", analysisError: outcome.error.slice(0, 1000), analyzedAt: new Date() },
  });
  await recordAudit(prisma, { actor: actor.actorId, actorType: "JOB", action: "REFERENCE_VIDEO_MEASURE_FAILED", entityType: "ReferenceContent", entityId: id, after: { error: outcome.error.slice(0, 500) } });
  return row;
}

/**
 * Deletes a reference video's FILE (copyright / storage hygiene) and keeps its measured
 * numbers, link and history. `deleteObject` is the storage adapter's delete. Idempotent.
 */
export async function deleteReferenceVideoMedia(
  prisma: PrismaClient,
  id: string,
  deleteObject: (key: string) => Promise<void>,
  actor: { actorId: string },
) {
  const row = await prisma.referenceContent.findUniqueOrThrow({ where: { id } });
  if (!row.mediaStorageKey) return row;
  await deleteObject(row.mediaStorageKey);
  const updated = await prisma.referenceContent.update({
    where: { id },
    data: {
      mediaStorageKey: null,
      mediaDeletedAt: new Date(),
      // A video that was never measured can't be any more.
      ...(row.analysisStatus === "PENDING" ? { analysisStatus: "FAILED" as const, analysisError: "The file was deleted before it was measured." } : {}),
    },
  });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "REFERENCE_VIDEO_MEDIA_DELETED",
    entityType: "ReferenceContent",
    entityId: id,
    before: { storageKey: row.mediaStorageKey, filename: row.mediaFilename },
    after: { metricsKept: row.metrics != null },
  });
  return updated;
}

/** Reference videos of one creator (newest first) with their parsed metrics. */
export async function listReferenceVideos(prisma: PrismaClient, referenceCreatorId: string) {
  const rows = await prisma.referenceContent.findMany({
    where: { referenceCreatorId, OR: [{ mediaFilename: { not: null } }, { analysisStatus: { not: null } }] },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({ ...r, parsedMetrics: parseReferenceVideoMetrics(r.metrics) }));
}

/** Per-creator counts for the /reference list. */
export async function referenceVideoCounts(prisma: PrismaClient): Promise<Map<string, { total: number; measured: number; pending: number; failed: number }>> {
  const rows = await prisma.referenceContent.groupBy({
    by: ["referenceCreatorId", "analysisStatus"],
    where: { analysisStatus: { not: null } },
    _count: { _all: true },
  });
  const out = new Map<string, { total: number; measured: number; pending: number; failed: number }>();
  for (const r of rows) {
    const c = out.get(r.referenceCreatorId) ?? { total: 0, measured: 0, pending: 0, failed: 0 };
    const n = r._count._all;
    c.total += n;
    if (r.analysisStatus === "DONE") c.measured += n;
    if (r.analysisStatus === "PENDING") c.pending += n;
    if (r.analysisStatus === "FAILED") c.failed += n;
    out.set(r.referenceCreatorId, c);
  }
  return out;
}

/**
 * THE reference style for downstream use (the edit planner, later): medians of every measured
 * reference video — of one creator, or of all of them ("target style"). Each video counts once.
 * Read-only; makes no model calls. `sampleSize`/`confidence` say how much to trust it.
 */
export async function getReferenceStyleProfile(
  prisma: PrismaClient,
  options: { referenceCreatorId?: string; group?: ReferenceStyleGroup } = {},
): Promise<StyleProfile> {
  // Any row with numbers counts — including one waiting to be re-measured with a newer measuring
  // version (its previous numbers stand until the new ones land), so updating doesn't blank the style.
  const rows = await prisma.referenceContent.findMany({
    where: { analysisStatus: { not: null }, metrics: { not: Prisma.AnyNull }, ...(options.referenceCreatorId ? { referenceCreatorId: options.referenceCreatorId } : {}) },
    orderBy: { analyzedAt: "desc" },
    select: { referenceCreatorId: true, metrics: true, referenceCreator: { select: { formats: true } } },
    take: 2000,
  });
  const items: Array<{ metrics: ReferenceVideoMetrics; creatorId: string }> = [];
  for (const r of rows) {
    if (options.group && creatorStyleGroup(r.referenceCreator.formats) !== options.group) continue;
    const m = parseReferenceVideoMetrics(r.metrics);
    if (m) items.push({ metrics: m, creatorId: r.referenceCreatorId });
  }
  return aggregateStyle(items);
}

/**
 * Chris's own delivery, from raw takes that already have word timings (no new transcription):
 * speech metrics per take, aggregated. Cuts/audio aren't compared — raw takes are unedited.
 */
export async function getOwnSpeechProfile(prisma: PrismaClient, options: { limit?: number } = {}): Promise<OwnSpeechProfile> {
  const takes = await prisma.mediaAsset.findMany({
    where: { kind: "RAW_TAKE", removedAt: null, transcriptWords: { not: Prisma.AnyNull } },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 40,
    select: { transcriptWords: true, durationSeconds: true },
  });
  const per: Array<NonNullable<ReferenceVideoMetrics["speech"]>> = [];
  for (const t of takes) {
    const words = Array.isArray(t.transcriptWords) ? (t.transcriptWords as unknown as TimedWord[]) : [];
    if (words.length < 5) continue;
    const last = words[words.length - 1]!;
    const s = speechMetrics(words, Math.max(t.durationSeconds ?? 0, last.end ?? 0), null);
    if (s) per.push(s);
  }
  return aggregateOwnSpeech(per);
}

/**
 * Style groups. Chris mixes two kinds of video: talking videos (him on camera — the MAIN style
 * his edits learn from) and no-face motivational videos (text/voice/B-roll, made without him).
 * Blending both into one "target style" would drag his talking-video pacing toward a format he
 * isn't filming, so a creator can be marked FACELESS and gets its own style card. Stored as a
 * tag in ReferenceCreator.formats (an existing string[] column) — no migration.
 */
export type ReferenceStyleGroup = "MAIN" | "FACELESS";
export const FACELESS_STYLE_FORMAT = "No-face motivational";

export function creatorStyleGroup(formats: unknown): ReferenceStyleGroup {
  return Array.isArray(formats) && formats.includes(FACELESS_STYLE_FORMAT) ? "FACELESS" : "MAIN";
}

export async function setReferenceCreatorStyleGroup(
  prisma: PrismaClient,
  id: string,
  group: ReferenceStyleGroup,
  actor: { actorId: string },
) {
  const before = await prisma.referenceCreator.findUniqueOrThrow({ where: { id }, select: { formats: true } });
  const current = Array.isArray(before.formats) ? before.formats.filter((f): f is string => typeof f === "string") : [];
  const rest = current.filter((f) => f !== FACELESS_STYLE_FORMAT);
  const formats = group === "FACELESS" ? [...rest, FACELESS_STYLE_FORMAT] : rest;
  const row = await prisma.referenceCreator.update({ where: { id }, data: { formats } });
  await recordAudit(prisma, { actor: actor.actorId, actorType: "HUMAN", action: "REFERENCE_CREATOR_STYLE_GROUP_SET", entityType: "ReferenceCreator", entityId: id, before: { formats: current }, after: { formats } });
  return row;
}

/**
 * Moves a reference video to another creator (picked, or found/created by name) — for fixing
 * a batch filed under the wrong name. The storage key keeps its original creator prefix: keys
 * are only checked against the creator at registration time, and the file never moves, so
 * nothing downstream depends on the prefix after that. Audited; numbers (if measured) move too.
 */
export async function moveReferenceVideo(
  prisma: PrismaClient,
  id: string,
  target: { referenceCreatorId?: string | null; name?: string | null },
  actor: { actorId: string },
) {
  const before = await prisma.referenceContent.findUniqueOrThrow({ where: { id }, select: { referenceCreatorId: true } });
  const to = await findOrCreateReferenceCreator(prisma, target, actor);
  if (to.id === before.referenceCreatorId) return { id, referenceCreatorId: to.id, name: to.name, moved: false };
  await prisma.referenceContent.update({ where: { id }, data: { referenceCreatorId: to.id } });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "REFERENCE_VIDEO_MOVED",
    entityType: "ReferenceContent",
    entityId: id,
    before: { referenceCreatorId: before.referenceCreatorId },
    after: { referenceCreatorId: to.id, name: to.name },
  });
  return { id, referenceCreatorId: to.id, name: to.name, moved: true };
}

/**
 * The StyleModel (style-model.ts) for a group or one creator: every measured reference (any
 * metrics version — v3 rows carry the screen signals) plus Chris's own hand edits as "mine"
 * samples (the latest per video, weighted double). A creator's "don't copy" note excludes it
 * from the signals it names. Reference learning, docs/PREMIUM_EDITOR_PLAN.md round 4.
 */
export async function getStyleModel(
  prisma: PrismaClient,
  options: { referenceCreatorId?: string; group?: ReferenceStyleGroup; includeMine?: boolean; mineLimit?: number } = {},
): Promise<StyleModel> {
  const rows = await prisma.referenceContent.findMany({
    where: { analysisStatus: { not: null }, metrics: { not: Prisma.AnyNull }, ...(options.referenceCreatorId ? { referenceCreatorId: options.referenceCreatorId } : {}) },
    orderBy: { analyzedAt: "desc" },
    select: { id: true, referenceCreatorId: true, metrics: true, mediaFilename: true, referenceCreator: { select: { name: true, formats: true, doNotTransfer: true } } },
    take: 2000,
  });
  const samples: StyleSample[] = [];
  const exclusions = new Map<string, { creatorId: string; name: string; signals: StyleSignal[] }>();
  for (const r of rows) {
    if (options.group && creatorStyleGroup(r.referenceCreator.formats) !== options.group) continue;
    const m = parseReferenceVideoMetrics(r.metrics);
    if (!m) continue;
    samples.push(sampleFromReferenceMetrics(m, r.referenceCreatorId, r.mediaFilename ?? r.id));
    if (!exclusions.has(r.referenceCreatorId)) {
      const signals = excludedSignals(r.referenceCreator.doNotTransfer);
      if (signals.length) exclusions.set(r.referenceCreatorId, { creatorId: r.referenceCreatorId, name: r.referenceCreator.name, signals });
    }
  }
  if (options.includeMine !== false && !options.referenceCreatorId && options.group !== "FACELESS") {
    // His hand edits: the latest finishing edit per video that is a real hand edit (not an
    // automatic cut he merely saved), read as what IS on screen.
    const plans = await prisma.editPlan.findMany({
      where: { revisionReason: { startsWith: "Finishing edit by Chris" } },
      orderBy: { createdAt: "desc" },
      select: { contentItemId: true, revisionReason: true, plan: true, createdAt: true },
      take: 200,
    });
    const seen = new Set<string>();
    for (const p of plans) {
      if (seen.size >= (options.mineLimit ?? 30)) break;
      if (seen.has(p.contentItemId) || !isHandEditReason(p.revisionReason)) continue;
      const timeline = timelineLike((p.plan as { timeline?: unknown } | null)?.timeline);
      if (!timeline) continue;
      seen.add(p.contentItemId);
      samples.push(sampleFromTimeline(timeline, `my edit ${p.createdAt.toISOString().slice(0, 10)}`));
    }
  }
  return buildStyleModel(samples, { exclusions: [...exclusions.values()] });
}
