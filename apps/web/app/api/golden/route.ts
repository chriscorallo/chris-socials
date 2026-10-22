import { NextResponse } from "next/server";
import { prisma, readStoredFullEdit, isHandEditReason } from "@chris/domain";
import { exportGoldenFixture } from "@chris/worker/style-cut-job";
import { auth } from "../../../auth";
import { storage } from "../../../lib/storage";

/**
 * The golden-set harness's export (docs/PREMIUM_EDITOR_HANDOFF.md §3.1): one take frozen as data
 * (words, silences, envelope, subject track, brief, reference profile, the Editor's stored plan,
 * the machine cut and Chris's hand edit) for `pnpm golden:pull`. Read-only. Signed-in only.
 */
export const maxDuration = 120;

/** GET: the recent videos with what the golden set wants to know (one take, Editor plan, hand edit). */
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const items = await prisma.contentItem.findMany({
    orderBy: { createdAt: "desc" },
    take: 400,
    select: {
      id: true,
      title: true,
      createdAt: true,
      editPlans: { orderBy: { createdAt: "desc" }, take: 40, select: { plan: true, revisionReason: true } },
      mediaAssets: { where: { kind: "RAW_TAKE", removedAt: null }, select: { durationSeconds: true, transcriptWords: true } },
    },
  });
  return NextResponse.json({
    items: items
      .filter((i) => i.mediaAssets.length > 0)
      .map((i) => ({
        id: i.id,
        title: i.title,
        createdAt: i.createdAt,
        takes: i.mediaAssets.length,
        durationS: i.mediaAssets[0]?.durationSeconds ?? null,
        words: Array.isArray(i.mediaAssets[0]?.transcriptWords) ? (i.mediaAssets[0]!.transcriptWords as unknown[]).length : 0,
        editorPlan: i.editPlans.some((p) => !!readStoredFullEdit(p.plan)?.choices?.editorPlan),
        handEdit: i.editPlans.some((p) => isHandEditReason(p.revisionReason)),
      })),
  });
}

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
