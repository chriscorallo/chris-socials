import { z } from "zod";
import { WatchFixSchema } from "@chris/media/timeline";
import type { ModelImageInput, ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";

/**
 * The watch-back gate's two model calls (docs/PREMIUM_EDITOR_PLAN.md round 2, built
 * 2026-10-22): one HIGH vision watch of the finished render against a checklist, with reference
 * frames at matching timestamps so it judges contrastively instead of flattering its own work,
 * returning at most five TYPED fixes; and one MEDIUM isolated hook test on the first frame and
 * the first two seconds of words. Prompts: /prompts/agents/WATCH_BACK.md, HOOK_TEST.md. Both
 * outputs are validated by zod; the deterministic job (apps/worker watch-back-job.ts) owns the
 * verdict's consequences.
 */
export const WATCH_CHECKS = ["HOOK_BY_1_5S", "STORY_READS", "NOTHING_COMPETES", "CUTS_INVISIBLE", "ENDING_SERVES", "LIKE_THE_REFERENCES"] as const;
export type WatchCheck = (typeof WATCH_CHECKS)[number];

const Evidence = z.array(z.object({ t: z.number().min(0), kind: z.enum(["SEEN", "SAID", "MEASURED"]), detail: z.string().min(1) })).min(1);

export const WatchChecklistItemSchema = z.object({
  check: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_") : v), z.enum(WATCH_CHECKS)),
  ok: z.boolean(),
  /** "n/a" when no reference frames were given (LIKE_THE_REFERENCES). */
  finding: z.string(),
  evidence: Evidence,
});

export const WatchVerdictSchema = z.object({
  verdict: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : v), z.enum(["PASS", "FIX", "HOLD"])),
  checklist: z.array(WatchChecklistItemSchema).min(1).max(8),
  fixes: z.array(WatchFixSchema).max(5).default([]),
  coldViewer: z.string().min(1),
  hook: z.object({
    firstFrameRead: z.string(),
    stopChancePct: z.number().min(0).max(100),
    rationale: z.string(),
  }),
  /** Where the references read as more human, when frames were given. */
  contrast: z.array(z.object({ t: z.number().min(0), reference: z.string(), ours: z.string() })).max(6).default([]),
});
export type WatchVerdict = z.infer<typeof WatchVerdictSchema>;

export const HookTestSchema = z.object({
  wouldKeepWatching: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : v), z.enum(["YES", "MAYBE", "NO"])),
  firstFrameRead: z.string(),
  why: z.string(),
  missing: z.string().nullable().default(null),
});
export type HookTest = z.infer<typeof HookTestSchema>;

export interface WatchFrame {
  t: number;
  reason: string;
  base64: string;
  mediaType: "image/jpeg" | "image/png";
}

export interface WatchBackInput {
  title: string | null;
  durationS: number;
  frames: WatchFrame[];
  /** Reference frames at the same fraction of their video's length, labelled. */
  referenceFrames: Array<WatchFrame & { ofS: number; referenceLabel: string }>;
  transcript: string;
  beats: Array<{ role: string; headline: string | null; viewerNeeds: string | null; start: number; end: number }>;
  screen: string;
  audits: Array<{ stage: string; kind: string; atS: number; detail: string }>;
  styleDigest: string[];
  cuts: Array<{ index: number; atS: number }>;
  brandContext: string;
  /** Set on the second watch: what was fixed since the first. */
  afterFixes?: string[] | null;
}

