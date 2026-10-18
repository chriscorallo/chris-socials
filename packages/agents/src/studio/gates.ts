import type { DirectorDecision, Revision } from "./schemas";

/**
 * Studio hard gates + the Director guard. Authority (spec §5, /docs/ARCHITECTURE.md):
 * Chris > hard gates > Brand > strategy > Director > specialists. Enforced in the TYPES:
 *
 *  - a gate is `{status:"PASS"} | {status:"BLOCK", reasons}` — never a number, so nothing can
 *    average it with a creative score;
 *  - `FinalDecision` of kind "APPROVE" can only be built from `PassedGates` (both gates
 *    literally `{status:"PASS"}`) — `guardDirectorDecision` is the only constructor and it
 *    narrows the gates before it builds one. A "great" creative review cannot express an
 *    APPROVE over a BLOCK.
 *  - the code half of the Director can only make the creative Director's call STRICTER
 *    (APPROVE → REVISE/BLOCKED), never looser.
 */

export type HardGate = { status: "PASS" } | { status: "BLOCK"; reasons: string[] };
export const PASS: HardGate = { status: "PASS" };
export const block = (...reasons: string[]): HardGate => ({ status: "BLOCK", reasons });

export interface FilmHardGates {
  /** Math on screen/in lines re-computed by code; every number traced; factual claims confirmed. */
  verification: HardGate;
  /** Engine validation + storyboard/render job success + render measurements. */
  technical: HardGate;
}

export interface PassedGates {
  verification: { status: "PASS" };
  technical: { status: "PASS" };
}

export function gatesPassed(g: FilmHardGates): g is FilmHardGates & PassedGates {
  return g.verification.status === "PASS" && g.technical.status === "PASS";
}

/** OR of the gates — the whole algorithm (no weights, no scores). */
export function aggregateFilmGates(g: FilmHardGates): HardGate {
  const reasons = [g.verification, g.technical].flatMap((x) => (x.status === "BLOCK" ? x.reasons : []));
  return reasons.length ? { status: "BLOCK", reasons } : PASS;
}

export type FinalDecision =
  | { kind: "APPROVE"; gates: PassedGates; rationale: string; coerced: false }
  | { kind: "REVISE"; revisions: Revision[]; rationale: string; coerced: boolean; coercedBecause: string[] }
  | { kind: "BLOCKED"; reasons: string[]; rationale: string }
  | { kind: "STOP"; rationale: string };

export interface GuardContext {
  gates: FilmHardGates;
  /** First-pass Meaning-Match MISMATCHes (concept rules) the Director didn't overrule with a reason. */
  unresolvedMismatches: Array<{ shotId: string; line: string; fix: string }>;
  /** BLOCKING quality findings (deterministic or vision). */
  blockingQuality: Array<{ shotId: string; detail: string; fix: string }>;
  iteration: number;
  maxIterations: number;
}

/**
 * Turns the creative Director's decision (from the review round trip, or null when there is
 * none) into what the orchestrator does. Stricter only:
 *  - any hard-gate BLOCK → REVISE while iterations remain (with the gate reasons as revisions),
 *    else BLOCKED;
 *  - APPROVE with unresolved MISMATCHes or BLOCKING quality issues → REVISE while iterations
 *    remain; at the cap they're surfaced to Chris (not a gate — Chris decides at storyboard review);
 *  - STOP stays STOP (a human can restart).
 */
export function guardDirectorDecision(decision: DirectorDecision | null, ctx: GuardContext): FinalDecision {
  const canRevise = ctx.iteration < ctx.maxIterations;
  const gateReasons = [ctx.gates.verification, ctx.gates.technical].flatMap((g) => (g.status === "BLOCK" ? g.reasons : []));
  if (decision?.decision === "STOP") return { kind: "STOP", rationale: decision.rationale };

  const forced: Revision[] = [];
  const because: string[] = [];
  if (gateReasons.length) {
    because.push(...gateReasons.map((r) => `Hard gate: ${r}`));
    forced.push(...gateReasons.map((r) => ({ target: "SCRIPT" as const, refs: [], instruction: `Fix this so the hard gate passes: ${r}`, because: [{ kind: "REPORT" as const, ref: "gate", detail: r }] })));
  }
  for (const m of ctx.unresolvedMismatches) {
    because.push(`Meaning-Match: ${m.shotId} "${m.line}" doesn't show what's said`);
    forced.push({ target: "SHOTS", refs: [m.shotId], instruction: m.fix, because: [{ kind: "REPORT", ref: `meaning-match:${m.shotId}`, detail: `MISMATCH — "${m.line}"` }] });
  }
  for (const q of ctx.blockingQuality) {
    because.push(`Quality: ${q.shotId} ${q.detail}`);
    forced.push({ target: "SHOTS", refs: [q.shotId], instruction: q.fix, because: [{ kind: "REPORT", ref: `quality:${q.shotId}`, detail: q.detail }] });
  }

  if (gateReasons.length && !canRevise) return { kind: "BLOCKED", reasons: gateReasons, rationale: "A hard gate is still blocking and the crew is out of revision rounds." };

  const g = ctx.gates;
  if (decision?.decision === "APPROVE" && forced.length === 0 && gatesPassed(g)) {
    return { kind: "APPROVE", gates: { verification: { status: "PASS" }, technical: { status: "PASS" } }, rationale: decision.rationale, coerced: false };
  }
  if (decision?.decision === "APPROVE" && forced.length > 0 && !canRevise && gatesPassed(g)) {
    // Out of rounds: creative leftovers go to Chris as known issues; the gates themselves pass.
    return { kind: "APPROVE", gates: { verification: { status: "PASS" }, technical: { status: "PASS" } }, rationale: `${decision.rationale} (Known issues left for Chris: ${because.join("; ")})`, coerced: false };
  }
  if (!canRevise) {
    return gatesPassed(g)
      ? { kind: "APPROVE", gates: { verification: { status: "PASS" }, technical: { status: "PASS" } }, rationale: `Out of revision rounds — handing the best version to Chris. ${because.join("; ")}`.trim(), coerced: false }
      : { kind: "BLOCKED", reasons: gateReasons, rationale: "Out of revision rounds with a hard gate blocking." };
  }
  const own = decision?.decision === "REVISE" ? decision.revisions : [];
  return {
    kind: "REVISE",
    revisions: [...own, ...forced],
    rationale: decision?.rationale ?? "Revising the findings the crew raised.",
    coerced: decision?.decision !== "REVISE",
    coercedBecause: decision?.decision === "REVISE" ? [] : because,
  };
}
