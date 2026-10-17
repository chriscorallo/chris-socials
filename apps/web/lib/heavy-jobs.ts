import {
  prisma,
  acquireHeavyJobLease,
  finishHeavyJob,
  patchHeavyJobSummary,
  getHeavyJob,
  claimQueuedHeavyJob,
  type HeavyJobView,
} from "@chris/domain";
import { runHeavyJobRecorded, type HeavyJobOutcome } from "@chris/worker/heavy-jobs";
import { heavyJobNeedsModel, heavyJobSubject, isHeavyJobKind, parseHeavyJobArgs, type HeavyJobArgsByKind, type HeavyJobKind } from "@chris/worker/heavy-job-kinds";
import { storage } from "./storage";
import { getModelProvider } from "./model-provider";
import { cloudWorkerConfigured, getRenderFontPath, heavyJobMode } from "./render-config";
import { HEAVY_JOB_TITLE } from "./heavy-job-text";

/**
 * SERVER-ONLY. One entry point for every heavy job the app starts (render, quality gate,
 * auto-repair, transcription, face tracking, person matte, upload analysis, AI visuals):
 *
 * - inline (local `next dev`): runs in this process exactly as before and returns the outcome;
 * - sandbox (Vercel): claims the item's lease, boots a Vercel Sandbox from the cloud worker's
 *   snapshot (RENDER_SANDBOX_SNAPSHOT_ID), starts `run-job.sh` DETACHED and returns at once —
 *   the phone polls GET /api/jobs/<id>. The worker records progress/result on the JobRun and
 *   powers the VM off when done; the sandbox's own timeout is the safety net, and the poll
 *   endpoint stops a sandbox that outlived its job.
 *
 * Always one heavy job per content item (JobRun lease) and at most HEAVY_JOB_MAX_SANDBOXES
 * sandboxes at once. Nothing is half-written on a launch failure: the JobRun is marked FAILED
 * with the reason and the sandbox (if any) is stopped. See docs/decisions-pending/cloud-renderer.md.
 */

export type RunHeavyJobResult =
  /** Ran in-process and finished. */
  | { status: "done"; jobRunId: string; outcome: HeavyJobOutcome }
  /** Started in the cloud; poll /api/jobs/<jobRunId>. */
  | { status: "started"; jobRunId: string }
  /** Another heavy job is already running for this video (attach to it instead). */
  | { status: "busy"; jobRunId: string; jobKind: string | null; message: string }
  /** Couldn't start (not configured, at capacity, sandbox creation failed). */
  | { status: "refused"; jobRunId: string | null; message: string };

/** The slice of the Sandbox SDK the dispatcher uses (tests inject a fake). */
export interface SandboxLauncher {
  launch(input: {
    jobRunId: string;
    kind: HeavyJobKind;
    args: unknown;
    env: Record<string, string>;
    snapshotId: string;
    vcpus: number;
    timeoutMs: number;
    contentItemId: string;
  }): Promise<{ sandboxName: string }>;
  /** null = the sandbox no longer exists. */
  status(sandboxName: string): Promise<string | null>;
  stop(sandboxName: string): Promise<void>;
}

const RUNNER = "/vercel/sandbox/runner/bin/run-job.sh";

export function sandboxConfig() {
  const num = (v: string | undefined, d: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, Math.round(n))) : d;
  };
  const vcpus = num(process.env.RENDER_SANDBOX_VCPUS, 8, 1, 32);
  return {
    snapshotId: process.env.RENDER_SANDBOX_SNAPSHOT_ID ?? "",
    // 1 or an even number (Vercel Sandbox rule).
    vcpus: vcpus === 1 ? 1 : vcpus - (vcpus % 2),
    timeoutMs: num(process.env.RENDER_SANDBOX_TIMEOUT_MS, 45 * 60_000, 60_000, 5 * 60 * 60_000),
    // Default 4: a batch upload of a few clips gets its captions in parallel; more queue.
    maxSandboxes: num(process.env.HEAVY_JOB_MAX_SANDBOXES, 4, 1, 100),
  };
}

