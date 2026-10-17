import { prisma } from "@chris/domain";
import { maybeAutoStyleCut } from "@chris/worker/style-cut-job";
import { storage } from "./storage";
import { heavyJobMode } from "./render-config";

/**
 * After the no-AI starter edit is made: if the take already has captions, turn the untouched
 * starter edit into a style cut (docs/decisions-pending/style-cut.md). Best effort — a failure
 * leaves the plain starter edit. On the live site (sandbox mode) the take isn't downloaded into
 * this function to measure its silences (the cloud upload job does that); the cut then uses
 * word timings with wider pads, and is refreshed by the upload job once silences are measured.
 */
export async function autoStyleCutAfterStarter(contentItemId: string, actorId: string): Promise<void> {
  try {
    await maybeAutoStyleCut(prisma, storage, contentItemId, { actorId }, { measureSilences: heavyJobMode() !== "sandbox" });
  } catch (err) {
    console.warn("[style-cut]", err instanceof Error ? err.message : err);
  }
}
