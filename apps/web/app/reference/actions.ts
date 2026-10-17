"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma, createReferenceCreator, setReferenceCreatorStyleGroup, moveReferenceVideo, deleteReferenceVideoMedia, setReferenceVideoSourceUrl, isReferenceVideoKey } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { storage } from "../../lib/storage";
import { prepareReferenceCreator, registerReferenceUpload, startReferenceMeasuring } from "../../lib/reference-upload";

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function lines(formData: FormData, key: string): string[] {
  return str(formData, key)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const msg = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

export async function createCreator(formData: FormData) {
  const session = await requireSession();

  const creator = await createReferenceCreator(
    prisma,
    {
      name: str(formData, "name"),
      platforms: lines(formData, "platforms"),
      brandPositioning: str(formData, "brandPositioning"),
      knownAudience: str(formData, "knownAudience") || undefined,
      formats: lines(formData, "formats"),
      hookArchetypes: lines(formData, "hookArchetypes"),
      relevanceToChris: str(formData, "relevanceToChris") || undefined,
      doNotTransfer: str(formData, "doNotTransfer") || undefined,
      sourceProvenance: str(formData, "sourceProvenance") || undefined,
    },
    { actorId: session.user!.id! },
  );

  redirect(`/reference/${creator.id}`);
}

/** Step 1 of an upload batch: the creator the videos go to (existing, or new by name). */
export async function prepareReferenceUpload(input: { referenceCreatorId?: string; name?: string }): Promise<{ referenceCreatorId: string; name: string } | { error: string }> {
  const session = await requireSession();
  try {
    const c = await prepareReferenceCreator(input, session.user!.id!);
    return { referenceCreatorId: c.id, name: c.name };
  } catch (err) {
    return { error: msg(err, "Couldn't set up that creator.") };
  }
}

/** Blob mode: the browser uploaded straight to private Blob; record it (idempotent per key). */
export async function registerReferenceBlobUpload(input: {
  referenceCreatorId: string;
  storageKey: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  sourceUrl?: string;
}): Promise<{ referenceContentId: string } | { error: string }> {
  const session = await requireSession();
  try {
    if (!isReferenceVideoKey(input.storageKey, input.referenceCreatorId)) throw new Error("Storage key does not belong to this creator.");
    const row = await registerReferenceUpload({ ...input, mimeType: input.mimeType || undefined, actorId: session.user!.id! });
    return { referenceContentId: row.id };
  } catch (err) {
    return { error: msg(err, "Upload registration failed") };
  }
}

/** Starts (or follows) measuring every waiting video. Returns the job to follow. */
export async function measureReferenceVideos(options: { retryFailed?: boolean; ids?: string[]; updateOutdated?: boolean } = {}): Promise<{ jobRunId: string | null; message: string } | { error: string }> {
  const session = await requireSession();
  try {
    return await startReferenceMeasuring(session.user!.id!, options);
  } catch (err) {
    return { error: msg(err, "Couldn't start measuring.") };
  }
}

/** Deletes the FILE of a reference video; its numbers stay. */
export async function deleteReferenceVideoFile(formData: FormData) {
  const session = await requireSession();
  const id = str(formData, "referenceContentId");
  const back = str(formData, "back") || "/reference";
  await deleteReferenceVideoMedia(prisma, id, (key) => storage.delete(key), { actorId: session.user!.id! });
  revalidatePath(back);
  redirect(back);
}

export async function setReferenceVideoLink(formData: FormData) {
  const session = await requireSession();
  const id = str(formData, "referenceContentId");
  const back = str(formData, "back") || "/reference";
  try {
    await setReferenceVideoSourceUrl(prisma, id, str(formData, "sourceUrl") || null, { actorId: session.user!.id! });
  } catch (err) {
    redirect(`${back}?linkError=${encodeURIComponent(msg(err, "Couldn't save that link."))}`);
  }
  revalidatePath(back);
  redirect(back);
}

export async function setCreatorStyleGroup(formData: FormData) {
  const session = await requireSession();
  const id = str(formData, "referenceCreatorId");
  const group = str(formData, "group") === "FACELESS" ? "FACELESS" : "MAIN";
  await setReferenceCreatorStyleGroup(prisma, id, group, { actorId: session.user!.id! });
  revalidatePath("/reference");
  revalidatePath(`/reference/${id}`);
  redirect(`/reference/${id}`);
}

export async function moveReferenceVideoAction(formData: FormData) {
  const session = await requireSession();
  const id = str(formData, "referenceContentId");
  const back = str(formData, "back") || "/reference";
  const choice = str(formData, "to");
  const name = str(formData, "newName");
  try {
    await moveReferenceVideo(prisma, id, choice === "__new__" ? { name } : { referenceCreatorId: choice }, { actorId: session.user!.id! });
  } catch (err) {
    redirect(`${back}?linkError=${encodeURIComponent(msg(err, "Couldn't move that video."))}`);
  }
  revalidatePath("/reference");
  revalidatePath(back);
  redirect(back);
}
