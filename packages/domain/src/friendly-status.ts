import type { ContentState } from "@prisma/client";

/**
 * Plain-English status for every ContentState — the ONLY place the app turns a state-machine
 * name into words Chris reads. Lists, badges, the calendar sheets and the video page all use
 * this, so no raw enum (MEDIA_INGESTED, QC_REPAIR…) ever reaches the UI. The fine-grained
 * states still exist and still gate everything; this is presentation only.
 * See docs/decisions-pending/flow.md.
 */
export const FRIENDLY_STATE_LABEL: Record<ContentState, string> = {
  IDEA: "Idea",
  SELECTED: "Planned",
  CONTRACTED: "Planned",
  RESEARCHING: "Writing",
  RESEARCH_BLOCKED: "Needs a fix",
  RESEARCHED: "Writing",
  SCRIPTING: "Writing",
  SCRIPTED: "Writing",
  READY_TO_FILM: "Ready to film",
  FILMED: "Filmed — upload footage",
  MEDIA_INGESTED: "Editing",
  TAKE_SELECTED: "Editing",
  EDIT_PLANNED: "Editing",
  EDITING: "Editing",
  RENDERED: "Checking",
  QC_REPAIR: "Checking",
  QC_BLOCKED: "Needs a fix",
  READY: "Ready to post",
  SCHEDULED: "Scheduled",
  PUBLISHING: "Posting…",
  PUBLISHED: "Posted",
  MEASURING: "Posted",
  ARCHIVED: "Done",
  CANCELLED: "Cancelled",
};

export function friendlyStateLabel(state: ContentState): string {
  return FRIENDLY_STATE_LABEL[state];
}

export type FriendlyTone = "gold" | "violet" | "rose" | "emerald" | "neutral";

/** Pill color: rose = needs a fix, emerald = ready/posted, violet = being made, gold = early. */
export function friendlyStateTone(state: ContentState): FriendlyTone {
  if (state === "RESEARCH_BLOCKED" || state === "QC_BLOCKED") return "rose";
  if (state === "CANCELLED" || state === "ARCHIVED") return "neutral";
  if (["READY", "SCHEDULED", "PUBLISHING", "PUBLISHED", "MEASURING"].includes(state)) return "emerald";
  if (["IDEA", "SELECTED", "CONTRACTED"].includes(state)) return "gold";
  return "violet";
}

/** The five steps Chris thinks in. The 24 states map onto them for the video page's
 * progress bar. */
export const FLOW_STEPS = ["Plan", "Write", "Film", "Edit", "Post"] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

const STEP_OF: Record<ContentState, number> = {
  IDEA: 0,
  SELECTED: 0,
  CONTRACTED: 0,
  RESEARCHING: 1,
  RESEARCH_BLOCKED: 1,
  RESEARCHED: 1,
  SCRIPTING: 1,
  SCRIPTED: 1,
  READY_TO_FILM: 2,
  FILMED: 2,
  MEDIA_INGESTED: 3,
  TAKE_SELECTED: 3,
  EDIT_PLANNED: 3,
  EDITING: 3,
  RENDERED: 3,
  QC_REPAIR: 3,
  QC_BLOCKED: 3,
  READY: 4,
  SCHEDULED: 4,
  PUBLISHING: 4,
  PUBLISHED: 4,
  MEASURING: 4,
  ARCHIVED: 4,
  CANCELLED: 0,
};

/** Index into FLOW_STEPS of the step this state is in. Posted items are past the last step
 * (`done: true`). */
export function flowStepFor(state: ContentState): { index: number; done: boolean } {
  return {
    index: STEP_OF[state],
    done: state === "PUBLISHED" || state === "MEASURING" || state === "ARCHIVED",
  };
}

/** Which home-page group a video belongs in. IDEAs are not "videos" yet (they live in Ideas
 * and are counted on Home, not listed); cancelled ones are hidden. */
export type HomeGroup = "IN_PROGRESS" | "READY" | "POSTED" | "IDEA" | "HIDDEN";

