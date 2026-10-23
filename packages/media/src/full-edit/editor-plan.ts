import { z } from "zod";
import type { TranscriptWord } from "../caption-chunking";
import type { FESentence } from "./understand";
import { wordLevelCuts, type StoryPlan, type WordCut } from "./story";

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
        /** Words in this line to punch in on (exact words he said; at most 2 per line). */
        emphasisWords: z.array(z.string()).max(3).nullable().optional(),
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
  /** Editor v2 (2026-10-21): what the critique pass found and whether the plan was revised — the
   * provenance of the cut, stored with it. Null for a one-shot plan. */
  review: z
    .object({
      verdict: z.enum(["ACCEPT", "REVISE"]),
      findings: z.array(z.string()),
      revised: z.boolean(),
    })
    .nullable()
    .optional(),
});
export type EditorPlan = z.infer<typeof EditorPlanSchema>;

/** The checks the Editor's plan must pass before it is cut (Editor v2). Deterministic ones run
 * in `editorPlanChecklist`; the semantic ones are the critique pass's job (EDITOR_CRITIQUE). */
export const EDITOR_CHECKS = [
  "HEADLINE_PER_BEAT",
  "HOOK_STANDS_ALONE",
  "ENDING_SERVES_OBJECTIVE",
  "NUMBER_IS_PAYOFF",
  "TENSION_ADDS",
  "COLD_VIEWER",
  "DEPENDENT_LINE",
  "EMPHASIS_WORDS",
  "UNSAFE_JOIN",
] as const;
export type EditorCheck = (typeof EDITOR_CHECKS)[number];

export interface EditorChecklistFinding {
  check: EditorCheck;
  sentenceId: number | null;
  problem: string;
  fix: string;
}

/** A line that only makes sense after the one before it. */
const DEPENDENT_OPENER = /^(?:so that(?:'s| is)|that(?:'s| is) (?:why|how|where|the)|which (?:means|is why)|because of that|and that|this is why|that way|otherwise|instead of that|the other one|the second one|in that case)\b/i;
const SENTENCE_SPLIT = /[.!?…]+(?:\s|$)/;

export function sentenceCount(text: string | null | undefined): number {
  if (!text) return 0;
  return text
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 3).length;
}

/**
 * The deterministic half of the Editor's checklist (Editor v2): every beat has a headline, the
 * cold-viewer read-through is a real read (≥ 2 sentences), the hook stands alone, the plan ends on
 * an ENDING (or the PAYOFF), a kept line that leans on a cut line, a line with an amount under a
 * headline without one, and emphasis words that he did not say. Pure; what the critique pass
 * receives as "already found", and what the revise pass must clear.
 */
export function editorPlanChecklist(plan: EditorPlan, lines: Array<{ id: number; text: string; cleanEnd?: boolean }>): EditorChecklistFinding[] {
  const out: EditorChecklistFinding[] = [];
  const byId = new Map(lines.map((l) => [l.id, l]));
  const kept = new Set(plan.storyline.map((e) => e.sentenceId));
  let lastHeadline: string | null = null;
  plan.storyline.forEach((e, i) => {
    const line = byId.get(e.sentenceId);
    const text = line?.text ?? "";
    const headline = e.headline?.trim() || null;
    // A missing headline is fine only when the line continues the previous beat (same role).
    if (!headline && !(lastHeadline && i > 0 && plan.storyline[i - 1]!.role === e.role)) {
      out.push({ check: "HEADLINE_PER_BEAT", sentenceId: e.sentenceId, problem: `line ${e.sentenceId} (${e.role}) has no headline`, fix: "Give the beat its idea in 2–5 words (the number, the stake, the choice), or repeat the previous headline when it is the same idea." });
    }
    if (headline) lastHeadline = headline;
    if (i === 0 && DEPENDENT_OPENER.test(text.trim())) {
      out.push({ check: "HOOK_STANDS_ALONE", sentenceId: e.sentenceId, problem: `the hook opens with "${text.trim().split(/\s+/).slice(0, 3).join(" ")}…" — it leans on something the viewer never heard`, fix: "Open on a line that stands alone (a choice, a number, a contradiction, a question), or trim the opener with keepWords." });
    }
    if (i > 0 && DEPENDENT_OPENER.test(text.trim()) && line) {
      const prevSource = lines.filter((l) => l.id < line.id).pop();
      const prevKept = plan.storyline[i - 1]?.sentenceId;
      if (prevSource && !kept.has(prevSource.id) && prevKept !== prevSource.id) {
        out.push({ check: "DEPENDENT_LINE", sentenceId: e.sentenceId, problem: `line ${e.sentenceId} starts "${text.trim().split(/\s+/).slice(0, 3).join(" ")}…" but line ${prevSource.id}, which it answers, was cut`, fix: `Restore line ${prevSource.id} before it, or trim the opener with keepWords, or cut line ${e.sentenceId}.` });
      }
    }
    const amount = /\$\s?\d|\d+(?:,\d{3})+|\b\d+\s?(?:%|percent|k|grand|thousand|million)\b|\b(?:hundred|thousand|million) (?:dollars|bucks|grand)\b/i.test(text);
    const h = headline ?? lastHeadline;
    if (amount && h && !/\d/.test(h) && (e.role === "PAYOFF" || e.role === "TENSION")) {
      out.push({ check: "NUMBER_IS_PAYOFF", sentenceId: e.sentenceId, problem: `line ${e.sentenceId} lands an amount but its headline "${h}" carries no number`, fix: "Put the number in the headline — captions never carry a number alone." });
    }
    for (const w of e.emphasisWords ?? []) {
      const said = text.toLowerCase().includes(w.trim().toLowerCase());
      if (w.trim() && !said) out.push({ check: "EMPHASIS_WORDS", sentenceId: e.sentenceId, problem: `emphasis word "${w}" is not in line ${e.sentenceId}`, fix: "Emphasis words are words he said in that line, spelled as the transcript spells them." });
    }
  });
  // A join that would land inside the voice: a kept line with no pause after it, followed by a
  // line that is not the one he said next.
  plan.storyline.forEach((e, i) => {
    const next = plan.storyline[i + 1];
    const line = byId.get(e.sentenceId);
    if (!next || !line || line.cleanEnd !== false || e.keepWords) return;
    if (next.sentenceId !== e.sentenceId + 1) {
      out.push({ check: "UNSAFE_JOIN", sentenceId: e.sentenceId, problem: `line ${e.sentenceId} runs straight into line ${e.sentenceId + 1} with no pause, but the cut jumps to line ${next.sentenceId} after it — the join lands inside his voice`, fix: `Keep line ${e.sentenceId + 1} right after it, or end the beat on a line with a pause after it, or leave line ${e.sentenceId} out.` });
    }
  });
  const last = plan.storyline[plan.storyline.length - 1];
  if (last && last.role !== "ENDING" && last.role !== "PAYOFF") {
    out.push({ check: "ENDING_SERVES_OBJECTIVE", sentenceId: last.sentenceId, problem: `the cut ends on a ${last.role} line`, fix: "End on the line that serves the objective (the question, the line they'll send) and mark it ENDING; nothing after it." });
  }
  if (sentenceCount(plan.coldViewer) < 2) {
    out.push({ check: "COLD_VIEWER", sentenceId: null, problem: "the cold-viewer read-through is missing or a single sentence", fix: "Read the kept lines in order as a stranger: where they'd leave, whether each line follows the one before, whether the payoff lands — at least two sentences." });
  }
  const tension = plan.storyline.filter((e) => e.role === "TENSION");
  for (let i = 1; i < tension.length; i++) {
    const a = byId.get(tension[i - 1]!.sentenceId)?.text ?? "";
    const b = byId.get(tension[i]!.sentenceId)?.text ?? "";
    const na: string[] = a.match(/\d[\d,.]*/g) ?? [];
    const nb: string[] = b.match(/\d[\d,.]*/g) ?? [];
    const sameHeadline = (tension[i]!.headline?.trim() || null) === (tension[i - 1]!.headline?.trim() || null);
    if (sameHeadline && nb.length && na.length && nb.every((n) => na.includes(n))) {
      out.push({ check: "TENSION_ADDS", sentenceId: tension[i]!.sentenceId, problem: `line ${tension[i]!.sentenceId} repeats the numbers of line ${tension[i - 1]!.sentenceId} under the same headline — it adds nothing`, fix: "Keep the better of the two, or give the second its own new number, stake or contrast." });
    }
  }
  return out;
}

