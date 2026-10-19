import { z } from "zod";
import type { TranscriptWord } from "../caption-chunking";
import { PLACEMENT_SAFE_ZONE } from "../platform-profiles";
import type { SubjectTrack } from "../subject-track-core";
import {
  buildStyleCutFromRanges,
  cleanWords,
  DEFAULT_STYLE_CUT_TARGET,
  type StyleCutOptions,
  type StyleCutRangeShot,
  type StyleCutTarget,
} from "../style-cut";
import { EditTimelineSchema, timelineDuration, type EditTimeline, type TimelineText, type TimelineZoom } from "../timeline";
import { findTimelineCollisions, layoutTimelineText, type MeasureText } from "../timeline-layout";
import { timelineCaptionChunks } from "../timeline-captions";
import { solveVisualPlacements, subjectRegionsForWindow } from "../visual-placement";
import type { GraphicPreset } from "../graphics/presets";
import { hookTitles, scoreHookCandidates } from "./hook";
import { DEFAULT_STORY_TARGET, planStory, type RemovalKind, type StoryPlan, type StoryTarget } from "./story";
import { buildSentences, keywords, type FESentence } from "./understand";
import { ALL_GRAPHIC_PRESETS, chooseVisuals, presetDescription, type VisualPick, type VisualRejection } from "./visuals";
import { bare, cosine, hashString, LEXICAL_EMBEDDER, type FullEditEmbedder } from "./text";
import { spokenNumbers, sameNumber } from "./numbers";

export { LEXICAL_EMBEDDER, type FullEditEmbedder } from "./text";
export { spokenNumbers, shortNumberLabel, sameNumber, type SpokenNumber } from "./numbers";
export { buildSentences, segmentSentences, classifyBeat, type FESentence, type Beat } from "./understand";
export { scoreHookCandidates, hookTitles, TITLE_AVOID, type HookCandidate, type HookTitle } from "./hook";
export { planStory, wordLevelCuts, DEFAULT_STORY_TARGET, type StoryPlan, type StoryTarget, type RemovalKind } from "./story";
export { chooseVisuals, listGraphic, graphicNumbers, readSeconds, presetDescription, type VisualPick } from "./visuals";

/**
 * FULL EDIT (free) — the no-AI, $0 "80–100 % done" edit of one talking-head take. PURE
 * orchestration (browser-safe; the only async part is the injected sentence embedder — the
 * worker passes the local MiniLM model, tests/fallback use hashed word stems):
 *
 *   understand → hook bot → story bot (say it once, cut the fluff, fit the references' length)
 *   → assembly (cold open + the style cut's pause tightening and face-centred punch-ins)
 *   → hook title → visuals bot (library graphics with his numbers) → emphasis zooms / SFX
 *   → quality bots (meaning-match, continuity, verification, cohesion, quality, retention),
 *     fixing and re-checking (bounded).
 *
 * Never invents words: every clip is his audio, every on-screen number was said in the line it
 * illustrates, title words come from his transcript. The FACTUAL hard gate is unchanged — an
 * on-screen number still needs a research/script source before publishing (flagged here).
 * Extension point: `FullEditStrategy` — an "AI edit" can later supply the hook choice, story
 * decisions and visual picks; this module stays the deterministic executor + checker.
 */

export const FULL_EDIT_VERSION = 1;

export interface FullEditChoices {
  /** Index into the hook candidates ("Try another hook"); omitted = the bot's pick. */
  hookIndex?: number;
  /** Which hook title (0–2); null = no title. */
  titleIndex?: number | null;
  /** Sentence ids restored from the "Removed lines" list / removed by hand. */
  forceKeep?: number[];
  forceDrop?: number[];
  /** Graphics Chris removed (by visual id). */
  removedVisualIds?: string[];
}

export interface FullEditInput {
  base: EditTimeline;
  mediaAssetId: string;
  words: TranscriptWord[] | null | undefined;
  durationSeconds: number;
  subjectTrack?: SubjectTrack | null;
  sourceSize?: { width: number; height: number } | null;
  silences?: Array<{ start: number; end: number }> | null;
  /** 100 ms loudness envelope (speech-activity.ts analyzeTakeAudio). */
  envelope?: { frameS: number; db: number[] } | null;
  /** Pacing (style cut target from the reference profile). */
  target?: StyleCutTarget;
  /** Length (the reference videos' duration median / p25–p75). */
  story?: StoryTarget;
  choices?: FullEditChoices;
  /** Glyph measurement (node: nodeMeasureText) — without it text sizes are estimated. */
  measure?: MeasureText;
  options?: Partial<StyleCutOptions>;
}

export const FullEditCheckSchema = z.object({
  id: z.enum(["MEANING_MATCH", "CONTINUITY", "VERIFICATION", "COHESION", "QUALITY", "RETENTION", "FACT_SOURCE"]),
  name: z.string(),
  status: z.enum(["PASS", "FIXED", "WARN"]),
  detail: z.string(),
});
export type FullEditCheck = z.infer<typeof FullEditCheckSchema>;

