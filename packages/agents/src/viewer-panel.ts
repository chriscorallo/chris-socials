import type { ModelProvider, ModelImageInput, ModelUsage } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { resolveModel } from "./providers/anthropic-provider";
import { computeCostUsd, usageFromTokens } from "./pricing";
import { ViewerReviewSchema, ENGAGEMENT_METRICS, type ViewerReview } from "./viewer-panel-schema";

export * from "./viewer-panel-schema";

/**
 * Viewer Panel (/prompts/agents/VIEWER_PANEL.md) — an AI first-time viewer watching one whole
 * video. This file holds the DETERMINISTIC halves around the one model call:
 *
 *  - planViewerFrames: which moments to show the model (dense in the hook, both sides of every
 *    cut, graphic/text changes, ~1 fps elsewhere), bounded by a frame cap;
 *  - estimateViewerReviewCost: the price BEFORE the call (shown to Chris on the button);
 *  - formatViewerFacts: the word-timed transcript + measured edit/audio facts as text;
 *  - checkViewerReview: post-checks (timestamps inside the video, sorted beats, certainty
 *    language flagged) — the model's output is advisory and never trusted blindly.
 *
 * ADVISORY ONLY. Nothing here feeds a hard gate; aggregateHardGates never sees a review.
 */

export type ViewerPlatform = "TIKTOK" | "INSTAGRAM" | "YOUTUBE";
export type ViewerPersona = "COLD" | "FOLLOWER";

export const VIEWER_PLATFORM_LABEL: Record<ViewerPlatform, string> = {
  TIKTOK: "TikTok For You feed",
  INSTAGRAM: "Instagram Reels feed",
  YOUTUBE: "YouTube Shorts feed",
};

// ---------------------------------------------------------------------------------------------
// Facts handed to the viewer (all measured or read from the edit — no model judgment)
// ---------------------------------------------------------------------------------------------

export interface ViewerWord {
  word: string;
  start: number;
  end: number;
}

export interface ViewerCut {
  t: number;
  /** PAUSE_REMOVED = a jump forward in the same take (a removed pause); FRAMING = same take,
   * contiguous, only the framing changed (punch-in/out); TAKE = a different take; DETECTED =
   * found by frame analysis on a finished file (kind unknown). */
  kind: "PAUSE_REMOVED" | "FRAMING" | "TAKE" | "DETECTED";
  /** Seconds of source removed at this cut (PAUSE_REMOVED only). */
  removedS?: number | null;
  /** Framing before → after (1 = wide). */
  zoomFrom?: number | null;
  zoomTo?: number | null;
}

export interface ViewerAudioFacts {
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  clipping: boolean;
  voiceLevelDb: number | null;
  backgroundLevelDb: number | null;
  /** Voice minus background (dB); null = no audible background. */
  backgroundUnderVoiceDb: number | null;
  background: "none" | "present" | "unknown";
  /** Loudness (dBFS RMS) per second, for the model to see swells/drops. */
  levelPerSecond: number[];
  /** Adjacent-second jumps ≥ 6 dB while someone is talking. */
  levelJumps: Array<{ t: number; fromDb: number; toDb: number }>;
  /** Level change across a cut (150 ms each side) ≥ 6 dB, with speech on both sides. */
  cutJumps: Array<{ t: number; deltaDb: number }>;
}

export interface ViewerReviewFacts {
  subject: "CHRIS_RENDER" | "REFERENCE_VIDEO";
  title: string | null;
  /** Reference videos: whose video it is (never Chris). */
  creatorName?: string | null;
  platform: ViewerPlatform;
  persona: ViewerPersona;
  durationS: number;
  width: number | null;
  height: number | null;
  words: ViewerWord[];
  /** Where the words came from ("edit transcript" / "Whisper on the file"). */
  wordsSource: string;
  talking: boolean;
  cuts: ViewerCut[];
  cutsSource: "EDIT" | "DETECTED";
  /** Output-timeline punch-ins / zooms (from the edit). */
  zooms: Array<{ start: number; end: number; zoom: number; mode: string }>;
  captions: { enabled: boolean; preset: string | null; uppercase: boolean } | null;
  texts: Array<{ text: string; start: number; end: number }>;
  graphics: Array<{ template: string; start: number; end: number; label: string | null }>;
  music: { present: boolean; levelDb: number | null; duckDb: number | null } | null;
  sfxCount: number | null;
  audio: ViewerAudioFacts | null;
  /** Chris's reference creators' measured style (medians), when known — the pacing target. */
  referenceStyle: {
    sampleSize: number;
    shotMedianS: number | null;
    firstCutS: number | null;
    wpm: number | null;
    gapP90S: number | null;
    hookDurationS: number | null;
    backgroundUnderVoiceDb: number | null;
  } | null;
  notes: string[];
}

