import { describe, it, expect } from "vitest";
import { prisma } from "@chris/domain";
import { validateFilm, formatIssues } from "@chris/cinema/pure";
import {
  advanceFilm,
  approveStoryboard,
  claimKey,
  confirmClaims,
  demoAnswerFor,
  FakeFilmEngine,
  LexicalEmbedder,
  PrismaFilmStore,
  sendFilmToVideos,
  startFilm,
  submitPackAnswer,
  type StudioDeps,
  type StudioFilm,
} from "../studio";

describe("PrismaFilmStore — the real tables (append-only, audited, idempotent)", () => {
  it("runs a whole film on the database, never edits a version/artifact, and Send to Videos is idempotent", async () => {
    const store = new PrismaFilmStore(prisma);
    const engine = new FakeFilmEngine({ validate: (d) => { const r = validateFilm(d); return r.ok ? { ok: true, film: r.film as unknown as StudioFilm, warnings: [] } : { ok: false, errors: r.errors, warnings: [] }; }, formatIssues });
    const deps: StudioDeps = { store, engine, embedder: new LexicalEmbedder() };
    const film = await startFilm(deps, { title: "DB film", idea: "raise disappears", targetSeconds: 40, look: "GOLD_STUDIO", voiceId: "am_michael", voiceEngine: "KOKORO", aiMode: "CHATGPT", createdBy: "chris" });
    const until = async () => {
      let r = await advanceFilm(deps, film.id);
      for (let i = 0; i < 6 && r.waitingFor === "ENGINE"; i++) r = await advanceFilm(deps, film.id);
      return r;
    };
    await until();
    await submitPackAnswer(deps, film.id, demoAnswerFor("WRITE", null), "chris");
    await until();
    const cur = async () => (await store.getVersion((await store.getFilm(film.id))!.currentVersionId!))!.film;
    await submitPackAnswer(deps, film.id, demoAnswerFor("REVIEW", await cur()), "chris");
    await until();
    await submitPackAnswer(deps, film.id, demoAnswerFor("REVIEW", await cur()), "chris");
    await confirmClaims(deps, film.id, [claimKey("l2", "Taxes take 35%.")], "chris");
    expect((await approveStoryboard(deps, film.id, "chris")).ok).toBe(true);
    const done = await until();
    expect(done.film.status).toBe("READY");
    expect(done.film.pending).toBeNull();
    expect(done.film.engineJob).toBeNull();

    const versions = await prisma.filmVersion.findMany({ where: { filmId: film.id }, orderBy: { version: "asc" } });
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    const arts = await prisma.filmArtifact.findMany({ where: { filmId: film.id } });
    expect(arts.length).toBeGreaterThan(20);
    expect(arts.some((a) => a.kind === "MEANING_MATCH_AUTO" && a.gate === "BLOCK")).toBe(true);

    // Idempotent artifact write returns the original row.
    const again = await store.addArtifact({ filmId: film.id, versionId: null, kind: "X", agent: "ORCHESTRATOR", via: "DETERMINISTIC", promptVersion: null, iteration: 1, idempotencyKey: arts[0]!.idempotencyKey, summary: "different", payload: {}, gate: null });
    expect(again.id).toBe(arts[0]!.id);
    expect(again.summary).toBe(arts[0]!.summary);

    // Lease: a second worker can't take a held lease.
    expect(await store.acquireLease(film.id, 60_000, "a")).toBe(true);
    expect(await store.acquireLease(film.id, 60_000, "b")).toBe(false);
    await store.releaseLease(film.id, "a");
    expect(await store.acquireLease(film.id, 60_000, "b")).toBe(true);
    await store.releaseLease(film.id, "b");

    const sent = await sendFilmToVideos(prisma, store, film.id, "chris");
    expect(sent.created).toBe(true);
    expect((await sendFilmToVideos(prisma, store, film.id, "chris")).contentItemId).toBe(sent.contentItemId);
    const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: sent.contentItemId } });
    expect(item.format).toBe("MINI_MOVIE");

    const audit = await prisma.auditLog.findMany({ where: { entityType: "Film", entityId: film.id } });
    const actions = new Set(audit.map((a) => a.action));
    for (const a of ["FILM_CREATED", "FILM_VERSION_CREATED", "FILM_STATUS_CHANGED", "FILM_CHRIS_ACTION", "FILM_GATE_BLOCK"]) expect(actions).toContain(a);
  });
});
