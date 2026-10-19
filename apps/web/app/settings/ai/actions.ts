"use server";

import { revalidatePath } from "next/cache";
import { prisma, setQualityCheckMode, type QualityCheckMode } from "@chris/domain";
import { requireSession } from "../../../lib/session";

/** "Quality check before scheduling" — Firm / Let me skip it. Audit-logged (setFlag). See
 * docs/decisions-pending/quality-override.md. */
export async function setQualityModeSettingAction(mode: QualityCheckMode): Promise<{ ok: boolean; error?: string }> {
  const session = await requireSession();
  if (mode !== "FIRM" && mode !== "SKIP_ALLOWED") return { ok: false, error: "Unknown setting." };
  try {
    await setQualityCheckMode(prisma, mode, session.user!.id!);
    revalidatePath("/settings/ai");
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't save the setting — try again." };
  }
}