// ---------------------------------------------------------------------------------------------
// Frame planning (pure)
// ---------------------------------------------------------------------------------------------

export type FrameReason = "FIRST" | "HOOK" | "LAST" | "BEFORE_CUT" | "AFTER_CUT" | "EVENT" | "SAMPLE";

export interface PlannedFrame {
  t: number;
  reason: FrameReason;
}

/** Which frames go first when over the cap (higher = dropped earlier). */
const PRIORITY: Record<FrameReason, number> = { FIRST: 0, HOOK: 0, LAST: 0, BEFORE_CUT: 1, AFTER_CUT: 1, EVENT: 2, SAMPLE: 3 };
/** Which label wins when two candidates collapse into one frame: a cut's side is the more
 * useful thing to tell the viewer than "opening" (it's still kept as an opening frame). */
const RANK: Record<FrameReason, number> = { FIRST: 0, LAST: 0, BEFORE_CUT: 1, AFTER_CUT: 1, HOOK: 2, EVENT: 3, SAMPLE: 4 };

export interface FramePlanOptions {
  /** Hard cap (the API accepts up to 100 images per request; keep headroom). */
  maxFrames: number;
  /** Spacing of the background samples. */
  sampleEveryS: number;
  /** Dense sampling of the opening, where scroll decisions happen. */
  hookTimes: number[];
  /** How far either side of a cut the before/after frames sit. */
  cutOffsetS: number;
  /** Two candidates closer than this collapse into one (the higher priority wins). */
  dedupeS: number;
}

export const DEFAULT_FRAME_PLAN: FramePlanOptions = {
  maxFrames: 80,
  sampleEveryS: 1,
  hookTimes: [0, 0.5, 1, 1.5, 2, 2.5, 3],
  cutOffsetS: 0.1,
  dedupeS: 0.12,
};

/**
 * Which moments of the video the viewer sees. Every frame is a real timestamp; the model is
 * told each one's reason ("just after a cut") so it can judge the cut, not just the shot.
 * Over the cap, the least important frames go first (background samples, then events, then
 * cut pairs), each time removing the one with the closest neighbour — coverage stays even.
 * The opening (hook), first and last frames are never dropped.
 */
export function planViewerFrames(
  input: { durationS: number; cutTimes: number[]; eventTimes?: number[] },
  options: Partial<FramePlanOptions> = {},
): PlannedFrame[] {
  const o = { ...DEFAULT_FRAME_PLAN, ...options };
  const d = input.durationS;
  if (!(d > 0)) return [];
  const last = Math.max(0, d - 0.05);
  const clamp = (t: number) => Math.round(Math.min(last, Math.max(0, t)) * 100) / 100;
  const cands: PlannedFrame[] = [{ t: 0, reason: "FIRST" }, { t: clamp(last), reason: "LAST" }];
  for (const h of o.hookTimes) if (h > 0 && h < d) cands.push({ t: clamp(h), reason: "HOOK" });
  for (const c of input.cutTimes) {
    if (!(c > 0 && c < d)) continue;
    cands.push({ t: clamp(c - o.cutOffsetS), reason: "BEFORE_CUT" }, { t: clamp(c + o.cutOffsetS), reason: "AFTER_CUT" });
  }
  for (const e of input.eventTimes ?? []) if (e >= 0 && e < d) cands.push({ t: clamp(e + 0.3), reason: "EVENT" });
  for (let t = o.sampleEveryS; t < d; t += o.sampleEveryS) cands.push({ t: clamp(t), reason: "SAMPLE" });

  // Dedupe: sort by time, then by label rank; a close pair collapses into one frame that keeps
  // the better label and the stronger protection of the two.
  cands.sort((a, b) => a.t - b.t || RANK[a.reason] - RANK[b.reason]);
  type Cand = PlannedFrame & { prio: number };
  const frames: Cand[] = [];
  for (const c of cands) {
    const prev = frames[frames.length - 1];
    if (prev && c.t - prev.t < o.dedupeS) {
      const prio = Math.min(prev.prio, PRIORITY[c.reason]);
      frames[frames.length - 1] = RANK[c.reason] < RANK[prev.reason] ? { ...c, prio } : { ...prev, prio };
      continue;
    }
    frames.push({ ...c, prio: PRIORITY[c.reason] });
  }

  const max = Math.max(3, Math.floor(o.maxFrames));
  while (frames.length > max) {
    const worst = Math.max(...frames.map((f) => f.prio));
    if (worst === 0) break;
    let pick = -1;
    let pickGap = Infinity;
    frames.forEach((f, i) => {
      if (f.prio !== worst) return;
      const gap = Math.min(i > 0 ? f.t - frames[i - 1]!.t : Infinity, i < frames.length - 1 ? frames[i + 1]!.t - f.t : Infinity);
      if (gap < pickGap) {
        pickGap = gap;
        pick = i;
      }
    });
    frames.splice(pick, 1);
  }
  return frames.map(({ t, reason }) => ({ t, reason }));
}

