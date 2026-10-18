import type { Viewport } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma, getLatestEditPlan, FINISHING_EDIT_STATES, canStartEdit, friendlyStateLabel, readStoredStyleCut, readStoredFullEdit, getAutoEditMode } from "@chris/domain";
import { FullEditReportSchema } from "@chris/media/timeline";
import { startEditing } from "../flow-actions";
import { requireSession } from "../../../../lib/session";
import { toDatetimeLocal } from "../../../../lib/calendar-week";
import { storageMode } from "../../../../lib/storage";
import { type EditorMusicAsset } from "../../../../lib/editor/types";
import { editorAssetsFrom } from "../../../../lib/editor/editor-assets";
import { initialEditorDoc } from "./lib/initial-timeline";
import { Editor } from "./Editor";

// "Finish & schedule" renders (ffmpeg) and runs the AI quality check synchronously from this
// page's Server Actions — allow up to the Vercel Fluid Compute ceiling.
export const maxDuration = 300;

// The editor is a full-screen touch app on phones: draw under the notch/home indicator (the
// shell pads itself with env(safe-area-inset-*)), and don't let a pinch zoom the PAGE — pinches
// zoom the timeline / reframe the clip / resize text instead.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#070708",
  colorScheme: "dark",
};

export default async function EditPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const item = await prisma.contentItem.findUnique({
    where: { id },
    select: { id: true, title: true, currentState: true, scheduleEntry: true },
  });
  if (!item) notFound();

  const plan = await getLatestEditPlan(prisma, id);
  const editable = FINISHING_EDIT_STATES.has(item.currentState);
  if (!plan || !editable) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="panel max-w-md p-8 text-center">
          <p className="eyebrow mb-2">Editor</p>
          <h1 className="mb-2 text-xl font-semibold">{item.title}</h1>
          <p className="mb-5 text-sm text-[var(--color-text-muted)]">
            {!plan
              ? canStartEdit(item.currentState)
                ? "Your footage is in — tap below to open it in the editor."
                : "Upload the footage first — then the editor opens."
              : `This video can't be edited right now — it's ${friendlyStateLabel(item.currentState).toLowerCase()}. Editing is available once the footage is in and until it's posted.`}
          </p>
          {/* Links into the editor always work: a video with footage but no edit yet gets the
              no-AI starter edit first (docs/decisions-pending/flow.md). */}
          {!plan && canStartEdit(item.currentState) && (
            <form action={startEditing} className="mb-3">
              <input type="hidden" name="contentItemId" value={id} />
              <button type="submit" className="btn btn-primary w-full">Edit video</button>
            </form>
          )}
          <Link href={`/content/${id}`} className="btn btn-ghost">
            ← Back to the video
          </Link>
        </div>
      </main>
    );
  }

  const [takeSelection, rawAssets, musicRows] = await Promise.all([
    prisma.takeSelection.findUnique({ where: { id: plan.takeSelectionId }, select: { selectedMediaAssetId: true } }),
    prisma.mediaAsset.findMany({
      where: { contentItemId: id, kind: "RAW_TAKE" },
      orderBy: { createdAt: "asc" },
      include: { recordingSegment: { select: { segmentIndex: true, recordingSessionId: true } } },
    }),
    prisma.mediaAsset.findMany({ where: { contentItemId: id, kind: "MUSIC" }, orderBy: { createdAt: "desc" } }),
  ]);

  // Parts of a teleprompter recording are listed in recording order as "Part 1, Part 2…"
  // (docs/decisions-pending/segmented-recording-drafts.md); other takes keep their file name.
  const partNo = new Map<string, number>();
  for (const sid of new Set(rawAssets.map((a) => a.recordingSegment?.recordingSessionId).filter(Boolean))) {
    const slots = rawAssets.flatMap((a, k) => (a.recordingSegment?.recordingSessionId === sid ? [k] : []));
    const ordered = slots.map((k) => rawAssets[k]!).sort((x, y) => x.recordingSegment!.segmentIndex - y.recordingSegment!.segmentIndex);
    ordered.forEach((a, k) => {
      rawAssets[slots[k]!] = a;
      partNo.set(a.id, k + 1);
    });
  }
  // Plays the 720p preview proxy when one exists (renders always use the original).
  const assets = editorAssetsFrom(rawAssets).map((asset) => (partNo.has(asset.id) ? { ...asset, name: `Part ${partNo.get(asset.id)}` } : asset));
  const music: EditorMusicAsset[] = musicRows.map((m) => ({
    id: m.id,
    name: m.originalFilename.replace(/\.[^.]+$/, ""),
    url: `/api/media/${m.storageKey}`,
    duration: m.durationSeconds ?? 0,
  }));

  const selectedId = takeSelection?.selectedMediaAssetId ?? assets[0]?.id ?? "";
  const selected = assets.find((a) => a.id === selectedId);
  const initialDoc = initialEditorDoc(plan.plan, {
    id: selectedId,
    duration: selected?.duration ?? 0,
    hasWords: !!selected?.words?.length,
    width: selected?.width ?? null,
    height: selected?.height ?? null,
  });

  const storedStyleCut = readStoredStyleCut(plan.plan);
  const storedFullEdit = readStoredFullEdit(plan.plan);
  const fullEditReport = storedFullEdit && storedFullEdit.mediaAssetId === selectedId ? FullEditReportSchema.safeParse(storedFullEdit.report) : null;
  const autoEditMode = await getAutoEditMode(prisma).catch(() => "FULL" as const);
  const entry = item.scheduleEntry;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);

  return (
    <Editor
      item={{ id: item.id, title: item.title, state: item.currentState }}
      planId={plan.id}
      initialDoc={initialDoc}
      assets={assets}
      music={music}
      storageMode={storageMode}
      styleCut={{
        hasWords: !!selected?.words?.length,
        active: !!storedStyleCut && storedStyleCut.mediaAssetId === selectedId && !/Finishing edit by Chris(?!: Style cut)/.test(plan.revisionReason ?? ""),
        summary: storedStyleCut?.summary ?? null,
        profileNote: storedStyleCut?.profileNote ?? null,
        fullEdit: fullEditReport?.success ? fullEditReport.data : null,
        fullEditActive: !!fullEditReport?.success && !/Finishing edit by Chris(?!: Full edit)/.test(plan.revisionReason ?? ""),
        autoMode: autoEditMode,
      }}
      schedule={{
        date: toDatetimeLocal(entry?.scheduledDate ?? tomorrow),
        platforms: entry ? ((entry.targetPlatforms as string[]) ?? []) : ["INSTAGRAM", "TIKTOK", "YOUTUBE"],
        isScheduled: !!entry,
      }}
    />
  );
}
