import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { prisma, enqueueHeavyJob, listOnlineRenderWorkers } from "@chris/domain";
import { estimateFilmRender, chooseChunkCount, resolveFilm, validateFilm, type FilmRenderEstimate } from "@chris/cinema/pure";
import { heavyJobSubject, parseHeavyJobArgs, type FilmJobKind, type HeavyJobArgsByKind } from "@chris/worker/heavy-job-kinds";
import { cloudKindAllowed, runHeavyJob, sandboxConfig, type RunHeavyJobResult } from "./heavy-jobs";
import { cloudWorkerConfigured, heavyJobMode } from "./render-config";

/**
 * SERVER-ONLY. Where mini-movie jobs run — the studio must cost $0:
 *
 *  1. Chris's Mac render worker when it's online (apps/worker/src/film-worker.ts heartbeats):
 *     the job is QUEUED for the Mac; the worker picks it up within seconds. $0, fastest (GPU).
 *  2. Local development (`next dev` on the Mac, RENDER_MODE inline): queued for the Mac and a
 *     one-shot render worker is started as a child process (the engine never loads inside the
 *     Next.js server — same rule as the motion engine). $0.
 *  3. The Vercel Sandbox ONLY when Chris explicitly chooses it (`where: "cloud"`, the
 *     "Render in the cloud (~$X)" button) — film-render runs chunked across workers. Storyboards
 *     are the exception: a few stills cost ~$0.03 of Vercel's included credit, so `auto` may use
 *     the cloud for them when the Mac is offline.
 *  4. Otherwise (`auto`, Mac offline, a full render): nothing starts — the answer says so, with
 *     both options (queue for the Mac, or the cloud estimate) for the UI to offer.
 */

export type FilmJobWhere = "auto" | "mac" | "cloud";

export type StartFilmJobResult =
  | RunHeavyJobResult
  | { status: "queued-for-mac"; jobRunId: string; message: string }
  | { status: "needs-choice"; jobRunId: null; message: string; options: FilmRenderOptions };

export interface FilmRenderOptions {
  macOnline: boolean;
  mac: FilmRenderEstimate;
  cloud: (FilmRenderEstimate & { available: boolean; why?: string }) | null;
}

/** Estimates for the "how should this render?" choice (no side effects). */
export async function filmRenderOptions(film: unknown, tier: "PREVIEW" | "FINAL"): Promise<FilmRenderOptions> {
  const v = validateFilm(film);
  const durationSeconds = v.ok ? resolveFilm(v.film).durationSeconds : 45;
  const macOnline = (await listOnlineRenderWorkers(prisma).catch(() => [])).length > 0;
  const chunks = chooseChunkCount(durationSeconds, tier, sandboxConfig().maxSandboxes);
  const cloudAvailable = cloudWorkerConfigured() && cloudKindAllowed("film-render") && cloudKindAllowed("film-render-chunk");
  return {
    macOnline,
    mac: estimateFilmRender({ durationSeconds, tier, host: "MAC_GPU" }),
    cloud: { ...estimateFilmRender({ durationSeconds, tier, host: "SANDBOX_8VCPU", chunks }), available: cloudAvailable, ...(cloudAvailable ? {} : { why: "The cloud renderer isn't switched on for mini-movies (RENDER_SANDBOX_SNAPSHOT_ID / RENDER_SANDBOX_KINDS)." }) },
  };
}

/** Local dev: a one-shot Mac render worker as a detached child process (it takes the queued job and exits). */
export function startLocalFilmWorker(): boolean {
  const repo = [process.cwd(), resolve(process.cwd(), ".."), resolve(process.cwd(), "../..")].find((d) => existsSync(join(d, "apps/worker/src/film-worker.ts")));
  if (!repo) return false;
  const tsx = join(repo, "node_modules/.bin/tsx");
  if (!existsSync(tsx)) return false;
  const child = spawn(tsx, [join(repo, "apps/worker/src/film-worker.ts"), "--once", "--id", "local-dev"], { cwd: repo, env: process.env, detached: true, stdio: "ignore" });
  child.unref();
  return true;
}

export async function startFilmJob<K extends FilmJobKind>(kind: K, rawArgs: HeavyJobArgsByKind[K], options: { actorId: string; where?: FilmJobWhere }): Promise<StartFilmJobResult> {
  const args = parseHeavyJobArgs(kind, rawArgs);
  const where = options.where ?? "auto";
  const macOnline = (await listOnlineRenderWorkers(prisma).catch(() => [])).length > 0;
  const queueForMac = async (): Promise<StartFilmJobResult> => {
    const q = await enqueueHeavyJob(prisma, { subject: heavyJobSubject(kind, args), jobKind: kind, args, mode: "worker", actorId: options.actorId, target: "mac", message: macOnline ? "Your Mac is picking this up…" : "Waiting for your Mac to come online…" });
    if (!q.queued) return { status: "busy", jobRunId: q.activeJobRunId, jobKind: kind, message: "That's already rendering — follow its progress here." };
    return { status: "queued-for-mac", jobRunId: q.jobRunId, message: macOnline ? "Rendering on your Mac — $0." : "Queued for your Mac — it starts as soon as the render worker is running." };
  };
  if (where === "mac") return queueForMac();
  if (where === "cloud") return runHeavyJob(kind, args, { actorId: options.actorId, background: true });
  // auto
  if (macOnline) return queueForMac();
  if (heavyJobMode() === "inline") {
    const r = await queueForMac();
    if (r.status === "queued-for-mac") {
      startLocalFilmWorker();
      return { ...r, message: "Rendering on this Mac — $0." };
    }
    return r;
  }
  if (kind !== "film-render" && cloudWorkerConfigured() && cloudKindAllowed(kind)) return runHeavyJob(kind, args, { actorId: options.actorId, background: true });
  const film = (args as { film?: unknown }).film ?? null;
  const tier = kind === "film-render" ? (args as HeavyJobArgsByKind["film-render"]).tier : "PREVIEW";
  return { status: "needs-choice", jobRunId: null, message: "Your Mac's render worker is offline. Start it to render for $0, or render in the cloud.", options: await filmRenderOptions(film, tier) };
}