// ---------------------------------------------------------------------------------------------
// Cost estimate (pure) — shown to Chris BEFORE anything is called
// ---------------------------------------------------------------------------------------------

/** Long edge of every frame sent (px). 360×640 keeps burned-in captions legible. */
export const VIEWER_FRAME_LONG_EDGE = 640;

/** Frame size actually sent for a source of srcW×srcH (even numbers, never upscaled). */
export function viewerFrameSize(srcW: number | null, srcH: number | null, longEdge = VIEWER_FRAME_LONG_EDGE): { width: number; height: number } {
  const w = srcW && srcW > 0 ? srcW : 1080;
  const h = srcH && srcH > 0 ? srcH : 1920;
  const scale = Math.min(1, longEdge / Math.max(w, h));
  const even = (x: number) => Math.max(2, Math.round((x * scale) / 2) * 2);
  return { width: even(w), height: even(h) };
}

/** Anthropic's published image-token approximation: width × height / 750. */
export function imageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750);
}

/** System prompt (SYSTEM_BASE + VIEWER_PANEL) + task wrapper, measured from the files ÷ ~3.6 chars/token. */
export const VIEWER_PROMPT_TOKENS_ESTIMATE = 3_200;
/** Per-frame text label ("t=12.30s — just after a cut"). */
export const VIEWER_LABEL_TOKENS_PER_FRAME = 12;
/** The facts block besides the transcript (cuts, graphics, audio curve, reference style). */
export const VIEWER_FACTS_BASE_TOKENS = 1_200;
/** Transcript lines carry a timestamp every ~8 words: ≈ 1.7 tokens per spoken word. */
export const VIEWER_TOKENS_PER_WORD = 1.7;
/**
 * Output: the JSON (≈ 25 beats × ~110 tokens + checks, estimates, fixes ≈ 5–6k) plus adaptive
 * thinking at effort "high" (several thousand more). 12k is the planning figure; the range
 * shown is 0.6×–1.6× of it.
 */
export const VIEWER_OUTPUT_TOKENS_ESTIMATE = 12_000;

export interface ViewerCostEstimate {
  model: string;
  frames: number;
  frameWidth: number;
  frameHeight: number;
  imageTokens: number;
  textTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  lowUsd: number;
  highUsd: number;
}

export function estimateViewerReviewCost(input: {
  frames: number;
  frameWidth: number;
  frameHeight: number;
  wordCount: number;
  /** Characters of the facts block when already built (more precise than the base figure). */
  factsChars?: number;
  brandContextChars?: number;
  model?: string;
}): ViewerCostEstimate {
  const model = input.model ?? resolveModel("HIGH");
  const img = input.frames * imageTokens(input.frameWidth, input.frameHeight);
  const facts = input.factsChars != null ? Math.ceil(input.factsChars / 3.6) : VIEWER_FACTS_BASE_TOKENS + Math.ceil(input.wordCount * VIEWER_TOKENS_PER_WORD);
  const text = VIEWER_PROMPT_TOKENS_ESTIMATE + facts + input.frames * VIEWER_LABEL_TOKENS_PER_FRAME + Math.ceil((input.brandContextChars ?? 0) / 3.6);
  const inputTokens = img + text;
  const outputTokens = VIEWER_OUTPUT_TOKENS_ESTIMATE;
  const cost = (outTok: number) => computeCostUsd(model, usageFromTokens(inputTokens, outTok)) ?? 0;
  return {
    model,
    frames: input.frames,
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    imageTokens: img,
    textTokens: text,
    inputTokens,
    outputTokens,
    costUsd: cost(outputTokens),
    lowUsd: cost(Math.round(outputTokens * 0.6)),
    highUsd: cost(Math.round(outputTokens * 1.6)),
  };
}

