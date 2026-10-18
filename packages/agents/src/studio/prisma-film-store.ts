import type { PrismaClient } from "@chris/domain";
import { createContentItem, recordAudit, Prisma } from "@chris/domain";
import { DEFAULT_FILM_LIMITS, type FilmArtifactRecord, type FilmRecord, type FilmStore, type FilmVersionRecord, type NewArtifact, type NewFilm } from "./store";

/**
 * Prisma FilmStore (Film / FilmVersion / FilmArtifact — migration 20261018070000_film_studio).
 * Append-only by construction: there is no update or delete of FilmVersion / FilmArtifact
 * anywhere in this file. Audited: film created, every version, every Chris action, every gate
 * BLOCK, every status change, Send to Videos. Sequential queries (PGlite).
 */

type FilmRow = Awaited<ReturnType<PrismaClient["film"]["findUniqueOrThrow"]>>;
type VersionRow = Awaited<ReturnType<PrismaClient["filmVersion"]["findUniqueOrThrow"]>>;
type ArtifactRow = Awaited<ReturnType<PrismaClient["filmArtifact"]["findUniqueOrThrow"]>>;

const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

function toFilm(r: FilmRow): FilmRecord {
  return {
    id: r.id,
    title: r.title,
    idea: r.idea,
    targetSeconds: r.targetSeconds,
    look: r.look,
    voiceId: r.voiceId,
    voiceEngine: r.voiceEngine === "CHRIS" ? "CHRIS" : "KOKORO",
    aiMode: r.aiMode === "LOCAL" ? "LOCAL" : "CHATGPT",
    status: r.status as FilmRecord["status"],
    step: r.step as FilmRecord["step"],
    iteration: r.iteration,
    counters: { roundTrips: 0, repairs: 0, storyboards: 0, renders: 0, localAiCalls: 0, ...((r.counters as object) ?? {}) },
    limits: { ...DEFAULT_FILM_LIMITS, ...((r.limits as object) ?? {}) },
    currentVersionId: r.currentVersionId,
    pending: (r.pending as FilmRecord["pending"]) ?? null,
    engineJob: (r.engineJob as FilmRecord["engineJob"]) ?? null,
    confirmedClaims: arr(r.confirmedClaims),
    chrisNotes: arr(r.chrisNotes),
    skipCreativeReview: r.skipCreativeReview,
    statusMessage: r.statusMessage,
    blockedReasons: arr(r.blockedReasons),
    lastError: r.lastError,
    sourceContentItemId: r.sourceContentItemId,
    contentItemId: r.contentItemId,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const toVersion = (r: VersionRow): FilmVersionRecord => ({ id: r.id, filmId: r.filmId, version: r.version, origin: r.origin as FilmVersionRecord["origin"], parentVersionId: r.parentVersionId, film: r.dsl, script: r.script, brief: r.brief, note: r.note, createdBy: r.createdBy, createdAt: r.createdAt });
const toArtifact = (r: ArtifactRow): FilmArtifactRecord => ({ id: r.id, filmId: r.filmId, versionId: r.versionId, kind: r.kind, agent: r.agent as FilmArtifactRecord["agent"], via: r.via, promptVersion: r.promptVersion, iteration: r.iteration, idempotencyKey: r.idempotencyKey, summary: r.summary, payload: r.payload, gate: (r.gate as "PASS" | "BLOCK" | null) ?? null, createdAt: r.createdAt });

const json = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v ?? null)) as object));