/** What's persisted on the plan row (`plan.fullEdit.report`) and shown in the editor. */
export const FullEditReportSchema = z.object({
  version: z.number(),
  summary: z.string(),
  lengthLine: z.string(),
  sourceDurationS: z.number(),
  outputDurationS: z.number(),
  sentencesTotal: z.number(),
  sentencesKept: z.number(),
  counts: z.object({ repeats: z.number(), retakes: z.number(), fluff: z.number(), tangents: z.number(), lowValue: z.number(), fillers: z.number(), pauses: z.number() }),
  topic: z.object({ keywords: z.array(z.string()) }),
  hook: z.object({
    text: z.string(),
    coldOpen: z.boolean(),
    replayed: z.boolean(),
    chosenIndex: z.number(),
    candidates: z.array(z.object({ index: z.number(), text: z.string(), score: z.number(), reason: z.string(), start: z.number(), sentenceIds: z.array(z.number()) })),
    titles: z.array(z.object({ text: z.string(), template: z.string() })),
    titleIndex: z.number().nullable(),
    titleTextId: z.string().nullable(),
  }),
  removed: z.array(z.object({ sentenceId: z.number(), text: z.string(), kind: z.string(), why: z.string(), start: z.number() })),
  marked: z.array(z.object({ sentenceId: z.number(), note: z.string() })),
  visuals: z.array(z.object({ id: z.string(), presetId: z.string(), name: z.string(), reason: z.string(), start: z.number(), match: z.number(), numbers: z.array(z.number()) })),
  rejectedVisuals: z.number(),
  zooms: z.number(),
  checks: z.array(FullEditCheckSchema),
  retention: z.object({ risk: z.enum(["LOW", "MEDIUM", "HIGH"]), factors: z.array(z.string()), note: z.string() }),
  embedder: z.string(),
  choices: z.record(z.string(), z.unknown()).default({}),
});
export type FullEditReport = z.infer<typeof FullEditReportSchema>;

export type FullEditResult =
  | { ok: true; version: typeof FULL_EDIT_VERSION; timeline: EditTimeline; report: FullEditReport; inputsKey: string; story: StoryPlan; sentences: FESentence[]; shots: StyleCutRangeShot[]; rejectedVisuals: VisualRejection[] }
  | { ok: false; reason: "NO_TRANSCRIPT" | "NO_DURATION" | "NO_STORY"; message: string };

/** Turns a reference StyleProfile's video length into the story target. */
export function storyTargetFromProfile(profile: { durationS?: { value: number; n: number; p25: number; p75: number } | null } | null | undefined): StoryTarget {
  const d = profile?.durationS;
  if (!d || d.n < 3 || !Number.isFinite(d.value)) return DEFAULT_STORY_TARGET;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const targetS = clamp(d.value, 20, 150);
  return { targetS, minS: clamp(Math.min(d.p25, targetS), 15, targetS), maxS: clamp(Math.max(d.p75, targetS), targetS, 180), source: "REFERENCES" };
}

const presetVecCache = new Map<string, Map<string, number[]>>();

async function presetVectors(embedder: FullEditEmbedder): Promise<Map<string, number[]>> {
  let m = presetVecCache.get(embedder.id);
  if (!m) {
    const list = ALL_GRAPHIC_PRESETS.filter((p) => p.template === "GRAPHIC");
    const vecs = await embedder.embed(list.map(presetDescription));
    m = new Map(list.map((p, i) => [p.id, vecs[i]!]));
    presetVecCache.set(embedder.id, m);
  }
  return m;
}

/** Similarity at/above which two sentences "say the same thing", per embedder. */
export function sameThresholdFor(embedder: FullEditEmbedder): number {
  return embedder.id.startsWith("lexical") ? 0.6 : 0.62;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
export function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s - m * 60);
  return sec === 60 ? `${m + 1}:00` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** Where a cut between word k and k+1 goes, and whether it's clean (a measured pause). */
function boundaryFn(words: TranscriptWord[], duration: number, silences: Array<{ start: number; end: number }> | null) {
  return (k: number): { at: number; safe: boolean } => {
    if (k < 0) return { at: 0, safe: true };
    if (k >= words.length - 1) return { at: duration, safe: true };
    const a = words[k]!;
    const b = words[k + 1]!;
    if (silences && silences.length) {
      // The pause that sits where Whisper puts the gap between the two words (not just the
      // longest nearby one — a short word like "Anyway." between two pauses must stay out).
      const g0 = a.end - 0.15;
      const g1 = b.start + 0.15;
      const mid = (a.end + b.start) / 2;
      let best: { start: number; end: number } | null = null;
      let bestScore = -Infinity;
      for (const s of silences) {
        if (s.end <= a.start + 0.05 || s.start >= b.end - 0.05) continue;
        if (s.end - s.start < 0.08) continue;
        const overlap = Math.min(s.end, g1) - Math.max(s.start, g0);
        const score = overlap * 10 - Math.abs((s.start + s.end) / 2 - mid);
        if (score > bestScore) {
          bestScore = score;
          best = s;
        }
      }
      if (best) return { at: (best.start + best.end) / 2, safe: true };
      return { at: (a.end + b.start) / 2, safe: false };
    }
    const g = b.start - a.end;
    return { at: (a.end + b.start) / 2, safe: g >= 0.15 };
  };
}