/** Explicit credentials when given (local testing of sandbox mode); on Vercel the SDK uses OIDC. */
function sandboxCredentials(): Record<string, string> {
  const { VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID } = process.env;
  return VERCEL_TOKEN && VERCEL_TEAM_ID && VERCEL_PROJECT_ID ? { token: VERCEL_TOKEN, teamId: VERCEL_TEAM_ID, projectId: VERCEL_PROJECT_ID } : {};
}

/** Credentials the worker uses only to stop its own sandbox. Empty → it can't; the poll
 * endpoint and the sandbox timeout still stop it. */
async function selfStopCredentials(): Promise<Record<string, string>> {
  const explicit = sandboxCredentials();
  if (explicit.token) return { VERCEL_TOKEN: explicit.token, VERCEL_TEAM_ID: explicit.teamId!, VERCEL_PROJECT_ID: explicit.projectId! };
  try {
    const { getVercelOidcToken } = await import("@vercel/oidc");
    const token = await getVercelOidcToken();
    return token ? { VERCEL_OIDC_TOKEN: token } : {};
  } catch {
    return {};
  }
}

export const vercelSandboxLauncher: SandboxLauncher = {
  async launch(input) {
    const { Sandbox } = await import("@vercel/sandbox");
    const name = `heavy-${input.jobRunId}`;
    const sandbox = await Sandbox.create({
      ...sandboxCredentials(),
      name,
      source: { type: "snapshot", snapshotId: input.snapshotId },
      resources: { vcpus: input.vcpus },
      timeout: input.timeoutMs,
      persistent: false,
      tags: { job: input.kind, item: input.contentItemId.slice(0, 60) },
    });
    try {
      const dir = `/vercel/sandbox/jobs/${input.jobRunId}`;
      // Self-stop: a VM that powers itself off still counts as "running" to Vercel until its
      // timeout (measured), so the worker stops its sandbox through the API when it's done —
      // with this project's short-lived OIDC token (or the explicit operator credentials).
      const selfStop = await selfStopCredentials();
      // Secrets travel as a 0600 file the runner deletes on read — never on the command line.
      await sandbox.writeFiles([
        { path: `${dir}/env.json`, content: Buffer.from(JSON.stringify({ ...input.env, ...selfStop, SANDBOX_SELF_NAME: name, SANDBOX_DEADLINE_MS: String(Date.now() + input.timeoutMs) })), mode: 0o600 },
        { path: `${dir}/args.json`, content: Buffer.from(JSON.stringify(input.args)) },
      ]);
      await sandbox.runCommand({
        cmd: "bash",
        args: [RUNNER, input.kind, `@${dir}/args.json`, "--job-run-id", input.jobRunId, "--env-file", `${dir}/env.json`, "--stop-self"],
        detached: true,
      });
    } catch (err) {
      await sandbox.stop().catch(() => undefined);
      throw err;
    }
    return { sandboxName: name };
  },
  async status(name) {
    const { Sandbox } = await import("@vercel/sandbox");
    try {
      const sb = await Sandbox.get({ ...sandboxCredentials(), name });
      return sb.status ?? null;
    } catch (err) {
      if (/not.?found|404/i.test(err instanceof Error ? err.message : String(err))) return null;
      throw err;
    }
  },
  async stop(name) {
    const { Sandbox } = await import("@vercel/sandbox");
    const sb = await Sandbox.get({ ...sandboxCredentials(), name });
    await sb.stop();
  },
};

let launcher: SandboxLauncher = vercelSandboxLauncher;
/** Tests only. */
export function setSandboxLauncherForTests(l: SandboxLauncher | null) {
  launcher = l ?? vercelSandboxLauncher;
}

/** Only what the worker needs — never the whole server env. */
export function workerEnv(kind: HeavyJobKind, args: unknown): Record<string, string> {
  const pick = ["DATABASE_URL", "BLOB_READ_WRITE_TOKEN", "APP_TIMEZONE", "MODEL_SPEND_DAILY_CAP_USD", "TRANSCRIPTION_MODEL", "MODEL_REFUSAL_FALLBACK", "RESEARCH_WEB_SEARCH", "MODEL_HIGH", "MODEL_MEDIUM", "MODEL_LOW"];
  if (heavyJobNeedsModel(kind, args)) pick.push("ANTHROPIC_API_KEY");
  const env: Record<string, string> = {};
  for (const k of pick) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  env.TZ = process.env.APP_TIMEZONE || "America/Los_Angeles";
  return env;
}

