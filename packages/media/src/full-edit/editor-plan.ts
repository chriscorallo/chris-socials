import { z } from "zod";
import type { TranscriptWord } from "../caption-chunking";
import type { FESentence } from "./understand";
import type { StoryPlan, WordCut } from "./story";

/**
 * The Editor's cut (2026-10-21). An editor — the Editor agent, with the title, the brief and the
 * transcript as numbered lines — writes the video: the lean transcript in order (hook → setup →
 * tension → turn → payoff → ending), using only lines Chris said, filler trimmed inside lines,
 * what was cut and why, a headline per beat, and what each beat needs the viewer to see. The
 * engine executes it exactly (`planFromEditor`); nothing here invents words.
 */
export const EDITOR_ROLES = ["HOOK", "SETUP", "TENSION", "TURN", "PAYOFF", "ENDING"] as const;
export type EditorRole = (typeof EDITOR_ROLES)[number];

const Int = z.number().int();

export const EditorPlanSchema = z.object({
  /** The lines the viewer hears, in output order. */
  storyline: z
    .array(
      z.object({
        sentenceId: Int,
        role: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : v), z.enum(EDITOR_ROLES)),
        /** Keep only words [from..to] of the line (0-based, inclusive, within the line) — filler trimmed. */
        keepWords: z.object({ from: Int, to: Int }).nullable().optional(),
        /** The idea in 2–5 words, held on screen for this beat (consecutive identical headlines merge). */
        headline: z.string().nullable().optional(),
        /** What the viewer needs to SEE here (a concept, not the words), or null for face only. */
        viewerNeeds: z.string().nullable().optional(),
      }),
    )
    .min(1),
  /** Lines left out, each with the reason Chris reads in the editor. */
  cut: z.array(z.object({ sentenceId: Int, why: z.string() })).default([]),
  /** The hook title (on-screen, title-sized); null = none. */
  title: z.string().nullable().optional(),
  /** How the take should feel: long shots with zooms (one continuous take) or tight cuts. */
  pacing: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase().replace(/[^A-Z]+/g, "_") : v), z.enum(["LONG_SHOTS_ZOOMS", "TIGHT_CUTS"])).default("LONG_SHOTS_ZOOMS"),
  /** Why this cut, in one short paragraph (shown in the editor). */
  rationale: z.string().default(""),
  /** The cold-viewer read-through: where it holds, where it was fixed. */
  coldViewer: z.string().nullable().optional(),
});
export type EditorPlan = z.infer<typeof EditorPlanSchema>;

export interface EditorBeat {
  role: EditorRole;
  headline: string | null;
  viewerNeeds: string | null;
  sentenceIds: number[];
}

/** Consecutive storyline entries with the same headline form one beat (one held headline). */
export function editorBeats(plan: EditorPlan): EditorBeat[] {
  const beats: EditorBeat[] = [];
  for (const e of plan.storyline) {
    const prev = beats[beats.length - 1];
    const headline = e.headline?.trim() || null;
    if (prev && prev.headline === headline && prev.role === e.role) {
      prev.sentenceIds.push(e.sentenceId);
      if (!prev.viewerNeeds && e.viewerNeeds) prev.viewerNeeds = e.viewerNeeds;
    } else beats.push({ role: e.role, headline, viewerNeeds: e.viewerNeeds?.trim() || null, sentenceIds: [e.sentenceId] });
  }
  return beats;
}

/**
 * A plan the engine can execute: unknown / duplicate ids dropped, the first line is the hook,
 * trims clamped to the line. Returns the problems found (shown, never fatal) with the plan.
 */