/**
 * The estimate the video page shows before anything runs — the same frame plan the job will
 * build, from what's already known (length, the edit's cut times, graphic/text start times).
 */
export function estimateViewerReviewForVideo(input: {
  durationS: number;
  cutTimes: number[];
  eventTimes?: number[];
  width?: number | null;
  height?: number | null;
  /** Unknown → ~2.6 words a second (typical talking-head pace). */
  wordCount?: number | null;
  brandContextChars?: number;
  maxFrames?: number;
}): ViewerCostEstimate {
  const frames = planViewerFrames({ durationS: input.durationS, cutTimes: input.cutTimes, eventTimes: input.eventTimes }, input.maxFrames ? { maxFrames: input.maxFrames } : {});
  const size = viewerFrameSize(input.width ?? null, input.height ?? null);
  return estimateViewerReviewCost({
    frames: frames.length,
    frameWidth: size.width,
    frameHeight: size.height,
    wordCount: input.wordCount ?? Math.round(input.durationS * 2.6),
    brandContextChars: input.brandContextChars,
  });
}

/** "≈ $0.42" — rounded up to the cent, never shows $0.00 for a real call. */
export function formatEstimateUsd(usd: number): string {
  if (usd < 0.01) return "< $0.01";
  return `≈ $${(Math.ceil(usd * 100) / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------------------------
// Facts as text (pure)
// ---------------------------------------------------------------------------------------------

const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);

/** Groups words into short timed lines: a new line at a ≥ 0.5 s gap, sentence end, or 10 words. */
export function transcriptLines(words: ViewerWord[]): string[] {
  const lines: string[] = [];
  let cur: ViewerWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    lines.push(`[${f1(cur[0]!.start)}–${f1(cur[cur.length - 1]!.end)}] ${cur.map((w) => w.word.trim()).join(" ")}`);
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end >= 0.5 || cur.length >= 10 || /[.!?]["”']?$/.test(prev.word.trim()))) flush();
    cur.push(w);
  }
  flush();
  return lines;
}

const CUT_KIND: Record<ViewerCut["kind"], string> = {
  PAUSE_REMOVED: "jump cut (pause removed)",
  FRAMING: "framing change only (same moment, punch-in/out)",
  TAKE: "different take",
  DETECTED: "cut (detected from the picture)",
};

export function formatViewerFacts(facts: ViewerReviewFacts, frames: PlannedFrame[]): string {
  const out: string[] = [];
  const who =
    facts.subject === "REFERENCE_VIDEO"
      ? `A video by ${facts.creatorName ?? "another creator"} (a reference creator — NOT Chris).`
      : "Chris's own finished edit (the render that would be posted).";
  out.push(`## The video\n\n- ${who}`);
  if (facts.title) out.push(`- Working title (the viewer never sees this): ${facts.title}`);
  out.push(`- Length: ${f1(facts.durationS)} s${facts.width && facts.height ? ` · ${facts.width}×${facts.height}` : ""}`);
  out.push(`- Watched on: ${VIEWER_PLATFORM_LABEL[facts.platform]}`);
  out.push(
    facts.persona === "COLD"
      ? "- Viewer: a cold viewer scrolling the feed who has never seen this creator."
      : "- Viewer: an existing follower who already knows the creator.",
  );

  out.push(`\n## What is said (word timings, ${facts.wordsSource})\n`);
  if (!facts.talking || facts.words.length === 0) out.push("No talking — the soundtrack is music/sound only (or silent).");
  else out.push(transcriptLines(facts.words).join("\n"));

  out.push(`\n## Cuts (${facts.cutsSource === "EDIT" ? "exact, from the edit" : "detected from the picture — may miss subtle jump cuts"})\n`);
  if (facts.cuts.length === 0) out.push("None — one continuous shot.");
  else {
    const shots = [0, ...facts.cuts.map((c) => c.t), facts.durationS];
    const lens = shots.slice(1).map((t, i) => t - shots[i]!);
    const sorted = [...lens].sort((a, b) => a - b);
    out.push(`${facts.cuts.length} cuts · median shot ${f1(sorted[Math.floor(sorted.length / 2)] ?? 0)} s · shortest ${f1(sorted[0] ?? 0)} s · longest ${f1(sorted[sorted.length - 1] ?? 0)} s`);
    for (const c of facts.cuts) {
      const extra = [
        c.removedS ? `${f2(c.removedS)} s removed` : null,
        c.zoomFrom != null && c.zoomTo != null && c.zoomFrom !== c.zoomTo ? `framing ${f2(c.zoomFrom)}× → ${f2(c.zoomTo)}×` : null,
      ].filter(Boolean);
      out.push(`- ${f2(c.t)} s: ${CUT_KIND[c.kind]}${extra.length ? ` (${extra.join(", ")})` : ""}`);
    }
  }
  if (facts.zooms.length) {
    out.push("\nPunch-ins/zooms on top:");
    for (const z of facts.zooms) out.push(`- ${f1(z.start)}–${f1(z.end)} s: ${f2(z.zoom)}× (${z.mode === "EASE" ? "smooth push" : "instant"})`);
  }

  out.push("\n## On screen besides the speaker\n");
  if (facts.captions) out.push(`- Burned-in captions: ${facts.captions.enabled ? `on (${facts.captions.preset ?? "default"} style${facts.captions.uppercase ? ", uppercase" : ""})` : "off"}`);
  else out.push("- Captions: unknown (not from this app's edit) — judge from the frames.");
  if (facts.texts.length) for (const t of facts.texts) out.push(`- Text "${t.text.replace(/\s+/g, " ").slice(0, 120)}" ${f1(t.start)}–${f1(t.end)} s`);
  if (facts.graphics.length) for (const g of facts.graphics) out.push(`- Graphic: ${g.template.toLowerCase().replace(/_/g, " ")} ${f1(g.start)}–${f1(g.end)} s${g.label ? ` — "${g.label.slice(0, 120)}"` : ""}`);
  if (!facts.texts.length && !facts.graphics.length) out.push(facts.subject === "CHRIS_RENDER" ? "- No text overlays or graphics in the edit." : "- Overlays unknown — judge from the frames.");

  out.push("\n## Sound (measured)\n");
  if (facts.music) out.push(`- Music bed: ${facts.music.present ? `yes (bed ${facts.music.levelDb ?? "?"} dB vs the voice target, ducked ${facts.music.duckDb ?? "?"} dB under speech)` : "none"}`);
  if (facts.sfxCount != null) out.push(`- Sound effects: ${facts.sfxCount}`);
  const a = facts.audio;
  if (!a) out.push("- No audio measurements.");
  else {
    if (a.integratedLufs != null) out.push(`- Overall loudness ${f1(a.integratedLufs)} LUFS${a.truePeakDbtp != null ? `, true peak ${f1(a.truePeakDbtp)} dBTP` : ""}${a.clipping ? " — CLIPS at its loudest" : ""}`);
    if (a.background === "present" && a.backgroundUnderVoiceDb != null) out.push(`- Background sound sits ${f1(a.backgroundUnderVoiceDb)} dB under the voice${a.backgroundUnderVoiceDb < 12 ? " (close to the voice — can compete with it)" : ""}`);
    else if (a.background === "none") out.push("- No audible background under the voice.");
    if (a.levelJumps.length) out.push(`- Level jumps while talking: ${a.levelJumps.map((j) => `${f1(j.t)} s (${f1(j.fromDb)} → ${f1(j.toDb)} dB)`).join(", ")}`);
    else out.push("- No level jumps ≥ 6 dB between neighbouring seconds while talking.");
    if (a.cutJumps.length) out.push(`- Level change across a cut: ${a.cutJumps.map((j) => `${f2(j.t)} s (${j.deltaDb > 0 ? "+" : ""}${f1(j.deltaDb)} dB)`).join(", ")}`);
    if (a.levelPerSecond.length) out.push(`- Level per second (dBFS RMS): ${a.levelPerSecond.map((x) => Math.round(x)).join(" ")}`);
  }

  if (facts.referenceStyle && facts.referenceStyle.sampleSize > 0) {
    const r = facts.referenceStyle;
    const parts = [
      r.shotMedianS != null ? `a cut every ${f1(r.shotMedianS)} s` : null,
      r.firstCutS != null ? `first cut at ${f1(r.firstCutS)} s` : null,
      r.wpm != null ? `${Math.round(r.wpm)} words/min` : null,
      r.gapP90S != null ? `pauses under ${f2(r.gapP90S)} s` : null,
      r.hookDurationS != null ? `hook line ${f1(r.hookDurationS)} s` : null,
      r.backgroundUnderVoiceDb != null ? `music ${Math.round(r.backgroundUnderVoiceDb)} dB under the voice` : null,
    ].filter(Boolean);
    if (parts.length) out.push(`\n## The creator's chosen reference style (medians of ${r.sampleSize} measured videos — a pacing reference, not a rule)\n\n${parts.join(" · ")}`);
  }

  if (facts.notes.length) out.push(`\n## Notes\n\n${facts.notes.map((n) => `- ${n}`).join("\n")}`);

  out.push(`\n## Frames\n\n${frames.length} frames follow in time order, each labelled with its timestamp and why it was picked. They are NOT every frame: between them you know only the transcript and the facts above. Say so in limitations rather than guessing.`);
  return out.join("\n");
}