export class PrismaFilmStore implements FilmStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createFilm(input: NewFilm): Promise<FilmRecord> {
    const r = await this.prisma.film.create({
      data: {
        title: input.title,
        idea: input.idea,
        targetSeconds: input.targetSeconds,
        look: input.look,
        voiceId: input.voiceId,
        voiceEngine: input.voiceEngine,
        aiMode: input.aiMode,
        status: "WORKING",
        step: "WRITE",
        counters: { roundTrips: 0, repairs: 0, storyboards: 0, renders: 0, localAiCalls: 0 },
        limits: json(input.limits ?? DEFAULT_FILM_LIMITS)!,
        confirmedClaims: [],
        chrisNotes: [],
        blockedReasons: [],
        sourceContentItemId: input.sourceContentItemId ?? null,
        createdBy: input.createdBy,
      },
    });
    await recordAudit(this.prisma, { actor: input.createdBy, actorType: "HUMAN", action: "FILM_CREATED", entityType: "Film", entityId: r.id, after: { title: r.title, idea: r.idea.slice(0, 500), targetSeconds: r.targetSeconds, voiceId: r.voiceId, aiMode: r.aiMode } });
    return toFilm(r);
  }

  async getFilm(id: string) {
    const r = await this.prisma.film.findUnique({ where: { id } });
    return r ? toFilm(r) : null;
  }

  async updateFilm(id: string, patch: Partial<Omit<FilmRecord, "id" | "createdAt" | "updatedAt">>) {
    const before = patch.status ? await this.prisma.film.findUnique({ where: { id }, select: { status: true, step: true } }) : null;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      data[k] = ["counters", "limits", "pending", "engineJob", "confirmedClaims", "chrisNotes", "blockedReasons"].includes(k) ? (v === null ? { __null: true } : json(v)) : v;
    }
    for (const k of ["pending", "engineJob"]) if ((data[k] as { __null?: boolean } | undefined)?.__null) data[k] = Prisma.DbNull;
    const r = await this.prisma.film.update({ where: { id }, data: data as never });
    if (before && before.status !== r.status) {
      await recordAudit(this.prisma, { actor: "system", actorType: "SYSTEM", action: "FILM_STATUS_CHANGED", entityType: "Film", entityId: id, before: { status: before.status, step: before.step }, after: { status: r.status, step: r.step, message: r.statusMessage } });
    }
    return toFilm(r);
  }

  async addVersion(input: Omit<FilmVersionRecord, "id" | "version" | "createdAt">) {
    const last = await this.prisma.filmVersion.findFirst({ where: { filmId: input.filmId }, orderBy: { version: "desc" }, select: { version: true } });
    const r = await this.prisma.filmVersion.create({ data: { filmId: input.filmId, version: (last?.version ?? 0) + 1, origin: input.origin, parentVersionId: input.parentVersionId, dsl: json(input.film) ?? {}, script: json(input.script) ?? undefined, brief: json(input.brief) ?? undefined, note: input.note, createdBy: input.createdBy } });
    await recordAudit(this.prisma, { actor: input.createdBy, actorType: input.origin === "CHRIS_EDIT" ? "HUMAN" : "SYSTEM", action: "FILM_VERSION_CREATED", entityType: "Film", entityId: input.filmId, after: { versionId: r.id, version: r.version, origin: r.origin, note: r.note.slice(0, 300) } });
    return toVersion(r);
  }

  async getVersion(id: string) {
    const r = await this.prisma.filmVersion.findUnique({ where: { id } });
    return r ? toVersion(r) : null;
  }

  async listVersions(filmId: string) {
    return (await this.prisma.filmVersion.findMany({ where: { filmId }, orderBy: { version: "asc" } })).map(toVersion);
  }

  async addArtifact(input: NewArtifact) {
    const existing = await this.prisma.filmArtifact.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return toArtifact(existing);
    let r: ArtifactRow;
    try {
      r = await this.prisma.filmArtifact.create({ data: { filmId: input.filmId, versionId: input.versionId, kind: input.kind, agent: input.agent, via: input.via, promptVersion: input.promptVersion, iteration: input.iteration, idempotencyKey: input.idempotencyKey, summary: input.summary.slice(0, 2000), payload: json(input.payload) ?? {}, gate: input.gate } });
    } catch (err) {
      // A concurrent writer won the unique key — return its row (idempotent).
      const again = await this.prisma.filmArtifact.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (again) return toArtifact(again);
      throw err;
    }
    if (input.agent === "CHRIS" || input.gate === "BLOCK") {
      await recordAudit(this.prisma, { actor: input.agent === "CHRIS" ? "chris" : "system", actorType: input.agent === "CHRIS" ? "HUMAN" : "SYSTEM", action: input.agent === "CHRIS" ? "FILM_CHRIS_ACTION" : "FILM_GATE_BLOCK", entityType: "Film", entityId: input.filmId, after: { kind: input.kind, summary: input.summary.slice(0, 500), artifactId: r.id } });
    }
    return toArtifact(r);
  }

  async findArtifact(key: string) {
    const r = await this.prisma.filmArtifact.findUnique({ where: { idempotencyKey: key } });
    return r ? toArtifact(r) : null;
  }

  async listArtifacts(filmId: string) {
    return (await this.prisma.filmArtifact.findMany({ where: { filmId }, orderBy: { createdAt: "asc" } })).map(toArtifact);
  }

  async acquireLease(filmId: string, ms: number, holder: string) {
    const now = new Date();
    const r = await this.prisma.film.updateMany({ where: { id: filmId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }, { leaseHolder: holder }] }, data: { leaseHolder: holder, leaseUntil: new Date(now.getTime() + ms) } });
    return r.count === 1;
  }

  async releaseLease(filmId: string, holder: string) {
    await this.prisma.film.updateMany({ where: { id: filmId, leaseHolder: holder }, data: { leaseHolder: null, leaseUntil: null } });
  }

  async listFilms(limit = 30) {
    return (await this.prisma.film.findMany({ orderBy: { updatedAt: "desc" }, take: limit })).map(toFilm);
  }
}

/** "Send to Videos": the film becomes a ContentItem (once — idempotent) linked from the film.
 * The rendered file itself is attached by the engine's render registration (FilmEnginePort). */
export async function sendFilmToVideos(prisma: PrismaClient, store: PrismaFilmStore, filmId: string, actorId: string): Promise<{ contentItemId: string; created: boolean }> {
  const film = await store.getFilm(filmId);
  if (!film) throw new Error("Film not found.");
  if (film.contentItemId) return { contentItemId: film.contentItemId, created: false };
  if (film.status !== "READY") throw new Error("Only a finished film can go to Videos.");
  const item = await createContentItem(prisma, { title: film.title, description: `Mini-movie (Studio film ${film.id}). ${film.idea.slice(0, 400)}`, format: "MINI_MOVIE" }, { actorId });
  await store.updateFilm(filmId, { contentItemId: item.id });
  await store.addArtifact({ filmId, versionId: film.currentVersionId, kind: "SENT_TO_VIDEOS", agent: "CHRIS", via: "CHRIS", promptVersion: null, iteration: film.iteration, idempotencyKey: `${filmId}:sent-to-videos`, summary: `Sent to Videos as "${film.title}".`, payload: { contentItemId: item.id }, gate: null });
  return { contentItemId: item.id, created: true };
}