export function sanitizeEditorPlan(plan: EditorPlan, sentences: FESentence[]): { plan: EditorPlan; problems: string[] } {
  const problems: string[] = [];
  const byId = new Map(sentences.map((s) => [s.id, s]));
  const seen = new Set<number>();
  const storyline: EditorPlan["storyline"] = [];
  for (const e of plan.storyline) {
    const s = byId.get(e.sentenceId);
    if (!s) {
      problems.push(`line ${e.sentenceId} doesn't exist — dropped`);
      continue;
    }
    if (seen.has(e.sentenceId)) {
      problems.push(`line ${e.sentenceId} listed twice — second one dropped`);
      continue;
    }
    seen.add(e.sentenceId);
    let keepWords = e.keepWords ?? null;
    if (keepWords) {
      const n = s.w1 - s.w0 + 1;
      const from = Math.max(0, Math.min(keepWords.from, n - 1));
      const to = Math.max(from, Math.min(keepWords.to, n - 1));
      if (to - from + 1 < 2 && n > 2) {
        problems.push(`line ${e.sentenceId}: a one-word trim isn't a line — kept whole`);
        keepWords = null;
      } else keepWords = { from, to };
    }
    storyline.push({ ...e, keepWords, headline: e.headline?.trim() || null, viewerNeeds: e.viewerNeeds?.trim() || null });
  }
  if (storyline.length === 0) return { plan: { ...plan, storyline }, problems: [...problems, "no usable lines"] };
  if (storyline[0]!.role !== "HOOK") {
    problems.push(`the first line was marked ${storyline[0]!.role} — it is the hook by position`);
    storyline[0] = { ...storyline[0]!, role: "HOOK" };
  }
  const cut = plan.cut.filter((c) => byId.has(c.sentenceId) && !seen.has(c.sentenceId));
  return { plan: { ...plan, storyline, cut }, problems };
}

/**
 * The Editor's plan as the story planner's output, so the rest of the Full edit (shots, titles,
 * graphics, checks, report) runs unchanged. Trims inside a line become word cuts ("TRIM"), only
 * where both edges can be cut cleanly; otherwise the whole line plays.
 */
export function planFromEditor(
  plan: EditorPlan,
  sentences: FESentence[],
  words: TranscriptWord[],
  safeAfter: (k: number) => boolean,
  estimateS: (spans: Array<{ w0: number; w1: number }>) => number,
): StoryPlan {
  const byId = new Map(sentences.map((s) => [s.id, s]));
  const inPlan = new Map(plan.storyline.map((e, i) => [e.sentenceId, i]));
  const why = new Map(plan.cut.map((c) => [c.sentenceId, c.why]));
  const decisions: StoryPlan["decisions"] = sentences.map((s) => {
    const kept = inPlan.has(s.id);
    return {
      id: s.id,
      kept,
      kind: kept ? null : "LOW_VALUE",
      why: kept ? "" : why.get(s.id) ?? "Not in the editor's cut",
      value: kept ? 3 : 0,
      keptInstead: null,
      forced: false,
    };
  });
  const wordCuts: WordCut[] = [];
  const order: StoryPlan["order"] = [];
  const earliestKept = Math.min(...plan.storyline.map((e) => byId.get(e.sentenceId)!.w0));
  plan.storyline.forEach((e, i) => {
    const s = byId.get(e.sentenceId)!;
    let w0 = s.w0;
    let w1 = s.w1;
    if (e.keepWords) {
      // Trim edges snap to a clean pause within one word when there is one; otherwise the cut
      // lands on the word edge itself (the style cut pads it) — a hand edit does the same.
      const snap = (k: number, lo: number, hi: number, after: boolean) => {
        const ok = (x: number) => (after ? safeAfter(x) : safeAfter(x - 1));
        for (const c of [k, k - 1, k + 1]) if (c >= lo && c <= hi && ok(c)) return c;
        return k;
      };
      const a = Math.max(s.w0, Math.min(s.w1, snap(s.w0 + e.keepWords.from, s.w0, s.w1, false)));
      const b = Math.max(a, Math.min(s.w1, snap(s.w0 + e.keepWords.to, s.w0, s.w1, true)));
      if (b - a + 1 >= 2 || s.w1 - s.w0 + 1 <= 2) {
        if (a > s.w0) wordCuts.push({ w0: s.w0, w1: a - 1, kind: "TRIM", text: words.slice(s.w0, a).map((w) => w.word).join(" ") });
        if (b < s.w1) wordCuts.push({ w0: b + 1, w1: s.w1, kind: "TRIM", text: words.slice(b + 1, s.w1 + 1).map((w) => w.word).join(" ") });
        w0 = a;
        w1 = b;
      }
    }
    order.push({ w0, w1, role: i === 0 ? "HOOK" : "STORY", sentenceIds: [s.id] });
  });
  const coldOpen = byId.get(plan.storyline[0]!.sentenceId)!.w0 !== earliestKept;
  return { decisions, wordCuts: wordCuts.sort((a, b) => a.w0 - b.w0), order, coldOpen, hookReplayed: false, estimatedS: estimateS(order), marked: [] };
}