function busyMessage(jobKind: string | null): string {
  return `${HEAVY_JOB_TITLE[jobKind ?? ""] ?? "Something else is running"} for this video right now — it'll be ready in a bit. You can follow its progress here.`;
}

export async function runHeavyJob<K extends HeavyJobKind>(
  kind: K,
  rawArgs: HeavyJobArgsByKind[K],
  /** `background`: in inline (local) mode, start the job in this process and return `started`
   * at once, so the page polls progress exactly like the cloud path (long jobs such as measuring
   * 20 reference videos). No effect in sandbox mode. */
  options: { actorId: string; background?: boolean },
): Promise<RunHeavyJobResult> {
  const args = parseHeavyJobArgs(kind, rawArgs);
  const mode = heavyJobMode();
  const cfg = sandboxConfig();
  if (mode === "sandbox" && !cloudWorkerConfigured()) {
    return {
      status: "refused",
      jobRunId: null,
      message: "The cloud renderer isn't set up yet, so this can't run on the live site (RENDER_SANDBOX_SNAPSHOT_ID is missing). Nothing was changed.",
    };
  }
  const lease = await acquireHeavyJobLease(prisma, {
    // The lease subject: the video for per-video jobs, the reference library for reference analysis.
    contentItemId: heavyJobSubject(kind, args),
    jobKind: kind,
    args,
    mode,
    actorId: options.actorId,
    maxConcurrentSandboxes: cfg.maxSandboxes,
    // A sandbox can't outlive its timeout; a little margin for the last DB write.
    staleAfterMs: mode === "sandbox" ? cfg.timeoutMs + 5 * 60_000 : undefined,
    // At the sandbox cap the job waits its turn instead of being refused (a batch upload of
    // many clips): a finishing worker picks it up in its own VM, or the next poll starts it.
    queueIfFull: mode === "sandbox",
  });
  if (!lease.acquired) {
    if (lease.reason === "BUSY") return { status: "busy", jobRunId: lease.activeJobRunId, jobKind: lease.activeJobKind, message: busyMessage(lease.activeJobKind) };
    if (lease.reason === "QUEUED") {
      // Capacity may have freed between the claim and now — try to start the queue right away.
      await kickQueuedHeavyJobs().catch(() => undefined);
      return { status: "started", jobRunId: lease.jobRunId };
    }
    return {
      status: "refused",
      jobRunId: null,
      message: `${lease.running} videos are already being processed in the cloud (the limit is ${lease.limit}). Try again in a few minutes — nothing was changed.`,
    };
  }
  const jobRunId = lease.jobRunId;

  if (mode === "inline") {
    const run = runHeavyJobRecorded(jobRunId, kind, args, {
      db: prisma,
      storage,
      actor: { actorId: options.actorId },
      modelProvider: getModelProvider,
      fontPath: getRenderFontPath(),
    });
    // runHeavyJobRecorded never throws; it records its outcome on the JobRun the page polls.
    if (options.background) return { status: "started", jobRunId };
    return { status: "done", jobRunId, outcome: await run };
  }

  const launched = await launchClaimed(jobRunId, kind, args);
  if (launched.ok) return { status: "started", jobRunId };
  return { status: "refused", jobRunId, message: `Couldn't start the cloud worker (${launched.reason.slice(0, 200)}). Nothing was changed — try again in a minute.` };
}

/** Boots a sandbox for an already-claimed (RUNNING) job; on failure the job is FAILED with the reason. */
async function launchClaimed(jobRunId: string, kind: HeavyJobKind, args: HeavyJobArgsByKind[HeavyJobKind]): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cfg = sandboxConfig();
  try {
    const { sandboxName } = await launcher.launch({
      jobRunId,
      kind,
      args,
      env: workerEnv(kind, args),
      snapshotId: cfg.snapshotId,
      vcpus: cfg.vcpus,
      timeoutMs: cfg.timeoutMs,
      contentItemId: heavyJobSubject(kind, args),
    });
    await patchHeavyJobSummary(prisma, jobRunId, { sandboxName });
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: "error", event: "sandbox_launch_failed", jobRunId, kind, message: reason }));
    await finishHeavyJob(prisma, jobRunId, { status: "FAILED", error: `Couldn't start the cloud worker: ${reason}`, message: "Couldn't start the cloud worker." });
    return { ok: false, reason };
  }
}

