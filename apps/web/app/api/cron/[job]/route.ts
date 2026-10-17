import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@chris/domain";
import { publishDueScheduledItems, captureDueSnapshotsForAll } from "@chris/worker/scheduled-jobs";
import { storage, getPublicVideoUrl } from "../../../../lib/storage";
import { getPlatformAdapters } from "../../../../lib/platform-adapters";

export const maxDuration = 300;

/**
 * Background jobs, called by Vercel Cron (vercel.json) and the GitHub Actions tick
 * (.github/workflows/cron-tick.yml). Never session-authenticated — only
 * `Authorization: Bearer $CRON_SECRET` (which Vercel Cron sends automatically when
 * CRON_SECRET is set). Every run writes a JobRun row (observability).
 *
 * - publish-scheduled: publishes SCHEDULED items whose time has come. Gated by the
 *   `publishing.scheduled_auto` feature flag (default OFF — toggle on /settings/connections).
 * - snapshots: metric snapshots in their honest windows, comment ingestion, re-verify, archive.
 * - tick: both, in that order (what the 10-minute GitHub tick calls).
 */
const JOBS = ["publish-scheduled", "snapshots", "tick"] as const;
type Job = (typeof JOBS)[number];

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function run(job: Job) {
  const adapters = getPlatformAdapters();
  const results: Record<string, unknown> = {};
  if (job === "publish-scheduled" || job === "tick") {
    results.publish = await publishDueScheduledItems({ prisma, storage, adapters, getPublicVideoUrl, platformVariants: true });
  }
  if (job === "snapshots" || job === "tick") {
    results.snapshots = await captureDueSnapshotsForAll({ prisma, adapters });
  }
  return results;
}

export async function GET(request: Request, { params }: { params: Promise<{ job: string }> }) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { job } = await params;
  if (!(JOBS as readonly string[]).includes(job)) {
    return NextResponse.json({ error: `Unknown job: ${job}` }, { status: 404 });
  }
  const results = await run(job as Job);
  const failed = Object.values(results).some((r) => (r as { status?: string }).status === "FAILED");
  console.log(JSON.stringify({ level: failed ? "error" : "info", event: "cron", job, results }));
  return NextResponse.json({ job, results }, { status: failed ? 500 : 200 });
}
