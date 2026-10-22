import { z } from "zod";
import type { TranscriptWord } from "../caption-chunking";
import { EditTimelineSchema, type EditTimeline } from "../timeline";
import { styleCutTargetFromProfile } from "../style-cut";
import { parseSubjectTrack } from "../subject-track-core";
import { buildFullEdit, storyTargetFromProfile, type FullEditChoices, type FullEditResult } from "../full-edit";
import { EditorPlanSchema } from "../full-edit/editor-plan";
import { LEXICAL_EMBEDDER, type FullEditEmbedder } from "../full-edit/text";
import { isSpliceAnalysis, type SpliceAnalysis } from "../splice/analysis";

/**
 * The golden-set harness (2026-10-21, docs/PREMIUM_EDITOR_HANDOFF.md §3.1). A fixture is one of
 * Chris's real takes frozen as data — words, silences, envelope, subject track, brief, reference
 * profile, the Editor's stored plan, the machine timeline prod made and, when he made one, his
 * hand-edited timeline. Replaying a fixture runs the whole Full edit offline (never a model
 * call) and summarises what a viewer gets: the kept lines in order, the title, the headlines,
 * the graphics, and every splice measured against the words. `diffGolden` is the gate: an empty
 * diff is green.
 */

const Word = z.object({ word: z.string(), start: z.number(), end: z.number() });
const Span = z.object({ start: z.number(), end: z.number() });