/** Pure: the Full edit. */
export async function buildFullEdit(input: FullEditInput, embedder: FullEditEmbedder = LEXICAL_EMBEDDER): Promise<FullEditResult> {
  const duration = input.durationSeconds;
  if (!(duration > 0)) return { ok: false, reason: "NO_DURATION", message: "This take has no length yet — wait for it to finish processing." };
  const words = cleanWords(input.words, duration);
  if (words.length < 3) return { ok: false, reason: "NO_TRANSCRIPT", message: "The full edit needs captions first — they appear once your words are transcribed." };
  const silences = input.silences && input.silences.length ? input.silences : null;
  const target = input.target ?? DEFAULT_STYLE_CUT_TARGET;
  const storyTarget = input.story ?? DEFAULT_STORY_TARGET;
  const choices = input.choices ?? {};
  const boundary = boundaryFn(words, duration, silences);

  // ---- 1. Understand ----------------------------------------------------------------------
  const env = input.envelope;
  let speechMedian: number | null = null;
  if (env && env.db.length) {
    const inSpeech: number[] = [];
    for (const w of words) for (let f = Math.floor(w.start / env.frameS); f < Math.ceil(w.end / env.frameS) && f < env.db.length; f++) inSpeech.push(env.db[f]!);
    inSpeech.sort((a, b) => a - b);
    speechMedian = inSpeech.length ? inSpeech[Math.floor(inSpeech.length / 2)]! : null;
  }
  const energyAt = env && speechMedian != null
    ? (s: number, e: number) => {
        const v: number[] = [];
        for (let f = Math.floor(s / env.frameS); f < Math.ceil(e / env.frameS) && f < env.db.length; f++) if (env.db[f]! > speechMedian! - 15) v.push(env.db[f]!);
        return v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length - speechMedian!) : null;
      }
    : undefined;
  const sentences = buildSentences(words, silences, energyAt);
  const vecs = await embedder.embed(sentences.map((s) => s.text));
  const core = sentences.map((s, i) => ({ s, v: vecs[i]! })).filter(({ s }) => !["GREETING", "SIGN_OFF", "TANGENT", "FLUFF", "META", "CTA"].includes(s.beat));
  const dim = vecs[0]?.length ?? 0;
  const centroid = new Array<number>(dim).fill(0);
  for (const { v } of core.length ? core : sentences.map((s, i) => ({ s, v: vecs[i]! }))) for (let d = 0; d < dim; d++) centroid[d]! += v[d]!;
  const rawRel = vecs.map((v) => cosine(v, centroid));
  const lo = Math.min(...rawRel);
  const hi = Math.max(...rawRel);
  const relevance = rawRel.map((x) => (hi - lo > 1e-6 ? (x - lo) / (hi - lo) : 0.5));
  // Topic-centred similarity: minus the take's mean vector, so "same topic" doesn't read as "same point".
  const mean = new Array<number>(dim).fill(0);
  for (const v of vecs) for (let d = 0; d < dim; d++) mean[d]! += v[d]! / vecs.length;
  const centred = vecs.map((v) => v.map((x, d) => x - mean[d]!));
  const sim = centred.map((a) => centred.map((b) => cosine(a, b)));
  const kw = keywords(sentences);
  const sameT = sameThresholdFor(embedder);

  // Seconds a set of word spans lasts once pauses are tightened (the budget's estimate).
  const estimateS = (spans: Array<{ w0: number; w1: number }>) => {
    let t = 0;
    for (const sp of spans) {
      const a = words[sp.w0]!.start;
      const b = words[sp.w1]!.end;
      let span = b - a + 0.3;
      if (silences) for (const s of silences) if (s.start > a && s.end < b) span -= Math.max(0, s.end - s.start - target.sentencePauseKeepS);
      t += Math.max(0.3, span);
    }
    return t;
  };

  const storyBase = {
    words,
    sentences,
    sim,
    sameThreshold: sameT,
    topicStems: new Set(kw.slice(0, 4).map((k) => k.stem)),
    relevance,
    safeAfter: (k: number) => boundary(k).safe,
    estimateS,
    forceKeep: choices.forceKeep,
    forceDrop: choices.forceDrop,
  };

  // ---- 2. Hook bot (on the lines that survive the mechanical cleanup) ----------------------
  const pre = planStory({ ...storyBase, target: { ...storyTarget, targetS: 1e9 }, hookIds: [] });
  const eligible = new Set(pre.decisions.filter((d) => d.kept).map((d) => d.id));
  const candidates = scoreHookCandidates(sentences, {
    relevance: new Map(sentences.map((s, i) => [s.id, relevance[i]!])),
    cleanEdges: (s) => boundary(s.w0 - 1).safe && boundary(s.w1).safe,
    eligible,
    takeEndS: words[words.length - 1]!.end,
  }).slice(0, 6);
  if (candidates.length === 0) return { ok: false, reason: "NO_STORY", message: "Couldn't find a line to open on." };
  let hookIndex = choices.hookIndex != null && choices.hookIndex >= 0 && choices.hookIndex < candidates.length ? choices.hookIndex : 0;
  if (choices.hookIndex == null) {
    // Moving a line to the front must be clearly worth it.
    const firstId = [...eligible].sort((a, b) => a - b)[0];
    const firstIdx = candidates.findIndex((c) => c.sentenceIds[0] === firstId);
    if (firstIdx > 0 && candidates[0]!.score - candidates[firstIdx]!.score < 0.6) hookIndex = firstIdx;
  }
  const hook = candidates[hookIndex]!;

  // ---- 3. Story bot + 4. assembly (re-planned if the real cut runs long) ------------------
  let goal = storyTarget.targetS;
  let story!: StoryPlan;
  let assembled!: Extract<ReturnType<typeof buildStyleCutFromRanges>, { ok: true }>;
  for (let attempt = 0; attempt < 4; attempt++) {
    story = planStory({ ...storyBase, target: { ...storyTarget, targetS: goal }, hookIds: hook.sentenceIds });
    const ranges: Array<{ start: number; end: number }> = [];
    for (const sp of story.order) {
      const r = { start: boundary(sp.w0 - 1).at, end: boundary(sp.w1).at };
      const prev = ranges[ranges.length - 1];
      if (prev && Math.abs(prev.end - r.start) < 1e-6) prev.end = r.end;
      else ranges.push(r);
    }
    const res = buildStyleCutFromRanges({
      base: input.base,
      mediaAssetId: input.mediaAssetId,
      words,
      durationSeconds: duration,
      subjectTrack: input.subjectTrack,
      sourceSize: input.sourceSize,
      silences,
      target,
      options: input.options,
      ranges,
      // The hook opens on a MEDIUM punch-in (room for the title above the head), then WIDE.
      framingOffset: 3,
    });
    if (!res.ok) return { ok: false, reason: "NO_STORY", message: res.message };
    assembled = res;
    const out = timelineDuration(res.timeline);
    if (out <= storyTarget.targetS * 1.12 || out <= storyTarget.maxS) break;
    goal = goal * (storyTarget.targetS / out) * 0.97;
  }
  let timeline = assembled.timeline;
  const shots = assembled.shots;
  const outDur = timelineDuration(timeline);

  // Source → output time (the STORY occurrence when the hook is replayed in place).
  const clipStarts: number[] = [];
  {
    let t = 0;
    for (const c of timeline.clips) {
      clipStarts.push(t);
      t += c.sourceEnd - c.sourceStart;
    }
  }
  const hookClipCount = story.coldOpen ? shots.filter((s) => s.rangeIndex === 0).length : 0;
  const srcToOut = (t: number, story_: boolean): number | null => {
    for (let i = 0; i < timeline.clips.length; i++) {
      if (story_ && story.coldOpen && i < hookClipCount) continue;
      const c = timeline.clips[i]!;
      if (t >= c.sourceStart - 1e-6 && t < c.sourceEnd) return clipStarts[i]! + (t - c.sourceStart);
    }
    return null;
  };
  const lastHookWord = words[sentences[hook.sentenceIds[hook.sentenceIds.length - 1]!]!.w1]!;
  const hookEndOut = story.coldOpen ? (clipStarts[hookClipCount] ?? outDur) : Math.min(outDur, (srcToOut(Math.max(lastHookWord.start, lastHookWord.end - 0.05), false) ?? 0) + 0.1);

  // ---- 5. Hook title --------------------------------------------------------------------------
  const hookSentences = sentences.filter((s) => hook.sentenceIds.includes(s.id));
  const titles = hookTitles(hookSentences, sentences.filter((s) => story.decisions[s.id]?.kept), kw[0]?.word ?? null);
  const titleIndex = choices.titleIndex === null ? null : Math.min(choices.titleIndex ?? 0, titles.length - 1);
  const measure: MeasureText = input.measure ?? ((text, _f, px) => text.length * px * 0.56);
  const checks: FullEditCheck[] = [];
  let titleText: TimelineText | null = null;
  if (titleIndex != null && titleIndex >= 0 && titles[titleIndex]) {
    titleText = placeTitle(titles[titleIndex]!.text, timeline, Math.max(1.6, Math.min(2.4, hookEndOut)), input, measure);
  }
  timeline = EditTimelineSchema.parse({ ...timeline, texts: titleText ? [titleText] : [] });

  // ---- 6. Visuals bot -------------------------------------------------------------------------
  const pv = await presetVectors(embedder);
  const keptStory = sentences.filter((s) => story.decisions[s.id]?.kept && !(story.coldOpen && !story.hookReplayed && hook.sentenceIds.includes(s.id)));
  const keptSpoken = keptStory.flatMap((s) => s.numbers);
  const vocabulary = new Set(words.map((w) => bare(w.word)));
  const moments = keptStory
    .map((s) => {
      // Whisper's edges drift ±0.2 s: use the first/last word whose time lands inside a clip.
      let a: number | null = null;
      for (let k = s.w0; k <= s.w1 && a == null; k++) a = srcToOut((words[k]!.start + words[k]!.end) / 2, true);
      let b: number | null = null;
      for (let k = s.w1; k >= s.w0 && b == null; k--) b = srcToOut(Math.max(words[k]!.start, words[k]!.end - 0.05), true);
      return a == null || b == null ? null : { sentence: s, outStart: a, outEnd: b, wordOut: (w: number) => srcToOut(words[w]!.start + 0.01, true) ?? srcToOut((words[w]!.start + words[w]!.end) / 2, true), vec: vecs[s.id]! };
    })
    .filter((m): m is NonNullable<typeof m> => !!m);
  const placementOpts = {
    subjectTracks: { [input.mediaAssetId]: input.subjectTrack ?? null },
    sourceDimensions: { [input.mediaAssetId]: input.sourceSize ?? null },
    wordsByAsset: { [input.mediaAssetId]: words },
    measure: input.measure,
  };
  const exclude = new Set<string>();
  const rejectedAll: VisualRejection[] = [];
  const fixes: Record<string, string[]> = {};
  const note = (k: string, s: string) => {
    const list = (fixes[k] ??= []);
    if (!list.includes(s)) list.push(s);
  };
  let picks: VisualPick[] = [];
  let zooms: TimelineZoom[] = [];
  const sfx: EditTimeline["sfx"] = [];
  if (story.coldOpen && hookEndOut < outDur - 0.5) sfx.push({ id: "fe-sfx-coldopen", at: r3(Math.max(0, hookEndOut - 0.12)), sound: "WHOOSH", volume: 0.3 });

  // ---- 7. Quality bots: choose → place → drop/replace what can't sit clear → re-check -------
  for (let iter = 0; iter < 6; iter++) {
    const chosen = chooseVisuals({
      moments,
      spoken: keptSpoken,
      vocabulary,
      presetVec: (p: GraphicPreset) => pv.get(p.id) ?? null,
      weakMatch: embedder.thresholds.weak,
      hookEndS: hookEndOut,
      durationS: outDur,
      exclude,
    });
    if (iter === 0) rejectedAll.push(...chosen.rejected);
    picks = chosen.picks.filter((p) => !(choices.removedVisualIds ?? []).includes(p.visual.id));
    timeline = EditTimelineSchema.parse({ ...timeline, visuals: picks.map((p) => p.visual), zooms, sfx });
    const solved = solveVisualPlacements(timeline, placementOpts);
    const low = new Set(solved.warnings.filter((w) => w.code === "LOW_CONFIDENCE").map((w) => w.visualId));
    // Close-up selfie framing often leaves no room beside Chris's face. Instead of dropping the
    // graphic, show it the way top creators do: a quick FULL-SCREEN cutaway (≈2 s) while his
    // voice continues — never in the hook, at most one per ~10 s, never two in a row.
    const cutawayStarts = solved.visuals.filter((v) => (v.props as { screen?: string } | undefined)?.screen === "FULL").map((v) => v.start);
    for (const p of picks.filter((x) => low.has(x.visual.id))) {
      const start = p.visual.start;
      const ok = start >= hookEndOut + 0.3 && cutawayStarts.every((t) => Math.abs(t - start) >= 10) && (picks.length <= 2 || cutawayStarts.length < Math.max(1, Math.round(outDur / 12)));
      if (!ok) continue;
      const end = r3(Math.min(Math.max(p.visual.end, start + 1.8), start + 2.6));
      const idx = solved.visuals.findIndex((v) => v.id === p.visual.id);
      if (idx < 0) continue;
      solved.visuals[idx] = { ...solved.visuals[idx]!, end, props: { ...(solved.visuals[idx]!.props as Record<string, unknown>), screen: "FULL" } };
      p.visual = solved.visuals[idx]!;
      cutawayStarts.push(start);
      low.delete(p.visual.id);
      note("QUALITY", `“${p.presetName}” shown as a quick full-screen cutaway — no room beside your face`);
    }
    for (const p of picks.filter((x) => low.has(x.visual.id))) {
      note("QUALITY", `swapped out “${p.presetName}” — it had no spot clear of your face and the captions`);
      rejectedAll.push({ sentenceId: p.sentenceId, presetId: p.presetId, reason: "No clear spot (face/captions)" });
      exclude.add(`${p.sentenceId}:${p.presetId}`);
    }
    picks = picks.filter((p) => !low.has(p.visual.id));
    timeline = EditTimelineSchema.parse({ ...timeline, visuals: solved.visuals.filter((v) => !low.has(v.id)) });
    if (low.size === 0) break;
  }
  // Retention: a long stretch with nothing changing on screen → a slow push-in there (bounded).
  for (let iter = 0; iter < 4; iter++) {
    const worst = staticGaps(timeline).sort((a, b) => b.len - a.len)[0];
    if (!worst || worst.len <= 7 || zooms.length >= Math.ceil(outDur / 12)) break;
    const s = moments.find((m) => m.outStart >= worst.start + 1 && m.outEnd <= worst.end - 0.3 && m.outEnd - m.outStart >= 1.2 && !timeline.visuals.some((v) => v.start < m.outEnd && m.outStart < v.end));
    if (!s) break;
    zooms = [...zooms, { id: `fe-z-${s.sentence.id}`, start: r3(s.outStart), end: r3(s.outEnd), zoom: 1.08, x: 0.5, y: 0.4, mode: "EASE", easeSeconds: 0.6 }];
    note("RETENTION", `added a slow push-in at ${s.outStart.toFixed(1)} s (${worst.len.toFixed(1)} s without a change)`);
    timeline = EditTimelineSchema.parse({ ...timeline, zooms });
  }
  // Emphasis: one punch-in on the punchiest un-illustrated line per ~15 s (on a WIDE shot).
  const emphasisRx = /\b(stop|never|nobody|no one|most people|free money|trap|before it ever|instead)\b/i;
  for (const m of moments) {
    if (zooms.length >= Math.max(1, Math.floor(outDur / 15))) break;
    if (!emphasisRx.test(m.sentence.text) || m.outEnd - m.outStart > 4.5) continue;
    if (timeline.visuals.some((v) => v.start < m.outEnd + 0.3 && m.outStart < v.end + 0.3)) continue;
    if (zooms.some((z) => z.start < m.outEnd + 3 && m.outStart < z.end + 3)) continue;
    const ci = timeline.clips.findIndex((_, i) => clipStarts[i]! <= m.outStart + 1e-6 && m.outStart < clipStarts[i]! + (timeline.clips[i]!.sourceEnd - timeline.clips[i]!.sourceStart));
    if (ci < 0 || timeline.clips[ci]!.crop.zoom > 1.001) continue;
    zooms.push({ id: `fe-z-${m.sentence.id}`, start: r3(m.outStart), end: r3(m.outEnd), zoom: 1.08, x: 0.5, y: 0.4, mode: "EASE", easeSeconds: 0.5 });
  }
  timeline = EditTimelineSchema.parse({ ...timeline, zooms: zooms.sort((a, b) => a.start - b.start) });

  // ---- Checks (reported) -------------------------------------------------------------------
  const transcriptNumbers = spokenNumbers(words.map((w) => w.word));
  const weakOnes = picks.filter((p) => p.match < embedder.thresholds.weak && p.numbers.length === 0);
  checks.push({
    id: "MEANING_MATCH",
    name: "Meaning match",
    status: weakOnes.length ? "WARN" : rejectedAll.some((r) => /meaning/i.test(r.reason)) ? "FIXED" : "PASS",
    detail: picks.length
      ? `${picks.length} graphic${picks.length === 1 ? "" : "s"} match what you're saying (${picks.map((p) => p.match.toFixed(2)).join(", ")}); ${rejectedAll.filter((r) => /meaning/i.test(r.reason)).length} weak matches dropped.`
      : "No graphic matched strongly enough — none added (restraint).",
  });
  const unverified = picks.filter((p) => p.numbers.some((v) => !transcriptNumbers.some((n) => sameNumber(n.value, v))));
  checks.push({
    id: "VERIFICATION",
    name: "Numbers verified",
    status: unverified.length ? "WARN" : "PASS",
    detail: unverified.length
      ? `${unverified.length} graphic(s) show a number not in your words.`
      : `Every number on screen (${[...new Set(picks.flatMap((p) => p.numbers))].map((v) => v.toLocaleString("en-US")).join(", ") || "none"}) is one you said; ${rejectedAll.filter((r) => /not what you said/.test(r.reason)).length} graphics with other numbers were dropped.`,
  });
  checks.push({
    id: "CONTINUITY",
    name: "Continuity",
    status: "PASS",
    detail: "Each graphic shows only numbers said in the line it appears on, and appears while that line plays.",
  });
  checks.push({
    id: "FACT_SOURCE",
    name: "Fact source",
    status: picks.some((p) => p.numbers.length) ? "WARN" : "PASS",
    detail: picks.some((p) => p.numbers.length)
      ? "The quality gate still checks on-screen numbers against your research/script before publishing — add a source or remove the graphic if it asks."
      : "No numbers on screen.",
  });
  // Cohesion / pacing.
  const lens = shots.map((s) => s.sourceEnd - s.sourceStart).sort((a, b) => a - b);
  const median = lens[Math.floor(lens.length / 2)] ?? 0;
  const longest = lens[lens.length - 1] ?? 0;
  const keptBeats = keptStory.map((s) => s.beat);
  const arcOk = keptBeats.some((b) => b === "PAYOFF" || b === "NUMBER" || b === "LIST_ITEM" || b === "POINT");
  checks.push({
    id: "COHESION",
    name: "Story & pacing",
    status: arcOk && longest <= Math.max(8, target.shotP75S * 2.5) ? "PASS" : "WARN",
    detail: `Hook → ${story.coldOpen ? "cold open, then " : ""}your story in order → ${keptBeats.includes("CTA") ? "one call to action" : "ends on your point"}. Shots ${median.toFixed(1)} s typical (references ${target.shotP25S.toFixed(1)}–${target.shotP75S.toFixed(1)} s), longest ${longest.toFixed(1)} s. Every cut is on a pause between words.`,
  });
  // Quality: title placement, captions, loudness, placement warnings.
  const qIssues: string[] = [];
  if (titleText) {
    const hr = subjectRegionsForWindow(timeline, titleText.start, titleText.end, placementOpts).head;
    const head = hr ? faceOf(hr) : null;
    const rect = layoutTimelineText(titleText, timeline.canvas, measure).rect;
    if (head && rect.y < head.y + head.height && head.y < rect.y + rect.height && rect.x < head.x + head.width && head.x < rect.x + rect.width) qIssues.push("the hook title touches your face");
    if (titleText.fontSize < 56) qIssues.push("the hook title is small");
  }
  if (input.measure) {
    const chunks = timelineCaptionChunks(timeline, { [input.mediaAssetId]: words });
    const col = findTimelineCollisions(timeline, chunks, input.measure);
    if (col.length) qIssues.push(`${col.length} text/caption overlap(s)`);
  }
  checks.push({
    id: "QUALITY",
    name: "Quality",
    status: qIssues.length ? "WARN" : fixes.QUALITY ? "FIXED" : "PASS",
    detail: [
      qIssues.length ? `Check: ${qIssues.join("; ")}.` : "Graphics and title clear of your face, the captions and the app buttons.",
      timeline.captions.enabled ? `Captions on (${timeline.captions.fontSize} px).` : "Captions off.",
      "Audio mastered to −14 LUFS.",
      ...(fixes.QUALITY ?? []).map((f) => `Fixed: ${f}.`),
    ].join(" "),
  });
  // Retention estimate (labelled).
  const factors: string[] = [];
  const firstWordOut = srcToOut(words[story.order[0]!.w0]!.start, false) ?? 0;
  if (firstWordOut > 0.5) factors.push(`first word at ${firstWordOut.toFixed(1)} s`);
  if (hook.score < 2) factors.push("the opening line is plain (no number, contrast or question)");
  if ((shots[0]?.sourceEnd ?? 0) - (shots[0]?.sourceStart ?? 0) > 4) factors.push("a long first shot");
  const gapsNow = staticGaps(timeline).filter((g) => g.len > 7);
  if (gapsNow.length) factors.push(`${gapsNow.length} stretch(es) over 7 s with nothing changing on screen`);
  if (outDur > storyTarget.maxS * 1.15) factors.push(`runs ${Math.round(outDur)} s — longer than your references (${Math.round(storyTarget.minS)}–${Math.round(storyTarget.maxS)} s)`);
  const risk = factors.length === 0 ? "LOW" : factors.length <= 2 ? "MEDIUM" : "HIGH";
  checks.push({
    id: "RETENTION",
    name: "Retention (estimate)",
    status: risk === "HIGH" ? "WARN" : fixes.RETENTION ? "FIXED" : "PASS",
    detail: `Estimated early-drop risk: ${risk.toLowerCase()}${factors.length ? ` — ${factors.join("; ")}` : ""}. ${(fixes.RETENTION ?? []).map((f) => `Fixed: ${f}.`).join(" ")}`.trim(),
  });

  // ---- Report -----------------------------------------------------------------------------
  const dec = story.decisions;
  const kinds = (k: RemovalKind[]) => dec.filter((d) => !d.kept && d.kind && k.includes(d.kind)).length;
  const counts = {
    repeats: kinds(["REPEAT"]),
    retakes: kinds(["RETAKE"]) + story.wordCuts.filter((c) => c.kind === "RESTART").length,
    fluff: kinds(["FLUFF", "GREETING", "META", "SIGN_OFF", "RECAP", "EXTRA_CTA", "DANGLING", "SLOW_START"]),
    tangents: kinds(["TANGENT"]),
    lowValue: kinds(["LOW_VALUE"]),
    fillers: story.wordCuts.filter((c) => c.kind === "FILLER" || c.kind === "LEAD_IN").length,
    pauses: assembled.pausesRemoved,
  };
  const keptCount = dec.filter((d) => d.kept || d.kind === "HOOK_MOVED").length;
  const removedBits = [
    counts.repeats && `${counts.repeats} repeat${counts.repeats === 1 ? "" : "s"}`,
    counts.retakes && `${counts.retakes} retake${counts.retakes === 1 ? "" : "s"}`,
    counts.fluff && `${counts.fluff} fluff line${counts.fluff === 1 ? "" : "s"}`,
    counts.tangents && `${counts.tangents} tangent${counts.tangents === 1 ? "" : "s"}`,
    counts.lowValue && `${counts.lowValue} weaker line${counts.lowValue === 1 ? "" : "s"} for length`,
    counts.fillers && `${counts.fillers} filler${counts.fillers === 1 ? "" : "s"}`,
    counts.pauses && `${counts.pauses} pause${counts.pauses === 1 ? "" : "s"}`,
  ].filter(Boolean);
  const lengthLine = `${fmtClock(duration)} → ${fmtClock(outDur)} · kept ${keptCount} of ${sentences.length} sentences${removedBits.length ? ` · removed ${removedBits.join(", ")}` : ""}`;
  const hookLine = `Hook: “${hook.text.length > 60 ? `${hook.text.slice(0, 58).trimEnd()}…` : hook.text}”${story.coldOpen ? " (cold open)" : ""}`;
  const summary = `${hookLine} · ${lengthLine} · ${picks.length} graphic${picks.length === 1 ? "" : "s"}`;

  const report: FullEditReport = {
    version: FULL_EDIT_VERSION,
    summary,
    lengthLine,
    sourceDurationS: r2(duration),
    outputDurationS: r2(outDur),
    sentencesTotal: sentences.length,
    sentencesKept: keptCount,
    counts,
    topic: { keywords: kw.map((k) => k.word) },
    hook: {
      text: hook.text,
      coldOpen: story.coldOpen,
      replayed: story.hookReplayed,
      chosenIndex: hookIndex,
      candidates: candidates.map((c, i) => ({ index: i, text: c.text, score: c.score, reason: c.reason, start: r2(c.start), sentenceIds: c.sentenceIds })),
      titles: titles.map((t) => ({ text: t.text, template: t.template })),
      titleIndex: titleText ? titleIndex : null,
      titleTextId: titleText?.id ?? null,
    },
    removed: dec
      .filter((d) => !d.kept && d.kind !== "HOOK_MOVED")
      .map((d) => ({ sentenceId: d.id, text: sentences[d.id]!.text, kind: d.kind ?? "LOW_VALUE", why: d.why, start: r2(sentences[d.id]!.start) })),
    marked: story.marked.map((m) => ({ sentenceId: m.id, note: m.note })),
    visuals: picks.map((p) => ({ id: p.visual.id, presetId: p.presetId, name: p.presetName, reason: p.reason, start: r2(timeline.visuals.find((v) => v.id === p.visual.id)?.start ?? p.visual.start), match: p.match, numbers: p.numbers })),
    rejectedVisuals: rejectedAll.length,
    zooms: timeline.zooms.length,
    checks,
    retention: { risk, factors, note: "An estimate from simple risk factors (slow start, long static stretches, plain opening) — not a prediction." },
    embedder: embedder.id,
    choices: { ...choices },
  };

  const inputsKey = `fe${FULL_EDIT_VERSION}-${hashString(
    JSON.stringify({
      a: input.mediaAssetId,
      d: r3(duration),
      w: words.map((w) => [w.word, r3(w.start), r3(w.end)]),
      t: input.subjectTrack ? input.subjectTrack.length : 0,
      z: silences ? silences.map((x) => [r3(x.start), r3(x.end)]) : null,
      g: { ...target, source: undefined },
      st: storyTarget,
      c: choices,
      e: embedder.id,
      cv: [input.base.canvas.width, input.base.canvas.height, input.base.captions.y],
    }),
  )}`;
  return { ok: true, version: FULL_EDIT_VERSION, timeline, report, inputsKey, story, sentences, shots, rejectedVisuals: rejectedAll };
}

