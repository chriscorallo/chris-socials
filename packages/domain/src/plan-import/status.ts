import type { ContentState } from "@prisma/client";
import { friendlyStateLabel, friendlyStateTone, nextActionFor, type FriendlyTone, type NextActionKind } from "../friendly-status";

/**
 * Plan board wording. A planned video that hasn't been filmed yet has exactly one next step
 * for Chris — upload its footage — whatever internal planning state it's in (the research /
 * script steps are optional for a video he planned himself; uploading walks it to FILMED with
 * honest SYSTEM transitions, see advancePlannedItemToFilmed). From FILMED on, the app-wide
 * friendly status + next action apply unchanged.
 */
export const PRE_FILM_STATES: ReadonlySet<ContentState> = new Set<ContentState>([
  "IDEA", "SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED", "READY_TO_FILM",
]);

export interface PlannedVideoStatus {
  label: string;
  tone: FriendlyTone;
  action: { kind: NextActionKind; label: string };
  /** Footage can be added from the plan board (pre-film states and anything up to editing). */
  canUpload: boolean;
  filmed: boolean;
}

const UPLOADABLE = new Set<ContentState>([...PRE_FILM_STATES, "FILMED", "MEDIA_INGESTED", "TAKE_SELECTED"]);

export function plannedVideoStatus(state: ContentState): PlannedVideoStatus {
  if (PRE_FILM_STATES.has(state)) {
    return { label: "Not filmed yet", tone: "gold", action: { kind: "UPLOAD", label: "Upload footage" }, canUpload: true, filmed: false };
  }
  const next = nextActionFor(state);
  return {
    label: friendlyStateLabel(state),
    tone: friendlyStateTone(state),
    action: { kind: next.kind, label: next.label },
    canUpload: UPLOADABLE.has(state),
    filmed: true,
  };
}
