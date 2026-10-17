/**
 * The cloud worker's entry point — runs ONE heavy job and exits. Built into a single ESM file
 * (scripts/sandbox/build-runner.ts → job-runner.mjs) and baked into the Vercel Sandbox snapshot
 * (scripts/sandbox/create-snapshot.ts); the web app starts it in a fresh sandbox per job
 * (apps/web/lib/heavy-jobs.ts). Also runnable locally under tsx.
 *
 *   node job-runner.mjs <kind> <jsonArgs | @args.json> --job-run-id <id> [--env-file <env.json>] [--poweroff]
 *       Real database (DATABASE_URL) + real storage (BLOB_READ_WRITE_TOKEN → private Vercel
 *       Blob, else STORAGE_LOCAL_DIR). Progress and the result go on the JobRun row (which the
 *       web app already claimed — it is the per-item lease). Exit 0 = recorded (even a job
 *       that failed for an expected reason); exit 1 = the runner itself crashed.
 *
 *   node job-runner.mjs <render|transcribe|subject-track|person-matte> --offline <job.json>
 *       No database, no storage: inputs are files named by job.json, the result is written to
 *       files next to it (see offline.ts). Used to verify a snapshot end to end.
 *
 *   node job-runner.mjs warmup
 *       Downloads Remotion's headless Chrome, the Whisper and MODNet models into their cache
 *       dirs (snapshot build time), then loads each runtime once.
 *
 * Secrets never go on the command line: `--env-file` names a JSON object written by the
 * dispatcher with mode 0600; it is read into process.env and deleted before any job code
 * loads. Every module that reads env at import time (@chris/domain's Prisma client) is
 * therefore imported dynamically, after that.
 */
import { readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";

interface Cli {
  kind: string;
  args: unknown;
  jobRunId: string | null;
  envFile: string | null;
  offline: string | null;
  poweroff: boolean;
}

export function parseCli(argv: string[]): Cli {
  const out: Cli = { kind: "", args: null, jobRunId: null, envFile: null, offline: null, poweroff: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--job-run-id") out.jobRunId = argv[++i] ?? null;
    else if (a === "--env-file") out.envFile = argv[++i] ?? null;
    else if (a === "--offline") out.offline = argv[++i] ?? null;
    else if (a === "--poweroff") out.poweroff = true;
    else rest.push(a);
  }
  out.kind = rest[0] ?? "";
  const rawArgs = rest[1];
  if (rawArgs != null) out.args = JSON.parse(rawArgs.startsWith("@") ? readFileSync(rawArgs.slice(1), "utf8") : rawArgs);
  return out;
}

/** Loads a JSON env file into process.env (string values only) and deletes it. */
export function loadEnvFile(path: string): string[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  rmSync(path, { force: true });
  const keys: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string" && /^[A-Z_][A-Z0-9_]*$/.test(k)) {
      process.env[k] = v;
      keys.push(k);
    }
  }
  return keys;
}

