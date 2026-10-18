import type { FilmArtifactRecord, FilmRecord } from "./store";

/**
 * The crew roster (who does what, how, for $0) and a pure view of the "crew room": each crew
 * member's state and latest one-line report, derived only from persisted artifacts.
 */

export type CrewMode = "AUTO" | "CHATGPT" | "ENGINE" | "CHRIS";

export interface CrewMember {
  id: string;
  name: string;
  goal: string;
  mode: CrewMode;
  /** Artifact kinds this member produces (latest one is its report). */
  kinds: string[];
}

export const CREW: CrewMember[] = [
  { id: "director", name: "Film Director", goal: "Owns the brief and the call: good enough, revise, or stop.", mode: "CHATGPT", kinds: ["BRIEF", "DIRECTOR_DECISION", "DECISION"] },
  { id: "hook", name: "Hook", goal: "Earns the first 2 seconds — 5+ options, scored.", mode: "CHATGPT", kinds: ["HOOKS"] },
  { id: "writer", name: "Screenwriter", goal: "Narration in your voice, one metaphor, every number checkable.", mode: "CHATGPT", kinds: ["SCRIPT"] },
  { id: "camera", name: "Cinematographer", goal: "Turns each line into shots that literally show it.", mode: "CHATGPT", kinds: ["SHOT_PLAN"] },
  { id: "engine", name: "Engine", goal: "Validates the film, draws the storyboard, renders.", mode: "ENGINE", kinds: ["VALIDATION", "STORYBOARD", "STORYBOARD_FAILED", "RENDER", "RENDER_FAILED"] },
  { id: "verify", name: "Verification", goal: "Recomputes every number on screen — wrong math blocks the film.", mode: "AUTO", kinds: ["VERIFICATION"] },
  { id: "meaning", name: "Meaning-Match", goal: "Checks each picture shows what the line says.", mode: "AUTO", kinds: ["MEANING_MATCH_AUTO", "MEANING_MATCH"] },
  { id: "continuity", name: "Continuity", goal: "Objects, counts and directions stay consistent shot to shot.", mode: "AUTO", kinds: ["CONTINUITY"] },
  { id: "quality", name: "Quality", goal: "Safe zones, legibility, framing, loudness — the premium bar.", mode: "AUTO", kinds: ["QUALITY_AUTO", "QUALITY", "QUALITY_RENDER_AUTO", "QUALITY_RENDER"] },
  { id: "retention", name: "Retention", goal: "Where a cold viewer would swipe away (estimates).", mode: "CHATGPT", kinds: ["RETENTION"] },
  { id: "cohesion", name: "Cohesion", goal: "One world, one metaphor, an ending that lands.", mode: "CHATGPT", kinds: ["COHESION"] },
  { id: "facts", name: "Fact check", goal: "The Claims Gate's rules on every factual line.", mode: "CHATGPT", kinds: ["FACT_CHECK"] },
  { id: "analysis", name: "Analysis", goal: "A first-time viewer's read of the finished film.", mode: "CHATGPT", kinds: ["ANALYSIS"] },
];

export type CrewState = "idle" | "working" | "waiting" | "done" | "flagged";

export interface CrewRoomEntry {
  member: CrewMember;
  state: CrewState;
  summary: string | null;
  via: string | null;
  at: string | null;
}

export interface CrewRoomView {
  entries: CrewRoomEntry[];
  timeline: Array<{ at: string; who: string; via: string; summary: string; gate: "PASS" | "BLOCK" | null }>;
  iteration: number;
  maxIterations: number;
  roundTrips: number;
  costUsd: 0;
}

const WORKING_BY_STEP: Record<string, string[]> = {
  VALIDATE: ["engine"],
  VERIFY: ["verify"],
  STORYBOARD: ["engine"],
  STORYBOARD_WAIT: ["engine"],
  AUTO_REVIEW: ["meaning", "continuity", "quality"],
  RENDER: ["engine"],
  RENDER_WAIT: ["engine"],
  FINAL_QC: ["quality"],
};
const WAITING_BY_PACK: Record<string, string[]> = {
  WRITE: ["director", "hook", "writer", "camera"],
  REVIEW: ["meaning", "cohesion", "retention", "quality", "facts", "director"],
  FIX: ["camera", "writer"],
  FINAL: ["quality", "analysis"],
};

const WHO = new Map(CREW.flatMap((m) => m.kinds.map((k) => [k, m.name] as const)));

export function crewRoomView(film: FilmRecord, artifacts: FilmArtifactRecord[]): CrewRoomView {
  const sorted = [...artifacts].sort((a, b) => +a.createdAt - +b.createdAt);
  const working = film.status === "WORKING" || film.status === "RENDERING" ? (WORKING_BY_STEP[film.step] ?? []) : [];
  const waiting = film.status === "NEEDS_CHATGPT" && film.pending ? (WAITING_BY_PACK[film.pending.kind] ?? []) : [];
  const entries = CREW.map((member): CrewRoomEntry => {
    const last = sorted.filter((a) => member.kinds.includes(a.kind)).at(-1) ?? null;
    const state: CrewState = working.includes(member.id) ? "working" : waiting.includes(member.id) ? "waiting" : last ? (last.gate === "BLOCK" ? "flagged" : "done") : "idle";
    return { member, state, summary: last?.summary ?? null, via: last?.via ?? null, at: last?.createdAt.toISOString() ?? null };
  });
  const timeline = sorted
    .filter((a) => a.kind !== "PACK_ANSWER")
    .map((a) => ({ at: a.createdAt.toISOString(), who: a.agent === "CHRIS" ? "You" : a.kind === "PACK_ISSUED" || a.kind === "PACK_REJECTED" ? "Studio" : (WHO.get(a.kind) ?? "Studio"), via: a.via, summary: a.summary, gate: a.gate }))
    .reverse();
  return { entries, timeline, iteration: film.iteration, maxIterations: film.limits.maxIterations, roundTrips: film.counters.roundTrips, costUsd: 0 };
}

export function studioStatusLabel(film: Pick<FilmRecord, "status" | "pending">): string {
  switch (film.status) {
    case "WORKING":
      return "Crew working";
    case "NEEDS_CHATGPT":
      return film.pending?.kind === "FINAL" ? "Optional check" : "Ask ChatGPT";
    case "NEEDS_CHRIS":
      return "Your turn";
    case "RENDERING":
      return "Rendering";
    case "READY":
      return "Ready";
    case "BLOCKED":
      return "Blocked";
    case "STOPPED":
      return "Stopped";
    case "FAILED":
      return "Needs a resume";
  }
}
