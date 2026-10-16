import type { ContentState } from "@prisma/client";

/**
 * Coarse production stages over the 24-state machine — what Chris actually scans for in a
 * list ("what's waiting on me to film?", "what's ready to go out?"), not the fine-grained
 * state names. Pure data; no behavior depends on it beyond display/filtering.
 */
export const CONTENT_STAGES = [
  { key: "plan", label: "Planning", states: ["IDEA", "SELECTED", "CONTRACTED"] },
  { key: "write", label: "Research & Script", states: ["RESEARCHING", "RESEARCH_BLOCKED", "RESEARCHED", "SCRIPTING", "SCRIPTED"] },
  { key: "film", label: "To Film", states: ["READY_TO_FILM", "FILMED"] },
  { key: "edit", label: "Editing", states: ["MEDIA_INGESTED", "TAKE_SELECTED", "EDIT_PLANNED", "EDITING", "RENDERED", "QC_REPAIR", "QC_BLOCKED"] },
  { key: "ship", label: "Ready & Scheduled", states: ["READY", "SCHEDULED", "PUBLISHING"] },
  { key: "live", label: "Live", states: ["PUBLISHED", "MEASURING"] },
  { key: "done", label: "Done", states: ["ARCHIVED", "CANCELLED"] },
] as const satisfies ReadonlyArray<{ key: string; label: string; states: readonly ContentState[] }>;

export type ContentStageKey = (typeof CONTENT_STAGES)[number]["key"];

export function stageForState(state: ContentState) {
  return CONTENT_STAGES.find((s) => (s.states as readonly ContentState[]).includes(state))!;
}

/**
 * Who moves an item out of its current state, and how — "YOU" means it is genuinely waiting
 * on Chris (a creative decision, a shoot, an upload, a blocked gate); "SYSTEM" means an AI or
 * deterministic step can run it (by button today, or Autopilot). Shown next to each item so
 * the list doubles as a to-do list.
 */
export const NEXT_STEP: Record<ContentState, { owner: "YOU" | "SYSTEM" | "NONE"; label: string }> = {
  IDEA: { owner: "YOU", label: "Select for a week" },
  SELECTED: { owner: "SYSTEM", label: "Draft production contract" },
  CONTRACTED: { owner: "SYSTEM", label: "Start research" },
  RESEARCHING: { owner: "SYSTEM", label: "Run research → script" },
  RESEARCH_BLOCKED: { owner: "YOU", label: "Claims Gate blocked — rethink the angle" },
  RESEARCHED: { owner: "SYSTEM", label: "Write script" },
  SCRIPTING: { owner: "SYSTEM", label: "Script in progress / needs re-gate" },
  SCRIPTED: { owner: "SYSTEM", label: "Draft creator card" },
  READY_TO_FILM: { owner: "YOU", label: "Film it" },
  FILMED: { owner: "YOU", label: "Upload raw takes" },
  MEDIA_INGESTED: { owner: "SYSTEM", label: "Transcribe + pick take" },
  TAKE_SELECTED: { owner: "SYSTEM", label: "Plan the edit" },
  EDIT_PLANNED: { owner: "SYSTEM", label: "Render" },
  EDITING: { owner: "SYSTEM", label: "Render (retry)" },
  RENDERED: { owner: "SYSTEM", label: "Quality gate" },
  QC_REPAIR: { owner: "SYSTEM", label: "Auto-repair" },
  QC_BLOCKED: { owner: "YOU", label: "Repair budget spent — review" },
  READY: { owner: "SYSTEM", label: "Package + schedule" },
  SCHEDULED: { owner: "SYSTEM", label: "Publishes at scheduled time" },
  PUBLISHING: { owner: "SYSTEM", label: "Retry publish" },
  PUBLISHED: { owner: "SYSTEM", label: "Measuring" },
  MEASURING: { owner: "SYSTEM", label: "Measuring" },
  ARCHIVED: { owner: "NONE", label: "Archived" },
  CANCELLED: { owner: "NONE", label: "Cancelled" },
};