/**
 * Starts QUEUED heavy jobs while there's sandbox capacity (oldest first). Called whenever a
 * job is polled/queued, so the queue moves even if no worker drains it. Never throws.
 */
export async function kickQueuedHeavyJobs(max = 4): Promise<number> {
  if (heavyJobMode() !== "sandbox" || !cloudWorkerConfigured()) return 0;
  const cfg = sandboxConfig();
  let started = 0;
  for (let i = 0; i < max; i++) {
    const claimed = await claimQueuedHeavyJob(prisma, { maxConcurrentSandboxes: cfg.maxSandboxes, staleAfterMs: cfg.timeoutMs + 5 * 60_000 }).catch(() => null);
    if (!claimed) break;
    let args: HeavyJobArgsByKind[HeavyJobKind];
    try {
      if (!isHeavyJobKind(claimed.jobKind)) throw new Error(`unknown job kind ${claimed.jobKind}`);
      args = parseHeavyJobArgs(claimed.jobKind, claimed.args);
    } catch (err) {
      await finishHeavyJob(prisma, claimed.jobRunId, { status: "FAILED", error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if ((await launchClaimed(claimed.jobRunId, claimed.jobKind as HeavyJobKind, args)).ok) started++;
  }
  return started;
}

/** How long a sandbox job may go without a progress write before we ask Vercel if it's alive. */
const SILENT_CHECK_MS = 60_000;
/** A sandbox job that never recorded a sandbox name this long after the claim never launched. */
const LAUNCH_GRACE_MS = 3 * 60_000;

/**
 * Bookkeeping on poll (GET /api/jobs/[id]), so nothing depends on the worker being perfect:
 * - RUNNING but its sandbox is gone/stopped → FAILED ("stopped before finishing");
 * - finished but its sandbox may still be up → stop it (once).
 * Best effort; never throws. Returns the (possibly updated) view.
 */
export async function reconcileHeavyJob(view: HeavyJobView, now = new Date()): Promise<HeavyJobView> {
  const s = view.summary;
  if (!s || s.mode !== "sandbox") return view;
  if (view.status !== "RUNNING") {
    // A queued job, or a finished one that may have freed a slot: move the queue.
    await kickQueuedHeavyJobs().catch(() => undefined);
    if (view.status === "QUEUED") return (await getHeavyJob(prisma, view.id)) ?? view;
  }
  try {
    if (view.status === "RUNNING") {
      if (!s.sandboxName) {
        if (now.getTime() - view.startedAt.getTime() > LAUNCH_GRACE_MS) {
          await finishHeavyJob(prisma, view.id, { status: "FAILED", error: "The cloud worker never started." });
          return (await getHeavyJob(prisma, view.id)) ?? view;
        }
        return view;
      }
      const last = Date.parse(s.progress?.updatedAt ?? "") || view.startedAt.getTime();
      if (now.getTime() - last < SILENT_CHECK_MS) return view;
      const st = await launcher.status(s.sandboxName);
      if (st === null || st === "stopped" || st === "failed" || st === "aborted") {
        await finishHeavyJob(prisma, view.id, { status: "FAILED", error: "The cloud worker stopped before finishing (it may have run out of time or memory)." });
        await patchHeavyJobSummary(prisma, view.id, { sandboxStopped: true });
        return (await getHeavyJob(prisma, view.id)) ?? view;
      }
      return view;
    }
    if (s.sandboxName && !s.sandboxStopped) {
      await patchHeavyJobSummary(prisma, view.id, { sandboxStopped: true });
      const st = await launcher.status(s.sandboxName);
      if (st && st !== "stopped" && st !== "failed" && st !== "aborted") await launcher.stop(s.sandboxName);
    }
  } catch (err) {
    console.error(JSON.stringify({ level: "warn", event: "heavy_job_reconcile_failed", jobRunId: view.id, message: err instanceof Error ? err.message : String(err) }));
  }
  return view;
}

/** Query-string suffix pointing the content page's progress banner at a job. */
export function jobParam(r: RunHeavyJobResult): string {
  return r.jobRunId && (r.status === "started" || r.status === "busy") ? `job=${encodeURIComponent(r.jobRunId)}` : "";
}