const FRAME_REASON_TEXT: Record<FrameReason, string> = {
  FIRST: "first frame",
  HOOK: "opening",
  LAST: "last frame",
  BEFORE_CUT: "just before a cut",
  AFTER_CUT: "just after a cut",
  EVENT: "text/graphic change",
  SAMPLE: "sample",
};

export function frameLabel(f: PlannedFrame): string {
  return `t=${f.t.toFixed(2)}s — ${FRAME_REASON_TEXT[f.reason]}`;
}

// ---------------------------------------------------------------------------------------------
// Post-checks (pure)
// ---------------------------------------------------------------------------------------------

/** Certainty / virality language the prompt forbids. Flagged (never silently kept as fact). */
export const CERTAINTY_RE = /\b(will (definitely |certainly |surely )?(go viral|blow up)|guaranteed?|100 ?% (chance|sure)|will get \d[\d,.]*\s*(k|m|views|followers)?|going viral for sure)\b/i;

export interface ViewerReviewCheck {
  review: ViewerReview;
  warnings: string[];
}

/**
 * Deterministic sanity pass on the model's review: timestamps clamped into the video,
 * judgments whose evidence is entirely outside the video dropped, beats sorted (start ≤ end),
 * fixes ordered by priority, certainty language flagged, thin beat coverage noted.
 */