export interface EditorBeat {
  role: EditorRole;
  headline: string | null;
  viewerNeeds: string | null;
  sentenceIds: number[];
  /** Emphasis words per line (sentenceId → the words), for the screen's zooms. */
  emphasis: Array<{ sentenceId: number; words: string[] }>;
}

/** Consecutive storyline entries with the same headline form one beat (one held headline). */
export function editorBeats(plan: EditorPlan): EditorBeat[] {
  const beats: EditorBeat[] = [];
  for (const e of plan.storyline) {
    const prev = beats[beats.length - 1];
    const headline = e.headline?.trim() || null;
    const emph = (e.emphasisWords ?? []).map((w) => w.trim()).filter(Boolean);
    if (prev && prev.headline === headline && prev.role === e.role) {
      prev.sentenceIds.push(e.sentenceId);
      if (!prev.viewerNeeds && e.viewerNeeds) prev.viewerNeeds = e.viewerNeeds;
      if (emph.length) prev.emphasis.push({ sentenceId: e.sentenceId, words: emph });
    } else beats.push({ role: e.role, headline, viewerNeeds: e.viewerNeeds?.trim() || null, sentenceIds: [e.sentenceId], emphasis: emph.length ? [{ sentenceId: e.sentenceId, words: emph }] : [] });
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
    let headline = e.headline?.trim() || null;
    if (!headline && storyline.length) {
      // Editor v2: every beat has a headline — a missing one continues the previous idea.
      headline = storyline[storyline.length - 1]!.headline ?? null;
      if (headline) problems.push(`line ${e.sentenceId}: no headline — kept "${headline}" up`);
    }
    const emphasisWords = (e.emphasisWords ?? []).map((w) => w.trim()).filter((w) => w && s.text.toLowerCase().includes(w.toLowerCase())).slice(0, 2);
    storyline.push({ ...e, keepWords, headline, viewerNeeds: e.viewerNeeds?.trim() || null, emphasisWords: emphasisWords.length ? emphasisWords : null });
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
  // 2026-10-23: the Editor chooses lines; the free cutter's word-level cleanup still runs inside
  // them (fillers, restarts, stutters, throat-clearing lead-ins) — it did not before, which is
  // why the Editor's cut kept "So So a a higher higher" that the free cut would have cleaned.
  const trimmed = (k: number) => wordCuts.some((c) => k >= c.w0 && k <= c.w1);
  const cleanup = wordLevelCuts(words, sentences, decisions, safeAfter).filter((c) => {
    for (let k = c.w0; k <= c.w1; k++) if (trimmed(k)) return false;
    const o = order.find((x) => c.w0 >= x.w0 && c.w1 <= x.w1);
    return !!o && !(c.w0 === o.w0 && c.w1 === o.w1);
  });
  return { decisions, wordCuts: [...wordCuts, ...cleanup].sort((a, b) => a.w0 - b.w0), order, coldOpen, hookReplayed: false, estimatedS: estimateS(order), marked: [] };
}
