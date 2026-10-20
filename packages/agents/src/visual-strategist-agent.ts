import { z } from "zod";
import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";

/**
 * Visual strategist: understands the whole video (topic, theme, core message, takeaway) and
 * walks it as a cold viewer to decide WHERE a graphic would help them understand and WHAT
 * concept it should make click — before the Motion Designer picks templates. Viewer-first:
 * no visual unless the viewer needs it. Prompt: /prompts/agents/VISUAL_STRATEGIST.md.
 */
export const VISUAL_NEEDS = ["CONFUSION", "ABSTRACT_IDEA", "SCALE", "CAUSE_EFFECT", "COMPARISON", "PROCESS", "STAKES", "ATTENTION_DIP"] as const;

export const VisualBriefSchema = z.object({
  topic: z.string(),
  theme: z.string(),
  coreMessage: z.string(),
  viewerTakeaway: z.string(),
  viewer: z.string(),
  moments: z
    .array(
      z.object({
        start: z.number(),
        end: z.number(),
        need: z.enum(VISUAL_NEEDS),
        whyViewerNeedsIt: z.string(),
        concept: z.string(),
        visualIdea: z.string(),
        mustNotBe: z.string(),
      }),
    )
    .max(30),
  leaveClean: z.array(z.object({ start: z.number(), end: z.number(), why: z.string() })).max(20),
});
export type VisualBrief = z.infer<typeof VisualBriefSchema>;

/** The brief, cleaned: moments inside the video, in order, non-overlapping, at most one per ~5 s. */
export function sanitizeVisualBrief(brief: VisualBrief, durationS: number): VisualBrief {
  const maxMoments = Math.max(1, Math.floor(durationS / 4.5));
  const sorted = brief.moments
    .filter((m) => Number.isFinite(m.start) && Number.isFinite(m.end) && m.start >= 1.5 && m.start < durationS - 0.5)
    .map((m) => ({ ...m, end: Math.min(durationS, Math.max(m.end, m.start + 1.5)) }))
    .sort((a, b) => a.start - b.start);
  const moments: VisualBrief["moments"] = [];
  for (const m of sorted) {
    const prev = moments[moments.length - 1];
    if (prev && m.start < prev.end + 0.4) continue;
    moments.push(m);
  }
  return { ...brief, moments: moments.slice(0, maxMoments) };
}

export async function runVisualStrategistAgent(
  provider: ModelProvider,
  input: {
    transcript: string;
    durationS: number;
    title: string | null;
    brandContext: string;
    creativeBrief?: string | null;
    /** Graphics already on the timeline (the free edit's, built from numbers he said). */
    existing?: Array<{ start: number; end: number; name: string }> | null;
  },
): Promise<VisualBrief> {
  const { systemPrompt, modelClass } = buildSystemPrompt("VISUAL_STRATEGIST");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext,
    userPrompt: `## Video

Title: ${input.title ?? "(untitled)"}
Duration: ${input.durationS.toFixed(1)} s (every time you return is on this timeline)

## Timestamped transcript (what the viewer hears, one phrase per line)

${input.transcript}${input.creativeBrief ? `\n\n## Creative brief (the plan this video was made to)\n\n${input.creativeBrief}\n\nThe storyboard's opening frame, midpoint visual and payoff visual are the starting plan — keep them where the finished cut still supports them, place them at the moments they belong to, and still apply every viewer-first rule above (a planned visual the viewer doesn't need is dropped).` : ""}

${input.existing?.length ? `\n\n## Already on the timeline (the free edit's graphics — numbers he said)\n\n${input.existing.map((e) => `- ${e.start.toFixed(1)}–${e.end.toFixed(1)} s: ${e.name}`).join("\n")}\n\nThese stay. Plan a moment on one of these phrases only when your concept is deeper than the number itself (yours then replaces it); plan the rest of your moments where the viewer has nothing yet.` : ""}

## Task

Plan the visuals per your instructions: understand the whole video, then the viewer's moments.`,
    schema: VisualBriefSchema,
    promptId: "VISUAL_STRATEGIST",
  });
  return sanitizeVisualBrief(result.output, input.durationS);
}

/** The brief as the Motion Designer reads it. */
export function formatVisualBrief(brief: VisualBrief): string {
  const moments = brief.moments
    .map(
      (m, i) =>
        `${i + 1}. ${m.start.toFixed(2)}–${m.end.toFixed(2)} s · ${m.need}\n   Viewer: ${m.whyViewerNeedsIt}\n   Concept to make click: ${m.concept}\n   Visual idea: ${m.visualIdea}\n   Must not be: ${m.mustNotBe}`,
    )
    .join("\n");
  const clean = brief.leaveClean.map((c) => `- ${c.start.toFixed(1)}–${c.end.toFixed(1)} s: ${c.why}`).join("\n");
  return `Topic: ${brief.topic}
Underlying theme: ${brief.theme}
Core message: ${brief.coreMessage}
Viewer takeaway: ${brief.viewerTakeaway}
Viewer: ${brief.viewer}

Moments that need a visual (build these — and only these):
${moments || "(none — return no visuals)"}

Left clean on purpose:
${clean || "(nothing listed)"}`;
}