export function checkViewerReview(raw: ViewerReview, input: { durationS: number }): ViewerReviewCheck {
  const d = input.durationS;
  const warnings: string[] = [];
  const clamp = (t: number) => Math.min(d, Math.max(0, t));
  const inside = (t: number) => t >= 0 && t <= d + 1;
  const evidenceOk = (ev: { t: number }[]) => ev.some((e) => inside(e.t));
  const cleanEv = <E extends { t: number }>(ev: E[]): E[] => ev.filter((e) => inside(e.t)).map((e) => ({ ...e, t: clamp(e.t) }));
  const keep = <T extends { evidence: { t: number }[] }>(list: T[], what: string): T[] =>
    list.filter((x) => {
      if (evidenceOk(x.evidence)) return true;
      warnings.push(`Dropped a ${what} whose evidence was outside the video.`);
      return false;
    });

  const r: ViewerReview = structuredClone(raw);
  r.verdict.evidence = cleanEv(r.verdict.evidence).length ? cleanEv(r.verdict.evidence) : r.verdict.evidence.map((e) => ({ ...e, t: clamp(e.t) }));
  r.hook = { ...r.hook, tEnd: clamp(r.hook.tEnd), evidence: r.hook.evidence.map((e) => ({ ...e, t: clamp(e.t) })) };
  r.beats = keep(r.beats, "beat")
    .map((b) => {
      const a = clamp(Math.min(b.tStart, b.tEnd));
      const z = clamp(Math.max(b.tStart, b.tEnd));
      return { ...b, tStart: a, tEnd: z, evidence: cleanEv(b.evidence) };
    })
    .sort((x, y) => x.tStart - y.tStart);
  r.dropOffs = keep(r.dropOffs, "drop-off moment").map((x) => ({ ...x, t: clamp(x.t), evidence: cleanEv(x.evidence) }));
  r.craft = keep(r.craft, "craft check").map((x) => ({ ...x, tStart: clamp(x.tStart), tEnd: x.tEnd == null ? null : clamp(x.tEnd), evidence: cleanEv(x.evidence) }));
  r.strengths = keep(r.strengths, "strength").map((x) => ({ ...x, t: clamp(x.t), evidence: cleanEv(x.evidence) }));
  r.fixes = keep(r.fixes, "fix")
    .map((x) => ({ ...x, tStart: clamp(x.tStart), tEnd: x.tEnd == null ? null : clamp(x.tEnd), evidence: cleanEv(x.evidence) }))
    .sort((x, y) => x.priority - y.priority)
    .slice(0, 5);
  r.story = {
    ...r.story,
    promiseClearAtS: r.story.promiseClearAtS == null ? null : clamp(r.story.promiseClearAtS),
    confusingJumps: keep(r.story.confusingJumps, "story jump").map((x) => ({ ...x, t: clamp(x.t), evidence: cleanEv(x.evidence) })),
  };
  for (const m of ENGAGEMENT_METRICS) {
    const e = r.engagement[m];
    const times = e.evidenceTimes.filter(inside).map(clamp);
    if (times.length === 0) warnings.push(`The ${m} estimate cited no moment inside the video.`);
    r.engagement[m] = { ...e, evidenceTimes: times };
  }

  if (r.beats.length === 0) warnings.push("No usable beats came back.");
  else {
    const covered = r.beats.reduce((s, b) => s + Math.max(0, b.tEnd - b.tStart), 0);
    if (d > 0 && covered / d < 0.5) warnings.push(`The beat timeline covers only ${Math.round((covered / d) * 100)}% of the video.`);
  }

  const texts = [
    r.verdict.headline,
    r.verdict.biggestReason,
    r.hook.why,
    ...ENGAGEMENT_METRICS.map((m) => r.engagement[m].rationale),
    ...r.fixes.map((x) => x.expectedEffect),
  ];
  if (texts.some((t) => CERTAINTY_RE.test(t))) warnings.push("Some wording sounded certain about results; every outcome here is an estimate.");
  return { review: r, warnings };
}

