"use server";

import { revalidatePath } from "next/cache";
import {
  prisma,
  saveImportedScripts,
  getActivePostingPlan,
  getReferenceStyleProfile,
  getOwnSpeechProfile,
  type SaveImportedScriptsInput,
  type SaveImportedScriptsResult,
} from "@chris/domain";
import { ownPaceWpm, scriptStyleFrom } from "@chris/domain/script-import";
import { requireSession } from "../../../lib/session";
import { APP_TZ } from "../../../lib/calendar-data";

/** Saves the scripts Chris confirmed — no model call (see docs/decisions-pending/chatgpt-scripts.md). */
export async function saveChatGptScripts(input: SaveImportedScriptsInput): Promise<SaveImportedScriptsResult | { error: string }> {
  const session = await requireSession();
  try {
    const plan = await getActivePostingPlan(prisma);
    const style = scriptStyleFrom(await getReferenceStyleProfile(prisma, { group: "MAIN" }));
    const own = await getOwnSpeechProfile(prisma);
    const wpm = ownPaceWpm(own) ?? style.wpm;
    const res = await saveImportedScripts(prisma, input, { actorId: session.user!.id! }, {
      tz: APP_TZ,
      plan,
      wpm,
      targetSeconds: { min: style.minSeconds, max: style.maxSeconds },
    });
    revalidatePath("/plan");
    revalidatePath("/plan/scripts");
    revalidatePath("/film");
    return res;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't save the scripts" };
  }
}
