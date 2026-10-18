import { prisma, getHeavyJob } from "@chris/domain";
import { isHeavyJobKind } from "@chris/worker/heavy-job-kinds";
import type { EngineJob, RenderResult, StoryboardResult } from "@chris/agents/studio";
import { reconcileHeavyJob } from "../heavy-jobs";
import { startFilmJob } from "../film-jobs";
import type { HeavyDispatch } from "./cinema-engine";

/**
 * SERVER-ONLY. Connects CinemaFilmEngine to the heavy-job dispatcher (local inline / Vercel
 * Sandbox) for the engine's mini-movie job kinds. Compiles today against the documented API;
 * `has()` is false until `film-storyboard` / `film-render` are in HEAVY_JOB_KINDS, so nothing is
 * dispatched before the worker can run it.
 *
 * TODO(engine wiring): once the kinds exist, confirm (1) the args shape in cinema-engine.ts
 * HEAVY_ARGS matches `parseHeavyJobArgs` for those kinds, (2) the job's `result` matches
 * StoryboardResult / RenderResult (or map it in `toEngineJob` below), (3) the lease subject — the
 * studio expects `film:<filmId>` so one film runs one heavy job at a time.
 */
export function heavyFilmDispatch(actorId: string): HeavyDispatch {
  return {
    has: (kind) => isHeavyJobKind(kind),
    async start(kind, args) {
      if (!isHeavyJobKind(kind)) return null;
      // $0 routing (apps/web/lib/film-jobs.ts): Chris's Mac render worker when it's online (or
      // this Mac in local dev); storyboards may use the cloud's included credit; a full render
      // never starts in the cloud on its own — it waits for the Mac, and the film page offers
      // "Render in the cloud (~$X)" (moveFilmJobToCloud) as an explicit choice.
      let r = await startFilmJob(kind, args as never, { actorId, where: "auto" });
      if (r.status === "needs-choice") r = await startFilmJob(kind, args as never, { actorId, where: "mac" });
      if (r.status === "refused") throw new Error(r.message);
      if (!r.jobRunId) throw new Error("The worker didn't return a job id.");
      return { jobId: r.jobRunId };
    },
    async get(jobId) {
      const found = await getHeavyJob(prisma, jobId);
      if (!found) return null;
      const view = await reconcileHeavyJob(found);
      return toEngineJob(view.id, view.status, view.summary as { jobKind?: string; progress?: { pct?: number; message?: string }; result?: unknown } | null, view.error);
    },
  };
}

export function toEngineJob(id: string, status: string, s: { jobKind?: string; progress?: { pct?: number; message?: string }; result?: unknown } | null, error: string | null): EngineJob {
  const kind = s?.jobKind === "film-render" ? "RENDER" : "STORYBOARD";
  const st = status === "SUCCEEDED" ? "DONE" : status === "FAILED" ? "FAILED" : status === "QUEUED" ? "QUEUED" : "RUNNING";
  const result = (s?.result ?? null) as Record<string, unknown> | null;
  return {
    id,
    kind,
    status: st,
    progressPct: s?.progress?.pct,
    message: s?.progress?.message,
    ...(st === "DONE" && kind === "STORYBOARD" ? { storyboard: result as unknown as StoryboardResult } : {}),
    ...(st === "DONE" && kind === "RENDER" ? { render: result as unknown as RenderResult } : {}),
    ...(st === "FAILED" ? { error: error ?? "the worker failed" } : {}),
  };
}
