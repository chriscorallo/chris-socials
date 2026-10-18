import type { PackKind } from "./packs";

/**
 * Persistence port for the studio orchestrator. The real implementation is Prisma
 * (packages/domain film-studio.ts — Film / FilmVersion / FilmArtifact, append-only, audited);
 * `InMemoryFilmStore` is for tests. Versions and artifacts are NEVER updated or deleted —
 * a revision is a new version, a re-run is a new artifact (or a no-op when its idempotency key
 * already exists).
 */

export const FILM_STATUSES = ["WORKING", "NEEDS_CHATGPT", "NEEDS_CHRIS", "RENDERING", "READY", "BLOCKED", "STOPPED", "FAILED"] as const;
export type FilmStatus = (typeof FILM_STATUSES)[number];

export const FILM_STEPS = [
  "WRITE",
  "VALIDATE",
  "VERIFY",
  "STORYBOARD",
  "STORYBOARD_WAIT",
  "AUTO_REVIEW",
  "REVIEW",
  "FIX",
  "STORYBOARD_REVIEW",
  "RENDER",
  "RENDER_WAIT",
  "FINAL_QC",
  "DONE",
] as const;
export type FilmStep = (typeof FILM_STEPS)[number];

export interface FilmLimits {
  /** Crew revision rounds (REVIEW → REVISE loops). */
  maxIterations: number;
  /** ChatGPT / local-AI round trips of any kind. */
  maxRoundTrips: number;
  /** Engine-validation repair attempts per version chain. */
  maxRepairs: number;
  maxStoryboards: number;
  maxRenders: number;
  /** Automatic local-AI calls (only when local AI is on). */
  maxLocalAiCalls: number;
}

export const DEFAULT_FILM_LIMITS: FilmLimits = { maxIterations: 3, maxRoundTrips: 10, maxRepairs: 3, maxStoryboards: 8, maxRenders: 3, maxLocalAiCalls: 12 };

export interface PendingPack {
  kind: PackKind;
  title: string;
  prompt: string;
  imageUrl: string | null;
  promptVersions: Array<{ id: string; version: string }>;
  /** FIX packs: why. */
  reason?: string;
  issuedAt: string;
  /** Set when the last paste didn't fit — shown with the one-tap repair message. */
  lastErrors?: string[];
  repairMessage?: string;
}

export interface FilmCounters {
  roundTrips: number;
  repairs: number;
  storyboards: number;
  renders: number;
  localAiCalls: number;
}

