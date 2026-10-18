import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The WHOLE studio once, for real (opt-in: STUDIO_E2E_REAL=1 — it renders a film, minutes):
 * the crew pipeline with the demo answers standing in for ChatGPT, on the throwaway test DB,
 * driving the REAL engine through the REAL dispatch — film-storyboard / film-render queued for
 * "the Mac" and picked up by one-shot render workers (apps/worker/src/film-worker.ts, child
 * processes, real Chrome/WebGL, Kokoro, Whisper, ffmpeg) — then Send to Videos attaching the
 * render to the MINI_MOVIE item through the normal take → edit plan → render path.
 * STUDIO_E2E_OUT=<dir> keeps a JSON report of what happened.
 */
const RUN = process.env.STUDIO_E2E_REAL === "1";

describe.runIf(RUN)("studio end to end with the real engine", () => {
  it("idea → crew → storyboard → review → render → READY → Send to Videos → RENDERED", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "chris-studio-e2e-store-"));
    process.env.STORAGE_LOCAL_DIR = storeDir;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.VERCEL;
    process.env.RENDER_MODE = "inline";
    const { prisma, getHeavyJob } = await import("@chris/domain");
    const { advanceFilm, approveStoryboard, confirmClaims, demoAnswerFor, LexicalEmbedder, PrismaFilmStore, sendFilmToVideos, startFilm, submitPackAnswer } = await import("@chris/agents/studio");
    const { CinemaFilmEngine } = await import("./cinema-engine");
    const { heavyFilmDispatch } = await import("./heavy-dispatch");
    const { attachStudioRender } = await import("../film-jobs");

    const store = new PrismaFilmStore(prisma);
    const engine = new CinemaFilmEngine(heavyFilmDispatch("chris"));
    const deps = { store, engine, embedder: new LexicalEmbedder(), brandContext: null, worker: "e2e" };
    const log: Array<{ t: number; step: string; status: string; note?: string }> = [];
    const t0 = Date.now();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    async function untilNotEngine(id: string, maxMs = 12 * 60_000) {
      const end = Date.now() + maxMs;
      let r = await advanceFilm(deps, id);
      while (r.waitingFor === "ENGINE" && Date.now() < end) {
        await sleep(3000);
        r = await advanceFilm(deps, id);
      }
      log.push({ t: Math.round((Date.now() - t0) / 1000), step: r.film.step, status: r.film.status, note: r.film.statusMessage ?? undefined });
      return r;
    }
    const cur = async (id: string) => (await store.getVersion((await store.getFilm(id))!.currentVersionId!))!.film;

    const film = await startFilm(deps, { title: "The Raise (studio e2e)", idea: "Why a raise disappears — and the fix", targetSeconds: 40, look: "GOLD_STUDIO", voiceId: "af_heart", voiceEngine: "KOKORO", aiMode: "CHATGPT", createdBy: "chris" });
    let r = await untilNotEngine(film.id);
    expect(r.film.pending?.kind).toBe("WRITE");
    expect(r.film.pending!.prompt).toContain("v1.1 VOCABULARY");
    expect(await submitPackAnswer(deps, film.id, demoAnswerFor("WRITE", null), "chris")).toMatchObject({ ok: true });

    // storyboard (real stills) → REVIEW pack with the real JPEG contact sheet
    for (let round = 0; round < 4; round++) {
      r = await untilNotEngine(film.id);
      if (r.film.pending?.kind !== "REVIEW") break;
      expect(r.film.pending.imageUrl).toBeTruthy();
      await submitPackAnswer(deps, film.id, demoAnswerFor("REVIEW", await cur(film.id)), "chris");
    }
    let f = (await store.getFilm(film.id))!;
    expect(f.step).toBe("STORYBOARD_REVIEW");
    const arts = await store.listArtifacts(film.id);
    const sb = arts.filter((a) => a.kind === "STORYBOARD").at(-1)!.payload as { stills: Array<{ url: string; metrics?: { emptyRatio?: number; textContrast?: Record<string, number> } }>; contactSheetUrl: string };
    expect(sb.stills.length).toBeGreaterThan(5);
    expect(sb.stills.every((s) => typeof s.metrics?.emptyRatio === "number")).toBe(true);
    const sheetKey = decodeURIComponent(sb.contactSheetUrl.split("key=")[1]!);
    expect(existsSync(join(storeDir, sheetKey))).toBe(true);

    // Chris confirms the facts and approves → real render
    const refused = await approveStoryboard(deps, film.id, "chris");
    if (!refused.ok) {
      const ver = arts.filter((a) => a.kind === "VERIFICATION").at(-1)!.payload as { claimsToConfirm: Array<{ lineId: string; text: string }> };
      const { claimKey } = await import("@chris/agents/studio");
      await confirmClaims(deps, film.id, ver.claimsToConfirm.map((c) => claimKey(c.lineId, c.text)), "chris");
      expect((await approveStoryboard(deps, film.id, "chris")).ok).toBe(true);
    }
    r = await untilNotEngine(film.id, 20 * 60_000);
    expect(r.film.status).toBe("READY");
    const render = (await store.listArtifacts(film.id)).filter((a) => a.kind === "RENDER").at(-1)!.payload as { videoUrl: string; durationSeconds: number; loudnessLufs: number; truePeakDbtp: number; frames: unknown[]; renderId: string; contactSheetUrl: string };
    expect(render.durationSeconds).toBeGreaterThan(20);
    expect(Math.abs(render.loudnessLufs + 14)).toBeLessThan(1.1);
    expect(render.frames.length).toBeGreaterThan(5);

    // Send to Videos → the engine attaches the film to the MINI_MOVIE item (no re-render)
    const sent = await sendFilmToVideos(prisma, store, film.id, "chris");
    const att = await attachStudioRender(film.id, sent.contentItemId, "chris");
    expect(att && "jobRunId" in att && att.jobRunId).toBeTruthy();
    const jobId = (att as { jobRunId: string }).jobRunId;
    let job = await getHeavyJob(prisma, jobId);
    for (let i = 0; i < 200 && job && (job.status === "QUEUED" || job.status === "RUNNING"); i++) {
      await sleep(3000);
      job = await getHeavyJob(prisma, jobId);
    }
    expect(job?.status).toBe("SUCCEEDED");
    const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: sent.contentItemId } });
    expect(item.format).toBe("MINI_MOVIE");
    expect(item.currentState).toBe("RENDERED");
    f = (await store.getFilm(film.id))!;
    const out = process.env.STUDIO_E2E_OUT;
    if (out) {
      writeFileSync(join(out, "studio-e2e-report.json"), JSON.stringify({ seconds: Math.round((Date.now() - t0) / 1000), log, counters: f.counters, render: { ...render, frames: render.frames.length }, contentItem: { id: item.id, state: item.currentState, format: item.format }, storyboardStills: sb.stills.length }, null, 2));
      for (const [name, url] of [["storyboard-sheet.jpg", sb.contactSheetUrl], ["render-sheet.jpg", render.contactSheetUrl], ["film.mp4", render.videoUrl]] as const) {
        const key = decodeURIComponent(url.split("key=")[1]!);
        writeFileSync(join(out, name), readFileSync(join(storeDir, key)));
      }
    }
  }, 45 * 60_000);
});
