import { prisma, getHeavyJob } from "@chris/domain";
import { isHeavyJobKind } from "@chris/worker/heavy-job-kinds";
import type { EngineJob, RenderResult, StoryboardResult } from "@chris/agents/studio";
import { runHeavyJob, reconcileHeavyJob } from "../heavy-jobs";
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
      const r = await runHeavyJob(kind as never, args as never, { actorId, background: true });
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