export function homeGroupFor(state: ContentState): HomeGroup {
  if (state === "IDEA") return "IDEA";
  if (state === "CANCELLED") return "HIDDEN";
  if (state === "READY" || state === "SCHEDULED" || state === "PUBLISHING") return "READY";
  if (state === "PUBLISHED" || state === "MEASURING" || state === "ARCHIVED") return "POSTED";
  return "IN_PROGRESS";
}

/**
 * The ONE thing to do next with a video — what its card's button and its page's big button
 * do. `kind` is what the web layer maps to a link or action:
 *  - START_EDIT: footage is in but there's no edit yet → createStarterEdit, then the editor
 *  - EDIT: open the editor
 *  - UPLOAD: the video's own upload box
 *  - FILM: the Film page
 *  - SCHEDULE: pick a date (the video page's schedule panel)
 *  - VIEW_POST: the live post (or the video page when there's no URL)
 *  - FIX: something is blocked — the video page explains what
 *  - OPEN: nothing for Chris to do with one tap — open the video page
 */
export type NextActionKind = "START_EDIT" | "EDIT" | "UPLOAD" | "FILM" | "SCHEDULE" | "VIEW_POST" | "FIX" | "OPEN";

export interface NextAction {
  kind: NextActionKind;
  label: string;
  /** One plain sentence: what happens / what's going on. */
  hint: string;
  /** Waiting on Chris (true) or nothing for him to do right now (false). */
  needsYou: boolean;
}

export function nextActionFor(state: ContentState): NextAction {
  switch (state) {
    case "IDEA":
      return { kind: "OPEN", label: "Plan it", hint: "An idea — open it to turn it into a video.", needsYou: true };
    case "SELECTED":
    case "CONTRACTED":
    case "RESEARCHING":
    case "RESEARCHED":
    case "SCRIPTING":
    case "SCRIPTED":
      return { kind: "OPEN", label: "Continue", hint: "Being planned and written.", needsYou: false };
    case "RESEARCH_BLOCKED":
      return { kind: "FIX", label: "Fix", hint: "The fact-check stopped this one — rethink the angle and try again.", needsYou: true };
    case "READY_TO_FILM":
      return { kind: "FILM", label: "Film it", hint: "The script is ready. Film it, then upload the footage.", needsYou: true };
    case "FILMED":
      return { kind: "UPLOAD", label: "Upload footage", hint: "Upload what you filmed to start editing.", needsYou: true };
    case "MEDIA_INGESTED":
    case "TAKE_SELECTED":
      // Editor only opens from EDIT_PLANNED on — START_EDIT makes the (no-AI) starter edit first.
      return { kind: "START_EDIT", label: "Edit video", hint: "Your footage is in — open the editor.", needsYou: true };
    case "EDIT_PLANNED":
    case "EDITING":
      return { kind: "EDIT", label: "Edit", hint: "Finish the edit, then schedule it.", needsYou: true };
    case "RENDERED":
    case "QC_REPAIR":
      return { kind: "EDIT", label: "Edit", hint: "Being checked — open the editor to finish it.", needsYou: true };
    case "QC_BLOCKED":
      return { kind: "FIX", label: "Fix", hint: "The final check found a problem — fix it in the editor.", needsYou: true };
    case "READY":
      return { kind: "SCHEDULE", label: "Schedule", hint: "Finished and checked — pick when it goes out.", needsYou: true };
    case "SCHEDULED":
      return { kind: "OPEN", label: "View", hint: "Scheduled — it goes out on its own.", needsYou: false };
    case "PUBLISHING":
      return { kind: "OPEN", label: "View", hint: "Posting now.", needsYou: false };
    case "PUBLISHED":
    case "MEASURING":
    case "ARCHIVED":
      return { kind: "VIEW_POST", label: "View post", hint: "Live.", needsYou: false };
    case "CANCELLED":
      return { kind: "OPEN", label: "View", hint: "Cancelled.", needsYou: false };
  }
}
