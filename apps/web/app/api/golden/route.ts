import { NextResponse } from "next/server";
import { prisma } from "@chris/domain";
import { exportGoldenFixture } from "@chris/worker/style-cut-job";
import { auth } from "../../../auth";
import { storage } from "../../../lib/storage";

/**
 * The golden-set harness's export (docs/PREMIUM_EDITOR_HANDOFF.md §3.1): one take frozen as data
 * (words, silences, envelope, subject track, brief, reference profile, the Editor's stored plan,
 * the machine cut and Chris's hand edit) for `pnpm golden:pull`. Read-only. Signed-in only.
 */
export const maxDuration = 120;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { contentItemId?: unknown; slug?: unknown; machinePlanId?: unknown; handEditPlanId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof body.contentItemId !== "string" || typeof body.slug !== "string") return NextResponse.json({ error: "bad request" }, { status: 400 });
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  // An id, or words from the video's title ("car payment") — the most recent match wins.
  const item =
    (await prisma.contentItem.findUnique({ where: { id: body.contentItemId }, select: { id: true } })) ??
    (await prisma.contentItem.findFirst({
      where: { title: { contains: body.contentItemId, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }));
  if (!item) return NextResponse.json({ error: `No video with id or title matching "${body.contentItemId}".` }, { status: 404 });
  try {
    const fixture = await exportGoldenFixture(prisma, storage, item.id, {
      slug: body.slug,
      machinePlanId: str(body.machinePlanId),
      handEditPlanId: str(body.handEditPlanId),
    });
    return NextResponse.json(fixture);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 422 });
  }
}