export interface WatchBackResult {
  verdict: WatchVerdict;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

const fmt = (t: number) => `${t.toFixed(1)}s`;

export function watchBackUserPrompt(input: WatchBackInput): string {
  const frames = input.frames.map((f) => `- ${fmt(f.t)} (${f.reason})`).join("\n");
  const refs = input.referenceFrames.length ? input.referenceFrames.map((f) => `- ours ${fmt(f.t)} ↔ ${f.referenceLabel} at ${fmt(f.ofS)}`).join("\n") : "(none — mark LIKE_THE_REFERENCES as n/a and ok)";
  return `## The video

Title: ${input.title ?? "(untitled)"}
Length: ${input.durationS.toFixed(1)} s
Cuts (index → output time): ${input.cuts.map((c) => `${c.index}@${fmt(c.atS)}`).join(", ") || "none"}
${input.afterFixes?.length ? `\nThis is the second watch. Fixed since the first: ${input.afterFixes.join("; ")}. Judge the result, not the history.\n` : ""}
## Frames you were given (in order; images follow the text)

${frames}

## Reference frames (contrastive pairs)

${refs}

## Transcript (what the viewer hears, with times)

${input.transcript}

## The Editor's beats

${input.beats.map((b) => `- ${fmt(b.start)}–${fmt(b.end)} ${b.role}${b.headline ? ` · headline "${b.headline}"` : ""}${b.viewerNeeds ? ` · needs: ${b.viewerNeeds}` : ""}`).join("\n") || "(no Editor plan — the free cut)"}

## The screen plan

${input.screen}

## The free audits found (measured, not opinions)

${input.audits.length ? input.audits.map((a) => `- ${a.stage} ${a.kind} at ${fmt(a.atS)}: ${a.detail}`).join("\n") : "(clean)"}

## What the references do (ranges)

${input.styleDigest.length ? input.styleDigest.map((l) => `- ${l}`).join("\n") : "(no references measured yet)"}

## Task

Answer the checklist with evidence, give the verdict, and name at most five typed fixes (stage, op, the element / sentence / cut id from above, why).`;
}

export async function runWatchBackAgent(provider: ModelProvider, input: WatchBackInput): Promise<WatchBackResult> {
  if (input.frames.length === 0) throw new Error("runWatchBackAgent needs at least one frame.");
  const { systemPrompt, modelClass } = buildSystemPrompt("WATCH_BACK");
  const images: ModelImageInput[] = [
    ...input.frames.map((f) => ({ base64: f.base64, mediaType: f.mediaType, label: `ours ${fmt(f.t)} (${f.reason})` })),
    ...input.referenceFrames.map((f) => ({ base64: f.base64, mediaType: f.mediaType, label: `reference ${f.referenceLabel} at ${fmt(f.ofS)} (pairs with ours ${fmt(f.t)})` })),
  ];
  const r = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext,
    userPrompt: watchBackUserPrompt(input),
    images,
    schema: WatchVerdictSchema,
    promptId: "WATCH_BACK",
  });
  return { verdict: r.output, model: r.model, inputTokens: r.inputTokens ?? null, outputTokens: r.outputTokens ?? null, latencyMs: r.latencyMs };
}

export async function runHookTestAgent(provider: ModelProvider, input: { firstFrame: WatchFrame; firstWords: string }): Promise<{ test: HookTest; model: string }> {
  const { systemPrompt, modelClass } = buildSystemPrompt("HOOK_TEST");
  const r = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: `## The first frame (image below)\n\n## The first two seconds, as heard\n\n"${input.firstWords || "(silence)"}"\n\n## Task\n\nWould you keep watching? Answer per your instructions.`,
    images: [{ base64: input.firstFrame.base64, mediaType: input.firstFrame.mediaType, label: "the first frame" }],
    schema: HookTestSchema,
    promptId: "HOOK_TEST",
  });
  return { test: r.output, model: r.model };
}

/** Pure: the verdict the deterministic rules allow. HOLD when more than five fixes or the hook
 * is dead on both reads; FIX when any fix; the model's PASS stands only with a clean checklist. */
export function settleVerdict(v: WatchVerdict, hook: HookTest | null, loop: number): WatchVerdict["verdict"] {
  const failing = v.checklist.filter((c) => !c.ok);
  const hookItem = v.checklist.find((c) => c.check === "HOOK_BY_1_5S");
  const hookDead = !!hookItem && !hookItem.ok && hook?.wouldKeepWatching === "NO";
  if (hookDead) return "HOLD";
  if (failing.length === 0 && v.fixes.length === 0) return "PASS";
  if (v.verdict === "HOLD") return "HOLD";
  if (loop >= 1) return "HOLD"; // the one loop is spent
  return v.fixes.length > 0 ? "FIX" : "HOLD";
}
