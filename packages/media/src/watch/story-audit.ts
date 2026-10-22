import type { EditorPlan } from "../full-edit/editor-plan";

/**
 * The free story audit (gate G1, docs/PREMIUM_EDITOR_PLAN.md round 2): the Editor's plan vs what
 * the cut actually plays. Every storyline line present, in the Editor's order; no kept line that
 * leans on a cut line ("so that's why…") without its referent; the cut ends on the Editor's
 * ENDING line. A finding names the stage (EDITOR) and the line. No model call. PURE.
 */
export type StoryFindingKind = "LINE_MISSING" | "ORDER_CHANGED" | "DEPENDENT_OPENER" | "ENDING_NOT_LAST";

export interface StoryFinding {
  kind: StoryFindingKind;
  stage: "EDITOR";
  sentenceId: number | null;
  detail: string;
}

const DEPENDENT_OPENER = /^(?:so that(?:'s| is)|that(?:'s| is) (?:why|how|where|the)|which (?:means|is why)|because of that|and that|this is why|that way|otherwise|the other one|the second one|in that case)\b/i;

export function auditStory(
  plan: EditorPlan,
  kept: Array<{ sentenceId: number; text: string }>,
  lines: Array<{ id: number; text: string }>,
): StoryFinding[] {
  const out: StoryFinding[] = [];
  const keptIds = kept.map((k) => k.sentenceId);
  const planIds = plan.storyline.map((e) => e.sentenceId);
  for (const id of planIds) if (!keptIds.includes(id)) out.push({ kind: "LINE_MISSING", stage: "EDITOR", sentenceId: id, detail: `line ${id} is in the Editor's cut but not in the video` });
  const present = planIds.filter((id) => keptIds.includes(id));
  const order = keptIds.filter((id) => present.includes(id));
  if (present.some((id, i) => order[i] !== id)) out.push({ kind: "ORDER_CHANGED", stage: "EDITOR", sentenceId: null, detail: `the lines play as ${order.join(", ")} but the Editor ordered ${present.join(", ")}` });
  const byId = new Map(lines.map((l) => [l.id, l.text]));
  kept.forEach((k, i) => {
    const text = (k.text || byId.get(k.sentenceId) || "").trim();
    if (!DEPENDENT_OPENER.test(text)) return;
    const prevSource = lines.filter((l) => l.id < k.sentenceId).pop();
    const prevPlayed = kept[i - 1]?.sentenceId ?? null;
    if (i === 0 || (prevSource && prevPlayed !== prevSource.id)) {
      out.push({ kind: "DEPENDENT_OPENER", stage: "EDITOR", sentenceId: k.sentenceId, detail: `line ${k.sentenceId} opens "${text.split(/\s+/).slice(0, 3).join(" ")}…" but what it answers (${prevSource ? `line ${prevSource.id}` : "nothing"}) does not play before it` });
    }
  });
  const ending = [...plan.storyline].reverse().find((e) => e.role === "ENDING") ?? null;
  const last = keptIds[keptIds.length - 1];
  if (ending && last != null && last !== ending.sentenceId) out.push({ kind: "ENDING_NOT_LAST", stage: "EDITOR", sentenceId: ending.sentenceId, detail: `the video ends on line ${last}, not the Editor's ENDING line ${ending.sentenceId}` });
  return out;
}
