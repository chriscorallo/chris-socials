import {
  prisma,
  acquireHeavyJobLease,
  finishHeavyJob,
  patchHeavyJobSummary,
  getHeavyJob,
  type HeavyJobView,
} from "@chris/domain";
import { runHeavyJobRecorded, type HeavyJobOutcome } from "@chris/worker/heavy-jobs";
import { heavyJobNeedsModel, parseHeavyJobArgs, type HeavyJobArgsByKind, type HeavyJobKind } from "@chris/worker/heavy-job-kinds";
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
    maxSandboxes: num(process.env.HEAVY_JOB_MAX_SANDBOXES, 2, 1, 100),
  };
}

/** Explicit credentials when given (local testing of sandbox mode); on Vercel the SDK uses OIDC. */
function sandboxCredentials(): Record<string, string> {
  const { VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID } = process.env;
  return VERCEL_TOKEN && VERCEL_TEAM_ID && VERCEL_PROJECT_ID ? { token: VERCEL_TOKEN, teamId: VERCEL_TEAM_ID, projectId: VERCEL_PROJECT_ID } : {};
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
      // Secrets travel as a 0600 file the runner deletes on read — never on the command line.
      await sandbox.writeFiles([
        { path: `${dir}/env.json`, content: Buffer.from(JSON.stringify(input.env)), mode: 0o600 },
        { path: `${dir}/args.json`, content: Buffer.from(JSON.stringify(input.args)) },
      ]);
      await sandbox.runCommand({
        cmd: "bash",
        args: [RUNNER, input.kind, `@${dir}/args.json`, "--job-run-id", input.jobRunId, "--env-file", `${dir}/env.json`, "--poweroff"],
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
  const pick = ["DATABASE_URL", "BLOB_READ_WRITE_TOKEN", "APP_TIMEZONE", "MODEL_SPEND_DAILY_CAP_USD", "TRANSCRIPTION_MODEL", "MODEL_REFUSAL_FALLBACK", "RESEARCH_WEB_SEARCH"];
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
  options: { actorId: string },
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
    contentItemId: args.contentItemId,
    jobKind: kind,
    args,
    mode,
    actorId: options.actorId,
    maxConcurrentSandboxes: cfg.maxSandboxes,
    // A sandbox can't outlive its timeout; a little margin for the last DB write.
    staleAfterMs: mode === "sandbox" ? cfg.timeoutMs + 5 * 60_000 : undefined,
  });
  if (!lease.acquired) {
    if (lease.reason === "BUSY") return { status: "busy", jobRunId: lease.activeJobRunId, jobKind: lease.activeJobKind, message: busyMessage(lease.activeJobKind) };
    return {
      status: "refused",
      jobRunId: null,
      message: `${lease.running} videos are already being processed in the cloud (the limit is ${lease.limit}). Try again in a few minutes — nothing was changed.`,
    };
  }
  const jobRunId = lease.jobRunId;

  if (mode === "inline") {
    const outcome = await runHeavyJobRecorded(jobRunId, kind, args, {
      db: prisma,
      storage,
      actor: { actorId: options.actorId },
      modelProvider: getModelProvider,
      fontPath: getRenderFontPath(),
    });
    return { status: "done", jobRunId, outcome };
  }

  try {
    const { sandboxName } = await launcher.launch({
      jobRunId,
      kind,
      args,
      env: workerEnv(kind, args),
      snapshotId: cfg.snapshotId,
      vcpus: cfg.vcpus,
      timeoutMs: cfg.timeoutMs,
      contentItemId: args.contentItemId,
    });
    await patchHeavyJobSummary(prisma, jobRunId, { sandboxName });
    return { status: "started", jobRunId };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: "error", event: "sandbox_launch_failed", jobRunId, kind, message: reason }));
    await finishHeavyJob(prisma, jobRunId, { status: "FAILED", error: `Couldn't start the cloud worker: ${reason}`, message: "Couldn't start the cloud worker." });
    return { status: "refused", jobRunId, message: `Couldn't start the cloud worker (${reason.slice(0, 200)}). Nothing was changed — try again in a minute.` };
  }
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
