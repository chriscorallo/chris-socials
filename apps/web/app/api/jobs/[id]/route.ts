import { NextResponse } from "next/server";
import { prisma, getHeavyJob } from "@chris/domain";
import { auth } from "../../../../auth";
import { reconcileHeavyJob } from "../../../../lib/heavy-jobs";
import { plainJobError, progressLine } from "../../../../lib/heavy-job-text";

/**
 * Polled by the phone while a heavy job runs (lib/use-job-progress.ts). Signed-in only.
 * Returns the JobRun's status, live progress ("Rendering your video… 40%") and, when finished,
 * its result. Each poll also does the dispatcher's bookkeeping (reconcileHeavyJob): a job whose
 * sandbox died is marked FAILED, a finished job's sandbox is stopped.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const found = await getHeavyJob(prisma, id);
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const view = await reconcileHeavyJob(found);
  const s = view.summary;
  const pct = view.status === "SUCCEEDED" ? 100 : (s?.progress?.pct ?? 0);
  const result = (s?.result ?? null) as { errorName?: string; gateError?: { name?: string } } | null;
  return NextResponse.json(
    {
      id: view.id,
      kind: s?.jobKind ?? null,
      contentItemId: s?.contentItemId ?? null,
      // QUEUED (waiting for a free cloud worker) reads as RUNNING to clients; `queued` says which.
      status: view.status === "QUEUED" ? "RUNNING" : view.status,
      queued: view.status === "QUEUED",
      pct,
      stage: s?.progress?.stage ?? null,
      message: s?.progress?.message ?? null,
      line: view.status === "RUNNING" || view.status === "QUEUED" ? progressLine(s?.jobKind, s?.progress?.message, pct) : (s?.progress?.message ?? null),
      result: view.status === "RUNNING" || view.status === "QUEUED" ? null : (s?.result ?? null),
      error: view.status === "FAILED" ? plainJobError(view.error, result?.errorName ?? result?.gateError?.name ?? null) : null,
      startedAt: view.startedAt.toISOString(),
      finishedAt: view.finishedAt?.toISOString() ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
