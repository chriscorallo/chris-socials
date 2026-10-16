"use server";

import { redirect } from "next/navigation";
import { prisma, applyManualTransition } from "@chris/domain";
import { requireSession } from "../../lib/session";

/** Marks one or many READY_TO_FILM items as filmed (the human-attested READY_TO_FILM -> FILMED
 * step — packages/domain manual-transition.ts). Batch-friendly: a whole setup's shoot is one
 * submit. Each item is attempted independently so one stale row never blocks the rest. */
export async function markFilmed(formData: FormData) {
  const session = await requireSession();
  const ids = formData.getAll("contentItemId").map(String).filter(Boolean);
  const failures: string[] = [];
  for (const contentItemId of ids) {
    try {
      await applyManualTransition(prisma, { contentItemId, to: "FILMED", actorId: session.user!.id! });
    } catch (err) {
      failures.push(err instanceof Error ? err.message : contentItemId);
    }
  }
  if (failures.length > 0) {
    redirect(`/film?error=${encodeURIComponent(failures.join("; "))}`);
  }
  redirect(`/film?filmed=${ids.length}`);
}