// ---------------------------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------------------------

export interface ViewerFrameImage extends PlannedFrame {
  base64: string;
  mediaType: "image/png" | "image/jpeg";
}

export interface ViewerPanelResult {
  review: ViewerReview;
  warnings: string[];
  model: string;
  usage: ModelUsage | null;
  latencyMs: number;
}

function buildUserPrompt(facts: ViewerReviewFacts, frames: PlannedFrame[], brandContext: string | null): string {
  const brand = brandContext
    ? `\n\n## The creator's brand (only to keep your FIXES in his voice — the viewer doesn't know any of this)\n\n${brandContext}`
    : "";
  return `${formatViewerFacts(facts, frames)}${brand}

## Task

Watch it as the viewer described above — the frames in order, with the words at their times and the sound as measured — and return the structured review. Every judgment cites what is on screen, said or heard at a timestamp. Engagement numbers are estimates with honest uncertainty, never forecasts of views. If it's genuinely strong, say so and keep the fixes few.`;
}

/**
 * One model call (HIGH class, vision): frames as base64 image blocks, each preceded by its
 * label. Returns the post-checked review plus usage for cost recording. Throws the provider's
 * typed errors (spend cap, refusal, truncation) unchanged — the job turns them into plain
 * English.
 */
export async function runViewerPanelAgent(
  provider: ModelProvider,
  input: { facts: ViewerReviewFacts; frames: ViewerFrameImage[]; brandContext?: string | null },
): Promise<ViewerPanelResult> {
  if (input.frames.length === 0) throw new Error("runViewerPanelAgent needs at least one frame.");
  const { systemPrompt, modelClass } = buildSystemPrompt("VIEWER_PANEL");
  const images: ModelImageInput[] = input.frames.map((f) => ({ base64: f.base64, mediaType: f.mediaType, label: frameLabel(f) }));
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input.facts, input.frames, input.brandContext ?? null),
    images,
    schema: ViewerReviewSchema,
    promptId: "VIEWER_PANEL",
  });
  const checked = checkViewerReview(result.output, { durationS: input.facts.durationS });
  return {
    review: checked.review,
    warnings: checked.warnings,
    model: result.model,
    usage: result.usage ?? (result.inputTokens != null && result.outputTokens != null ? usageFromTokens(result.inputTokens, result.outputTokens) : null),
    latencyMs: result.latencyMs,
  };
}

/** The user prompt text (for estimating input size precisely before the call). */
export function viewerUserPromptText(facts: ViewerReviewFacts, frames: PlannedFrame[], brandContext: string | null): string {
  return buildUserPrompt(facts, frames, brandContext);
}