/** Set once the database is reachable: records a crash on the claimed JobRun. */
let recordCrash: ((message: string) => Promise<unknown>) | null = null;

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
}

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.envFile) log("env_loaded", { keys: loadEnvFile(cli.envFile) });

  // The motion engine, as a literal import so the bundler includes it (render-job.ts loads it
  // through a non-literal specifier on purpose, for the web app's sake).
  (globalThis as { __chrisMotionLoader?: () => Promise<unknown> }).__chrisMotionLoader = async () => import("@chris/motion");

  if (cli.kind === "warmup") {
    const { warmup } = await import("./offline");
    log("warmup_done", await warmup());
    return 0;
  }
  if (cli.offline) {
    const { runOffline } = await import("./offline");
    const started = Date.now();
    const result = await runOffline(cli.kind, cli.offline, (p) => log("progress", p as unknown as Record<string, unknown>));
    log("offline_done", { kind: cli.kind, ms: Date.now() - started, result });
    return 0;
  }

  const { isHeavyJobKind } = await import("./heavy-job-kinds");
  if (!isHeavyJobKind(cli.kind)) throw new Error(`unknown job kind "${cli.kind}"`);
  if (!cli.jobRunId) throw new Error("--job-run-id is required (the dispatcher claims the JobRun first)");

  const { prisma, getHeavyJob, finishHeavyJob } = await import("@chris/domain");
  const { runHeavyJobRecorded } = await import("./heavy-jobs");
  const jobRunId = cli.jobRunId;
  recordCrash = (message) => finishHeavyJob(prisma, jobRunId, { status: "FAILED", error: `The cloud worker crashed: ${message}` });

  // A timeout/kill: record why, so the phone doesn't spin forever.
  const onSignal = (sig: string) => {
    log("signal", { sig });
    void finishHeavyJob(prisma, jobRunId, { status: "FAILED", error: `The cloud worker was stopped (${sig}) — most likely it ran out of time.` })
      .catch(() => undefined)
      .finally(() => process.exit(1));
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));

  const job = await getHeavyJob(prisma, jobRunId);
  if (!job || job.status !== "RUNNING") throw new Error(`JobRun ${jobRunId} is not a RUNNING heavy job`);
  const actorId = job.summary?.actorId ?? "cloud-worker";

  const storage = await createStorage();
  const modelProvider = await createModelProviderFactory(prisma);
  const started = Date.now();
  log("job_start", { kind: cli.kind, jobRunId });
  const outcome = await runHeavyJobRecorded(jobRunId, cli.kind, cli.args, {
    db: prisma,
    storage,
    actor: { actorId },
    modelProvider,
    progress: (p) => log("progress", p as unknown as Record<string, unknown>),
  });
  log("job_done", { ok: outcome.ok, ms: Date.now() - started, error: outcome.error ?? null });
  await prisma.$disconnect().catch(() => undefined);
  return 0;
}

async function createStorage() {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { VercelBlobStorageAdapter } = await import("./blob-storage");
    return new VercelBlobStorageAdapter();
  }
  const dir = process.env.STORAGE_LOCAL_DIR;
  if (!dir) throw new Error("No storage configured: set BLOB_READ_WRITE_TOKEN (cloud) or STORAGE_LOCAL_DIR (local).");
  const { LocalFsStorageAdapter } = await import("@chris/media");
  return new LocalFsStorageAdapter({ baseDir: dir });
}

/** Same real provider the web app uses (lib/model-provider.ts): Anthropic, wrapped in the
 * cost tracker so every call is logged and refused past the daily spend cap. */
async function createModelProviderFactory(prisma: import("@chris/domain").PrismaClient) {
  const { AnthropicModelProvider, CostTrackingModelProvider, DEFAULT_DAILY_SPEND_CAP_USD } = await import("@chris/agents");
  const raw = process.env.MODEL_SPEND_DAILY_CAP_USD;
  const cap = raw == null || raw === "" ? DEFAULT_DAILY_SPEND_CAP_USD : Number(raw);
  if (!Number.isFinite(cap) || cap < 0) throw new Error(`MODEL_SPEND_DAILY_CAP_USD is not a valid non-negative number`);
  let instance: import("@chris/agents").ModelProvider | null = null;
  return () => (instance ??= new CostTrackingModelProvider(new AnthropicModelProvider(), prisma, { dailyCapUsd: cap }));
}

/** Ends the microVM as soon as the job is recorded (the dispatcher's timeout is only the
 * safety net). Best effort: the web app also stops the sandbox when it sees the job finish. */
function powerOff(): void {
  try {
    spawn("sudo", ["-n", "poweroff"], { stdio: "ignore", detached: true }).unref();
  } catch {
    // ignore
  }
}

const isMain = (() => {
  const entry = process.argv[1] ?? "";
  return /job-runner\.(m?js|ts)$/.test(entry);
})();

if (isMain) {
  const poweroff = process.argv.includes("--poweroff");
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(async (err) => {
      log("runner_crashed", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
      process.exitCode = 1;
      await recordCrash?.(err instanceof Error ? err.message : String(err)).catch(() => undefined);
    })
    .finally(() => {
      if (poweroff) setTimeout(powerOff, 500);
      // Don't let a stray handle (an idle pg pool, a browser) keep the VM alive.
      setTimeout(() => process.exit(process.exitCode ?? 0), poweroff ? 2_000 : 200).unref();
    });
}
