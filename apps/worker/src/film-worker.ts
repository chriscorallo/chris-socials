/**
 * Chris's Mac render worker — the $0 way to render mini-movies (Apple GPU: a 40 s FINAL film in
 * ~3 minutes, vs ~10 minutes and ~$1 of cloud credit in the Sandbox).
 *
 *   pnpm --filter @chris/worker film-worker [--env <dotenv file>] [--once] [--id <name>]
 *
 * While it runs it checks in every 30 s (a `render-worker:<id>` JobRun heartbeat — the app sees
 * "your Mac is online" and queues film jobs for it), takes film-render / film-render-chunk /
 * film-storyboard / film-voice-align jobs that were queued for the Mac, runs them through the
 * SAME executor the cloud uses (runHeavyJobRecorded → progress on the JobRun, result, audit
 * trail), uploads results to the same storage. Ctrl-C (or logging out) marks it offline.
 * Login item: scripts/mac/com.chris.film-worker.plist (see packages/cinema/README.md).
 *
 * Needs the production DATABASE_URL and BLOB_READ_WRITE_TOKEN (or STORAGE_LOCAL_DIR for a local
 * setup) in the env file. Never needs a model key: film jobs make no AI calls.
 */
import { hostname } from "node:os";
import { existsSync } from "node:fs";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

export async function main(): Promise<void> {
  // an explicit --env wins; otherwise a dotenv file only when the caller didn't already pass the database (the app's local-dev spawn does)
  const envFile = arg("env") ?? (process.env.DATABASE_URL ? undefined : [".env.film-worker", ".env.local", ".env"].find((f) => existsSync(f)));
  if (envFile) {
    process.loadEnvFile(envFile);
    log("env_loaded", { file: envFile });
  }
  // the Mac has a GPU: ANGLE (Metal) is the fast path; never inherit the Sandbox's swangle
  if (!process.env.REMOTION_GL) process.env.REMOTION_GL = "angle";
  (globalThis as { __chrisCinemaLoader?: () => Promise<unknown> }).__chrisCinemaLoader = async () => import("@chris/cinema");
  const { prisma, claimQueuedHeavyJob, recordRenderWorkerHeartbeat, markRenderWorkerOffline } = await import("@chris/domain");
  const { runHeavyJobRecorded } = await import("./heavy-jobs");
  const { FILM_JOB_KINDS } = await import("./heavy-job-kinds");
  const storage = await createStorage();
  const workerId = arg("id") ?? `mac-${hostname().replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 40)}`;
  const kinds = [...FILM_JOB_KINDS];
  let busy: string | null = null;
  const beat = () => recordRenderWorkerHeartbeat(prisma, { workerId, host: hostname(), gpu: process.env.REMOTION_GL !== "swangle", kinds, busyJobRunId: busy }).catch((err) => log("heartbeat_failed", { error: String(err) }));
  await beat();
  const timer = setInterval(beat, 30_000);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await markRenderWorkerOffline(prisma, workerId).catch(() => undefined);
    log("offline", { workerId });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log("online", { workerId, kinds });
  const once = process.argv.includes("--once");
  for (;;) {
    const job = await claimQueuedHeavyJob(prisma, { kinds, target: "mac" }).catch((err) => {
      log("claim_failed", { error: String(err) });
      return null;
    });
    if (job) {
      busy = job.jobRunId;
      await beat();
      const t0 = Date.now();
      log("job_start", { kind: job.jobKind, jobRunId: job.jobRunId });
      const o = await runHeavyJobRecorded(job.jobRunId, job.jobKind as Parameters<typeof runHeavyJobRecorded>[1], job.args, {
        db: prisma,
        storage,
        actor: { actorId: job.actorId },
        progress: (p) => log("progress", p as unknown as Record<string, unknown>),
      });
      log("job_done", { ok: o.ok, ms: Date.now() - t0, message: o.message, error: o.error ?? null });
      busy = null;
      await beat();
      if (once) break;
      continue;
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  await stop();
}

async function createStorage() {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { VercelBlobStorageAdapter } = await import("./blob-storage");
    return new VercelBlobStorageAdapter();
  }
  const dir = process.env.STORAGE_LOCAL_DIR;
  if (!dir) throw new Error("No storage configured: set BLOB_READ_WRITE_TOKEN (production) or STORAGE_LOCAL_DIR (local) in the env file.");
  const { LocalFsStorageAdapter } = await import("@chris/media");
  return new LocalFsStorageAdapter({ baseDir: dir });
}

if (/film-worker\.(m?js|ts)$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    log("crashed", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    process.exit(1);
  });
}