export interface FilmRecord {
  id: string;
  title: string;
  idea: string;
  targetSeconds: number;
  look: string;
  voiceId: string;
  voiceEngine: "KOKORO" | "CHRIS";
  aiMode: "CHATGPT" | "LOCAL";
  status: FilmStatus;
  step: FilmStep;
  iteration: number;
  counters: FilmCounters;
  limits: FilmLimits;
  currentVersionId: string | null;
  pending: PendingPack | null;
  engineJob: { id: string; kind: "STORYBOARD" | "RENDER"; versionId: string } | null;
  confirmedClaims: string[];
  chrisNotes: string[];
  /** After a Chris edit/redo the crew's creative review round is skipped (he outranks it); the automatic crew still runs. */
  skipCreativeReview: boolean;
  statusMessage: string | null;
  blockedReasons: string[];
  lastError: string | null;
  sourceContentItemId: string | null;
  contentItemId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type VersionOrigin = "CREW_WRITE" | "CREW_REVISION" | "FIX" | "CHRIS_EDIT" | "CHATGPT_DRAFT";

export interface FilmVersionRecord {
  id: string;
  filmId: string;
  version: number;
  origin: VersionOrigin;
  parentVersionId: string | null;
  /** The DSL exactly as received (may be invalid — validation is recorded beside it). */
  film: unknown;
  script: unknown;
  brief: unknown;
  note: string;
  createdBy: string;
  createdAt: Date;
}

export type ArtifactAgent =
  | "FILM_DIRECTOR"
  | "FILM_HOOK"
  | "FILM_SCREENWRITER"
  | "FILM_CINEMATOGRAPHER"
  | "FILM_MEANING_MATCH"
  | "FILM_COHESION"
  | "FILM_RETENTION"
  | "FILM_QUALITY"
  | "FILM_ANALYSIS"
  | "CLAIMS_GATE"
  | "VERIFICATION"
  | "CONTINUITY"
  | "QUALITY_BASICS"
  | "MEANING_MATCH_FIRST_PASS"
  | "DIRECTOR_GUARD"
  | "ENGINE"
  | "ORCHESTRATOR"
  | "CHRIS";

export interface FilmArtifactRecord {
  id: string;
  filmId: string;
  versionId: string | null;
  kind: string;
  agent: ArtifactAgent;
  /** Where it came from: DETERMINISTIC / LOCAL_EMBEDDING / CHATGPT / LOCAL_AI / ENGINE / CHRIS. */
  via: string;
  promptVersion: string | null;
  iteration: number;
  idempotencyKey: string;
  summary: string;
  payload: unknown;
  gate: "PASS" | "BLOCK" | null;
  createdAt: Date;
}

export type NewArtifact = Omit<FilmArtifactRecord, "id" | "createdAt">;

export type NewFilm = Pick<FilmRecord, "title" | "idea" | "targetSeconds" | "look" | "voiceId" | "voiceEngine" | "aiMode" | "createdBy"> & Partial<Pick<FilmRecord, "sourceContentItemId" | "limits">>;

export interface FilmStore {
  createFilm(input: NewFilm): Promise<FilmRecord>;
  getFilm(id: string): Promise<FilmRecord | null>;
  updateFilm(id: string, patch: Partial<Omit<FilmRecord, "id" | "createdAt" | "updatedAt">>): Promise<FilmRecord>;
  addVersion(input: Omit<FilmVersionRecord, "id" | "version" | "createdAt">): Promise<FilmVersionRecord>;
  getVersion(id: string): Promise<FilmVersionRecord | null>;
  listVersions(filmId: string): Promise<FilmVersionRecord[]>;
  /** Idempotent: an existing idempotencyKey returns the existing row unchanged. */
  addArtifact(input: NewArtifact): Promise<FilmArtifactRecord>;
  findArtifact(idempotencyKey: string): Promise<FilmArtifactRecord | null>;
  listArtifacts(filmId: string): Promise<FilmArtifactRecord[]>;
  /** One worker per film at a time (resumable: an expired lease is taken over). */
  acquireLease(filmId: string, ms: number, holder: string): Promise<boolean>;
  releaseLease(filmId: string, holder: string): Promise<void>;
}

let seq = 0;
const nid = (p: string) => `${p}_${(++seq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export class InMemoryFilmStore implements FilmStore {
  films = new Map<string, FilmRecord>();
  versions: FilmVersionRecord[] = [];
  artifacts: FilmArtifactRecord[] = [];
  leases = new Map<string, { holder: string; until: number }>();
  /** Test hook: throw on the n-th updateFilm call (simulates a crash mid-step). */
  failNextUpdate = 0;

  async createFilm(input: Partial<FilmRecord> & Pick<FilmRecord, "title" | "idea">): Promise<FilmRecord> {
    const now = new Date();
    const rec: FilmRecord = {
      id: input.id ?? nid("film"),
      title: input.title,
      idea: input.idea,
      targetSeconds: input.targetSeconds ?? 45,
      look: input.look ?? "GOLD_STUDIO",
      voiceId: input.voiceId ?? "am_michael",
      voiceEngine: input.voiceEngine ?? "KOKORO",
      aiMode: input.aiMode ?? "CHATGPT",
      status: input.status ?? "WORKING",
      step: input.step ?? "WRITE",
      iteration: input.iteration ?? 1,
      counters: input.counters ?? { roundTrips: 0, repairs: 0, storyboards: 0, renders: 0, localAiCalls: 0 },
      limits: input.limits ?? DEFAULT_FILM_LIMITS,
      currentVersionId: input.currentVersionId ?? null,
      pending: input.pending ?? null,
      engineJob: input.engineJob ?? null,
      confirmedClaims: input.confirmedClaims ?? [],
      chrisNotes: input.chrisNotes ?? [],
      skipCreativeReview: input.skipCreativeReview ?? false,
      statusMessage: input.statusMessage ?? null,
      blockedReasons: input.blockedReasons ?? [],
      lastError: input.lastError ?? null,
      sourceContentItemId: input.sourceContentItemId ?? null,
      contentItemId: input.contentItemId ?? null,
      createdBy: input.createdBy ?? "test",
      createdAt: now,
      updatedAt: now,
    };
    this.films.set(rec.id, rec);
    return rec;
  }

  async getFilm(id: string) {
    const f = this.films.get(id);
    return f ? structuredClone(f) : null;
  }
  async updateFilm(id: string, patch: Partial<FilmRecord>) {
    if (this.failNextUpdate > 0 && --this.failNextUpdate === 0) throw new Error("simulated crash");
    const f = this.films.get(id);
    if (!f) throw new Error(`No film ${id}`);
    const next = { ...f, ...structuredClone(patch), updatedAt: new Date() } as FilmRecord;
    this.films.set(id, next);
    return structuredClone(next);
  }
  async addVersion(input: Omit<FilmVersionRecord, "id" | "version" | "createdAt">) {
    const version = this.versions.filter((v) => v.filmId === input.filmId).length + 1;
    const rec: FilmVersionRecord = { ...structuredClone(input), id: nid("fv"), version, createdAt: new Date() };
    this.versions.push(rec);
    return structuredClone(rec);
  }
  async getVersion(id: string) {
    const v = this.versions.find((x) => x.id === id);
    return v ? structuredClone(v) : null;
  }
  async listVersions(filmId: string) {
    return structuredClone(this.versions.filter((v) => v.filmId === filmId));
  }
  async addArtifact(input: NewArtifact) {
    const existing = this.artifacts.find((a) => a.idempotencyKey === input.idempotencyKey);
    if (existing) return structuredClone(existing);
    const rec: FilmArtifactRecord = { ...structuredClone(input), id: nid("fa"), createdAt: new Date() };
    this.artifacts.push(rec);
    return structuredClone(rec);
  }
  async findArtifact(key: string) {
    const a = this.artifacts.find((x) => x.idempotencyKey === key);
    return a ? structuredClone(a) : null;
  }
  async listArtifacts(filmId: string) {
    return structuredClone(this.artifacts.filter((a) => a.filmId === filmId));
  }
  async acquireLease(filmId: string, ms: number, holder: string) {
    const l = this.leases.get(filmId);
    if (l && l.until > Date.now() && l.holder !== holder) return false;
    this.leases.set(filmId, { holder, until: Date.now() + ms });
    return true;
  }
  async releaseLease(filmId: string, holder: string) {
    if (this.leases.get(filmId)?.holder === holder) this.leases.delete(filmId);
  }
}