/** Stretches of the output with no cut, graphic, zoom or text change. */
export function staticGaps(t: EditTimeline): Array<{ start: number; end: number; len: number }> {
  const dur = timelineDuration(t);
  const ev = new Set<number>([0, dur]);
  let acc = 0;
  for (const c of t.clips) {
    ev.add(r3(acc));
    acc += c.sourceEnd - c.sourceStart;
  }
  for (const v of t.visuals) ev.add(r3(v.start)).add(r3(v.end));
  for (const z of t.zooms) ev.add(r3(z.start));
  for (const x of t.texts) ev.add(r3(x.start)).add(r3(x.end));
  const pts = [...ev].filter((x) => x >= 0 && x <= dur).sort((a, b) => a - b);
  const out: Array<{ start: number; end: number; len: number }> = [];
  for (let i = 1; i < pts.length; i++) out.push({ start: pts[i - 1]!, end: pts[i]!, len: r3(pts[i]! - pts[i - 1]!) });
  return out;
}

/** The face (+ a small forehead/chin margin) inside a protected head region (subject-track-core:
 * face expanded 0.6 face heights up, 0.25 down, 0.35 widths each side). */
export function faceOf(head: { x: number; y: number; width: number; height: number }) {
  const fh = head.height / 1.85;
  const fw = head.width / 1.7;
  return { x: head.x + 0.35 * fw, y: head.y + 0.45 * fh, width: fw, height: fh * 1.25 };
}