export const GoldenFixtureSchema = z.object({
  version: z.literal(1),
  slug: z.string().min(1),
  contentItemId: z.string(),
  title: z.string().nullable(),
  exportedAt: z.string(),
  take: z.object({
    mediaAssetId: z.string(),
    durationSeconds: z.number(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    words: z.array(Word),
    subjectTrack: z.unknown().nullable(),
  }),
  audio: z.object({
    silences: z.array(Span).nullable(),
    envelope: z.object({ frameS: z.number(), db: z.array(z.number()) }).nullable(),
    /** The splice engine's voice analysis (null for fixtures pulled before it existed). */
    splice: z.unknown().nullable().optional(),
  }),
  base: EditTimelineSchema,
  brief: z.object({ hook: z.string().nullable(), keep: z.array(z.string()), onScreenText: z.string().nullable() }).nullable(),
  profile: z.unknown().nullable(),
  editorPlan: EditorPlanSchema.nullable(),
  machine: z.object({ editPlanId: z.string(), createdAt: z.string(), reason: z.string().nullable(), summary: z.string(), timeline: EditTimelineSchema }).nullable(),
  handEdit: z.object({ editPlanId: z.string(), createdAt: z.string(), note: z.string().nullable(), timeline: EditTimelineSchema }).nullable(),
});
export type GoldenFixture = z.infer<typeof GoldenFixtureSchema>;

export interface SpliceMetric {
  index: number;
  outS: number;
  inS: number;
  removedS: number;
  /** Air left after the last word before the cut (negative = the word is clipped). */
  tailAirS: number;
  /** Air left before the first word after the cut. */
  leadAirS: number;
  /** What the viewer hears as the pause at the splice. */
  airS: number;
  clippedTailMs: number;
  clippedLeadMs: number;
  /** Both edges fall inside a measured silence (±20 ms); null when there are no silences. */
  inSilence: boolean | null;
}

export interface SpliceSummary {
  n: number;
  airMedianS: number | null;
  airP90S: number | null;
  airMaxS: number | null;
  /** Splices where either side clips a word by more than 40 ms. */
  clippedCount: number;
  clippedMaxMs: number;
  airOver026Count: number;
}

export interface GoldenCut {
  ok: boolean;
  error?: string;
  outputDurationS: number;
  kept: Array<{ sentenceId: number; text: string; beat: string }>;
  removed: Array<{ sentenceId: number; kind: string }>;
  title: string | null;
  headlines: Array<{ text: string; start: number; end: number }>;
  graphics: Array<{ presetId: string; start: number }>;
  zooms: number;
  checks: Array<{ id: string; status: string }>;
  splices: SpliceMetric[];
  spliceSummary: SpliceSummary;
}

export interface HandEditComparison {
  handCuts: number;
  /** Nearest machine edge to each hand edge, ms. */
  medianDeltaMs: number | null;
  p90DeltaMs: number | null;
  within30ms: number;
  /** Share of the hand edit's kept source time the machine also kept, and the reverse. */
  machineKeptOfHand: number;
  handKeptOfMachine: number;
}

export interface GoldenReplay {
  slug: string;
  free: GoldenCut;
  editor: GoldenCut | null;
  /** The machine timeline prod stored, measured the same way (not re-computed). */
  prodMachine: { spliceSummary: SpliceSummary } | null;
  hand: { spliceSummary: SpliceSummary; vsFree: HandEditComparison; vsEditor: HandEditComparison | null } | null;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return r3(s[lo]! + (s[hi]! - s[lo]!) * (i - lo));
}

/** The clips of one take, in timeline order, with the boundaries between consecutive clips. */
function boundaries(timeline: EditTimeline): Array<{ outS: number; inS: number }> {
  const out: Array<{ outS: number; inS: number }> = [];
  for (let i = 1; i < timeline.clips.length; i++) {
    const a = timeline.clips[i - 1]!;
    const b = timeline.clips[i]!;
    if (a.mediaAssetId !== b.mediaAssetId) continue;
    out.push({ outS: a.sourceEnd, inS: b.sourceStart });
  }
  return out;
}

/**
 * Every splice of a timeline measured against the voice (the splice analysis, to the
 * millisecond) when the fixture has one, else against Whisper's words (±0.2–0.4 s — a coarse
 * ruler: a "clipped" word there may be Whisper's drift, not the cut's). Silences, when known,
 * say whether both edges sit in measured quiet.
 */
export function spliceMetrics(timeline: EditTimeline, words: TranscriptWord[], silences: Array<{ start: number; end: number }> | null, analysis?: SpliceAnalysis | null): SpliceMetric[] {
  const inSil = (t: number) => (silences ? silences.some((s) => t >= s.start - 0.02 && t <= s.end + 0.02) : null);
  const spans: Array<{ start: number; end: number }> = analysis && analysis.voice.length ? analysis.voice : words;
  return boundaries(timeline).map(({ outS, inS }, index) => {
    const before = [...spans].reverse().find((w) => w.end <= outS + 0.02 || (w.start < outS && w.end > outS));
    const after = spans.find((w) => w.start >= inS - 0.02 || (w.start < inS && w.end > inS));
    // Clipped = the cut sits inside the voice AND inside a word (a voice span can run for many
    // seconds of continuous speech; a cut between two words of one span is not a clipped word).
    const inWord = (t: number) => words.some((w) => w.start + 0.04 < t && t < w.end - 0.04);
    const clippedTail = before && before.start < outS && before.end > outS + 0.02 && (!analysis || inWord(outS)) ? (before.end - outS) * 1000 : 0;
    const clippedLead = after && after.start < inS - 0.02 && after.end > inS && (!analysis || inWord(inS)) ? (inS - after.start) * 1000 : 0;
    const tailAirS = before ? outS - before.end : 0;
    const leadAirS = after ? after.start - inS : 0;
    const a = inSil(outS);
    const b = inSil(inS);
    return {
      index,
      outS: r3(outS),
      inS: r3(inS),
      removedS: r3(inS - outS),
      tailAirS: r3(tailAirS),
      leadAirS: r3(leadAirS),
      airS: r3(Math.max(0, tailAirS) + Math.max(0, leadAirS)),
      clippedTailMs: Math.round(clippedTail),
      clippedLeadMs: Math.round(clippedLead),
      inSilence: a === null || b === null ? null : a && b,
    };
  });
}

export function summariseSplices(splices: SpliceMetric[]): SpliceSummary {
  const air = splices.map((s) => s.airS);
  const clipped = splices.map((s) => Math.max(s.clippedTailMs, s.clippedLeadMs));
  return {
    n: splices.length,
    airMedianS: quantile(air, 0.5),
    airP90S: quantile(air, 0.9),
    airMaxS: air.length ? r3(Math.max(...air)) : null,
    clippedCount: clipped.filter((c) => c > 40).length,
    clippedMaxMs: clipped.length ? Math.max(...clipped) : 0,
    airOver026Count: air.filter((a) => a > 0.26).length,
  };
}

function keptIntervals(t: EditTimeline, assetId: string): Array<[number, number]> {
  return t.clips.filter((c) => c.mediaAssetId === assetId).map((c) => [c.sourceStart, c.sourceEnd] as [number, number]);
}

function overlap(a: Array<[number, number]>, b: Array<[number, number]>): number {
  let s = 0;
  for (const [a0, a1] of a) for (const [b0, b1] of b) s += Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  return s;
}

/** How close the machine's cut edges land to Chris's hand-cut edges, and how much they agree on what to keep. */
export function compareToHandEdit(machine: EditTimeline, hand: EditTimeline, assetId: string): HandEditComparison {
  const m = boundaries(machine);
  const h = boundaries(hand);
  const mOut = m.map((x) => x.outS);
  const mIn = m.map((x) => x.inS);
  const nearest = (xs: number[], t: number) => (xs.length ? Math.min(...xs.map((x) => Math.abs(x - t))) : Infinity);
  const deltas: number[] = [];
  for (const b of h) {
    deltas.push(nearest(mOut, b.outS) * 1000, nearest(mIn, b.inS) * 1000);
  }
  const finite = deltas.filter(Number.isFinite);
  const mk = keptIntervals(machine, assetId);
  const hk = keptIntervals(hand, assetId);
  const len = (xs: Array<[number, number]>) => xs.reduce((s, [a, b]) => s + Math.max(0, b - a), 0);
  const both = overlap(mk, hk);
  return {
    handCuts: h.length,
    medianDeltaMs: finite.length ? Math.round(quantile(finite, 0.5)!) : null,
    p90DeltaMs: finite.length ? Math.round(quantile(finite, 0.9)!) : null,
    within30ms: finite.filter((d) => d <= 30).length,
    machineKeptOfHand: len(hk) ? r3(both / len(hk)) : 0,
    handKeptOfMachine: len(mk) ? r3(both / len(mk)) : 0,
  };
}

function summariseCut(r: FullEditResult, words: TranscriptWord[], silences: Array<{ start: number; end: number }> | null, analysis: SpliceAnalysis | null): GoldenCut {
  if (!r.ok) {
    const empty = summariseSplices([]);
    return { ok: false, error: r.message, outputDurationS: 0, kept: [], removed: [], title: null, headlines: [], graphics: [], zooms: 0, checks: [], splices: [], spliceSummary: empty };
  }
  const rep = r.report;
  const splices = spliceMetrics(r.timeline, words, silences, analysis);
  return {
    ok: true,
    outputDurationS: r3(rep.outputDurationS),
    kept: rep.kept.map((k) => ({ sentenceId: k.sentenceId, text: k.text, beat: k.beat })),
    removed: rep.removed.map((x) => ({ sentenceId: x.sentenceId, kind: x.kind })),
    title: rep.hook.titleIndex != null ? (rep.hook.titles[rep.hook.titleIndex]?.text ?? null) : null,
    headlines: r.timeline.texts.filter((t) => t.id.startsWith("fe-beat-")).map((t) => ({ text: t.text, start: r3(t.start), end: r3(t.end) })),
    graphics: rep.visuals.map((v) => ({ presetId: v.presetId, start: r3(v.start) })),
    zooms: rep.zooms,
    checks: rep.checks.map((c) => ({ id: c.id, status: c.status })),
    splices,
    spliceSummary: summariseSplices(splices),
  };
}

/** Runs the Full edit on a fixture: the free cut, and the Editor's cut from its stored plan (no model call). */
export async function replayGolden(fixture: GoldenFixture, options: { embedder?: FullEditEmbedder } = {}): Promise<GoldenReplay> {
  const f = GoldenFixtureSchema.parse(fixture);
  const embedder = options.embedder ?? LEXICAL_EMBEDDER;
  const words = f.take.words;
  const silences = f.audio.silences;
  const analysis = isSpliceAnalysis(f.audio.splice) ? f.audio.splice : null;
  const profile = (f.profile ?? null) as Parameters<typeof styleCutTargetFromProfile>[0];
  const run = (choices: FullEditChoices) =>
    buildFullEdit(
      {
        base: f.base,
        mediaAssetId: f.take.mediaAssetId,
        words,
        durationSeconds: f.take.durationSeconds,
        subjectTrack: parseSubjectTrack(f.take.subjectTrack),
        sourceSize: f.take.width && f.take.height ? { width: f.take.width, height: f.take.height } : null,
        silences,
        envelope: f.audio.envelope,
        splice: analysis,
        target: styleCutTargetFromProfile(profile),
        story: storyTargetFromProfile(profile as Parameters<typeof storyTargetFromProfile>[0]),
        brief: f.brief,
        choices,
        editorPlanner: null,
      },
      embedder,
    );
  const freeR = await run({});
  const free = summariseCut(freeR, words, silences, analysis);
  let editor: GoldenCut | null = null;
  let editorTimeline: EditTimeline | null = null;
  if (f.editorPlan) {
    const r = await run({ useEditor: true, editorPlan: f.editorPlan });
    editor = summariseCut(r, words, silences, analysis);
    if (r.ok) editorTimeline = r.timeline;
  }
  const prodMachine = f.machine ? { spliceSummary: summariseSplices(spliceMetrics(f.machine.timeline, words, silences, analysis)) } : null;
  const hand = f.handEdit
    ? {
        spliceSummary: summariseSplices(spliceMetrics(f.handEdit.timeline, words, silences, analysis)),
        vsFree: freeR.ok ? compareToHandEdit(freeR.timeline, f.handEdit.timeline, f.take.mediaAssetId) : compareToHandEdit(f.base, f.handEdit.timeline, f.take.mediaAssetId),
        vsEditor: editorTimeline ? compareToHandEdit(editorTimeline, f.handEdit.timeline, f.take.mediaAssetId) : null,
      }
    : null;
  return { slug: f.slug, free, editor, prodMachine, hand };
}

function diffCut(label: string, e: GoldenCut | null, a: GoldenCut | null, out: string[]) {
  if (!e && !a) return;
  if (!e || !a) {
    out.push(`${label}: ${e ? "missing now" : "new (no expected)"}`);
    return;
  }
  const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  if (e.ok !== a.ok) out.push(`${label}: ok ${e.ok} → ${a.ok}${a.error ? ` (${a.error})` : ""}`);
  if (Math.abs(e.outputDurationS - a.outputDurationS) > 0.05) out.push(`${label}: length ${e.outputDurationS}s → ${a.outputDurationS}s`);
  const ids = (k: GoldenCut["kept"]) => k.map((x) => x.sentenceId);
  if (!eq(ids(e.kept), ids(a.kept))) out.push(`${label}: kept order [${ids(e.kept).join(",")}] → [${ids(a.kept).join(",")}]`);
  if (!eq(e.removed, a.removed)) out.push(`${label}: removed ${JSON.stringify(e.removed)} → ${JSON.stringify(a.removed)}`);
  if (e.title !== a.title) out.push(`${label}: title "${e.title}" → "${a.title}"`);
  if (!eq(e.headlines.map((h) => h.text), a.headlines.map((h) => h.text))) out.push(`${label}: headlines ${JSON.stringify(e.headlines.map((h) => h.text))} → ${JSON.stringify(a.headlines.map((h) => h.text))}`);
  if (!eq(e.graphics.map((g) => g.presetId), a.graphics.map((g) => g.presetId))) out.push(`${label}: graphics ${JSON.stringify(e.graphics.map((g) => g.presetId))} → ${JSON.stringify(a.graphics.map((g) => g.presetId))}`);
  if (e.zooms !== a.zooms) out.push(`${label}: zooms ${e.zooms} → ${a.zooms}`);
  if (!eq(e.checks, a.checks)) out.push(`${label}: checks ${JSON.stringify(e.checks)} → ${JSON.stringify(a.checks)}`);
  if (e.splices.length !== a.splices.length) out.push(`${label}: splices ${e.splices.length} → ${a.splices.length}`);
  else
    e.splices.forEach((s, i) => {
      const t = a.splices[i]!;
      if (Math.abs(s.outS - t.outS) > 0.005 || Math.abs(s.inS - t.inS) > 0.005) out.push(`${label}: splice ${i} ${s.outS}→${s.inS} became ${t.outS}→${t.inS}`);
    });
  const em = e.spliceSummary.airMedianS ?? 0;
  const am = a.spliceSummary.airMedianS ?? 0;
  if (Math.abs(em - am) > 0.005) out.push(`${label}: splice air median ${em}s → ${am}s`);
}

/** What changed between an expected replay and this one. Empty = green. */
export function diffGolden(expected: GoldenReplay, actual: GoldenReplay): string[] {
  const out: string[] = [];
  diffCut("free", expected.free, actual.free, out);
  diffCut("editor", expected.editor, actual.editor, out);
  return out;
}
