import type { Viewport } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma, getLatestEditPlan, parseTranscriptWords, parseSubjectTrackRecord, FINISHING_EDIT_STATES } from "@chris/domain";
import { requireSession } from "../../../../lib/session";
import { toDatetimeLocal } from "../../../../lib/calendar-week";
import { storageMode } from "../../../../lib/storage";
import { TAKE_COLORS, type EditorAsset, type EditorMusicAsset } from "../../../../lib/editor/types";
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
              ? "This video doesn't have an edit yet. Once the AI has planned the edit, you can open it here and finish it off."
              : `This video can't be edited right now — it's ${item.currentState.toLowerCase().replace(/_/g, " ")}. Editing is available after the edit is planned and before it publishes.`}
          </p>
          <Link href={`/content/${id}`} className="btn btn-ghost">
            ← Back to the video
          </Link>
        </div>
      </main>
    );
  }

  const [takeSelection, rawAssets, musicRows] = await Promise.all([
    prisma.takeSelection.findUnique({ where: { id: plan.takeSelectionId }, select: { selectedMediaAssetId: true } }),
    prisma.mediaAsset.findMany({ where: { contentItemId: id, kind: "RAW_TAKE" }, orderBy: { createdAt: "asc" } }),
    prisma.mediaAsset.findMany({ where: { contentItemId: id, kind: "MUSIC" }, orderBy: { createdAt: "desc" } }),
  ]);

  const assets: EditorAsset[] = rawAssets.map((a, i) => ({
    id: a.id,
    name: a.originalFilename.replace(/\.[^.]+$/, ""),
    url: `/api/media/${a.storageKey}`,
    duration: a.durationSeconds ?? 0,
    width: a.width,
    height: a.height,
    words: parseTranscriptWords(a.transcriptWords),
    transcript: a.transcript,
    color: TAKE_COLORS[i % TAKE_COLORS.length]!,
    // Where Chris is in the frame (motion-graphics placement) — null until the take is tracked.
    subjectTrack: parseSubjectTrackRecord(a.subjectTrack),
  }));
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
      schedule={{
        date: toDatetimeLocal(entry?.scheduledDate ?? tomorrow),
        platforms: entry ? ((entry.targetPlatforms as string[]) ?? []) : ["INSTAGRAM", "TIKTOK", "YOUTUBE"],
        isScheduled: !!entry,
      }}
    />
  );
}