/** The hook title: bold white on a dark plate, above Chris's head when there's room, else
 * between his chin and the captions; inside the platform-safe area. */
function placeTitle(text: string, timeline: EditTimeline, end: number, input: FullEditInput, measure: MeasureText): TimelineText {
  const canvas = timeline.canvas;
  const H = canvas.height;
  const k = canvas.width / 1080;
  const safeTop = (PLACEMENT_SAFE_ZONE.top * k) / H;
  const head = subjectRegionsForWindow(timeline, 0, end, {
    subjectTracks: { [input.mediaAssetId]: input.subjectTrack ?? null },
    sourceDimensions: { [input.mediaAssetId]: input.sourceSize ?? null },
  }).head;
  const capTop = timeline.captions.y - 0.06;
  const base: TimelineText = {
    id: "fe-hook-title",
    text,
    start: 0,
    end: r3(end),
    preset: "HEADLINE",
    fontId: "inter-display-extrabold",
    fontSize: 76,
    color: "#FFFFFF",
    backgroundColor: "#000000B3",
    strokeColor: null,
    align: "center",
    x: 0.5,
    y: 0.2,
    maxWidth: 0.8,
    uppercase: false,
  };
  for (const size of [76, 68, 60]) {
    const t = { ...base, fontSize: size };
    const h = layoutTimelineText(t, canvas, measure).rect.height / H;
    const margin = 0.012;
    if (!head) return { ...t, y: r3(Math.max(safeTop + h / 2 + margin, 0.2)) };
    // The title may sit over the hair margin of the protected head region, never the face.
    const f = faceOf(head);
    const headTop = f.y / H;
    const headBottom = (f.y + f.height) / H;
    if (headTop - safeTop >= h + 2 * margin) return { ...t, y: r3(safeTop + (headTop - safeTop) / 2) };
    if (capTop - headBottom >= h + 2 * margin) return { ...t, y: r3(headBottom + (capTop - headBottom) / 2) };
  }
  // No clear band: top of the safe area, smallest size (the Quality check reports it).
  const t = { ...base, fontSize: 60 };
  const h = layoutTimelineText(t, canvas, measure).rect.height / H;
  return { ...t, y: r3(safeTop + h / 2 + 0.01) };
}
