import type { ReferenceVideoMetrics } from "./style-metrics";
import { confidenceFor, quantile, type StyleConfidence } from "./style-metrics";

/**
 * The StyleModel (reference learning, docs/PREMIUM_EDITOR_PLAN.md round 4): what a viewer sees
 * and hears in Chris's references AND in his own hand edits, as BANDS (p25–p75), never a single
 * number — every consumer enforces a range and the Editor's judgment moves inside it. Built from
 * per-video samples: a reference's measured metrics (v3), or a timeline of his (a hand edit, a
 * video posted unchanged) read directly — his own work weighs double. A creator whose
 * "don't copy" note names a signal is left out of that signal's band. PURE; the loader is in
 * reference-videos.ts (`getStyleModel`).
 */
export interface Band {
  p25: number;
  p50: number;
  p75: number;
  n: number;
}

export type CaptionPresetKind = "ONE_WORD" | "PHRASE" | "NONE";
export type ScreenBand = "TOP" | "MID" | "LOW";

export interface StyleSample {
  source: "REFERENCE" | "MINE";
  creatorId: string | null;
  label: string;
  weight: number;
  /** Per-signal weight overrides (his own edits: 0 on the screen signals — the old editor put
   * nothing on screen, that is not a habit to learn; double on cuts and pads, which are his). */
  signalWeights?: Partial<Record<StyleSignal, number>>;
  durationS: number | null;
  shotMedianS: number | null;
  cutsPer10s: number | null;
  firstCutS: number | null;
  thirdsPer10s: [number, number, number] | null;
  headlinesPer10s: number | null;
  headlineHoldS: number | null;
  headlineWords: number | null;
  headlineBand: ScreenBand | null;
  headlineUppercase: number | null;
  captionPreset: CaptionPresetKind | null;
  captionWordsPerChunk: number | null;
  captionBand: ScreenBand | null;
  captionUppercase: number | null;
  captionCoverage: number | null;
  hookTextByS: number | null;
  zoomsPer10s: number | null;
  zoomAmount: number | null;
  zoomHoldS: number | null;
  zoomInOut: number | null;
  gapMedianS: number | null;
  padTailMs: number | null;
  padLeadMs: number | null;
  endsOnLastWord: boolean | null;
  musicUnderVoiceDb: number | null;
  music: boolean | null;
}

export type StyleSignal = "cuts" | "headlines" | "captions" | "zooms" | "music" | "pads" | "length" | "hook";

export interface StyleModel {
  sampleSize: number;
  referenceCount: number;
  mineCount: number;
  creatorCount: number;
  confidence: StyleConfidence;
  lengthS: Band | null;
  shotS: Band | null;
  cutsPer10s: Band | null;
  firstCutS: Band | null;
  thirdsPer10s: [Band, Band, Band] | null;
  headlinesPer10s: Band | null;
  headlineHoldS: Band | null;
  headlineWords: Band | null;
  headlineBand: ScreenBand | null;
  headlineUppercaseShare: number | null;
  /** Share of videos with headlines at all. */
  headlineShare: number | null;
  captions: { preset: CaptionPresetKind | null; wordsPerChunk: Band | null; band: ScreenBand | null; uppercaseShare: number | null; coverage: Band | null; share: number | null };
  hookTextByS: Band | null;
  /** Share of videos with text on screen by 1.5 s. */
  hookTextEarlyShare: number | null;
  zoomsPer10s: Band | null;
  zoomAmount: Band | null;
  zoomHoldS: Band | null;
  zoomInOutShare: number | null;
  pauseKeepS: Band | null;
  pads: { tailMs: Band; leadMs: Band } | null;
  endsOnLastWordShare: number | null;
  musicShare: number | null;
  musicUnderVoiceDb: Band | null;
  /** "creator X left out of captions (don't copy: …)". */
  exclusions: string[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function band(values: Array<{ v: number | null | undefined; w: number }>): Band | null {
  const xs: number[] = [];
  for (const { v, w } of values) if (typeof v === "number" && Number.isFinite(v)) for (let i = 0; i < Math.max(1, Math.round(w)); i++) xs.push(v);
  if (!xs.length) return null;
  return { p25: r2(quantile(xs, 0.25)!), p50: r2(quantile(xs, 0.5)!), p75: r2(quantile(xs, 0.75)!), n: values.filter((x) => typeof x.v === "number" && Number.isFinite(x.v)).length };
}

function share(values: Array<{ v: boolean | null | undefined; w: number }>): number | null {
  let yes = 0;
  let all = 0;
  for (const { v, w } of values) {
    if (v == null) continue;
    all += w;
    if (v) yes += w;
  }
  return all > 0 ? r2(yes / all) : null;
}

function mode<T extends string>(values: Array<{ v: T | null | undefined; w: number }>): T | null {
  const c = new Map<T, number>();
  for (const { v, w } of values) if (v) c.set(v, (c.get(v) ?? 0) + w);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Which signals a creator's "don't copy" note names. */
export function excludedSignals(doNotTransfer: string | null | undefined): StyleSignal[] {
  const t = (doNotTransfer ?? "").toLowerCase();
  if (!t.trim()) return [];
  const out: StyleSignal[] = [];
  if (/caption|subtitle/.test(t)) out.push("captions");
  if (/headline|title|on.?screen text|text on screen/.test(t)) out.push("headlines");
  if (/zoom|punch/.test(t)) out.push("zooms");
  if (/\bcuts?\b|pacing|jump/.test(t)) out.push("cuts", "pads");
  if (/music|sound|sfx/.test(t)) out.push("music");
  if (/length|long|short/.test(t)) out.push("length");
  if (/hook|open/.test(t)) out.push("hook");
  return [...new Set(out)];
}

/** One reference's measured metrics as a sample (v1/v2 rows give the audio/cut signals only). */
export function sampleFromReferenceMetrics(m: ReferenceVideoMetrics, creatorId: string, label: string): StyleSample {
  const sc = m.screen ?? null;
  const caps = sc?.captions ?? null;
  return {
    source: "REFERENCE",
    creatorId,
    label,
    weight: 1,
    durationS: m.video.durationS,
    shotMedianS: m.cuts?.shotMedianS ?? null,
    cutsPer10s: m.cuts?.cutsPer10s ?? null,
    firstCutS: m.cuts?.firstCutS ?? null,
    thirdsPer10s: m.rhythm?.thirdsPer10s ?? null,
    headlinesPer10s: sc ? sc.headlines.per10s : null,
    headlineHoldS: sc?.headlines.holdMedianS ?? null,
    headlineWords: sc?.headlines.wordsMedian ?? null,
    headlineBand: sc?.headlines.band ?? null,
    headlineUppercase: sc?.headlines.uppercaseShare ?? null,
    captionPreset: caps ? (!caps.present ? "NONE" : (caps.oneWordShare ?? 0) >= 0.6 ? "ONE_WORD" : "PHRASE") : null,
    captionWordsPerChunk: caps?.wordsPerChunk ?? null,
    captionBand: caps?.band ?? null,
    captionUppercase: caps?.uppercaseShare ?? null,
    captionCoverage: caps?.coverage ?? null,
    hookTextByS: sc?.hook?.byS ?? null,
    zoomsPer10s: m.zooms?.per10s ?? null,
    zoomAmount: m.zooms?.amountMedian ?? null,
    zoomHoldS: m.zooms?.holdMedianS ?? null,
    zoomInOut: m.zooms?.inOutShare ?? null,
    gapMedianS: m.speech?.gapMedianS ?? null,
    padTailMs: m.pads?.tailMedianMs ?? null,
    padLeadMs: m.pads?.leadMedianMs ?? null,
    endsOnLastWord: m.speech?.endsRightAfterLastWord ?? null,
    musicUnderVoiceDb: m.audio?.backgroundUnderVoiceDb ?? null,
    music: m.audio ? m.audio.background === "present" : null,
  };
}

/** A timeline of Chris's own (a hand edit, a posted video) read as a sample: what IS on screen. */
export function sampleFromTimeline(
  timeline: {
    clips: Array<{ sourceStart: number; sourceEnd: number; mediaAssetId: string }>;
    texts: Array<{ text: string; start: number; end: number; y: number; uppercase: boolean }>;
    captions: { enabled: boolean; maxWordsPerChunk: number; y: number; uppercase: boolean; chunking?: Array<{ maxWords: number }> };
    zooms: Array<{ start: number; end: number; zoom: number; easeOutSeconds?: number }>;
    audio?: { music?: unknown | null };
  },
  label: string,
  weight = 2,
): StyleSample {
  const durationS = timeline.clips.reduce((s, c) => s + Math.max(0, c.sourceEnd - c.sourceStart), 0);
  let cuts = 0;
  for (let i = 1; i < timeline.clips.length; i++) {
    const a = timeline.clips[i - 1]!;
    const b = timeline.clips[i]!;
    if (a.mediaAssetId !== b.mediaAssetId || Math.abs(b.sourceStart - a.sourceEnd) > 1e-3) cuts++;
  }
  const shots = timeline.clips.map((c) => c.sourceEnd - c.sourceStart).sort((a, b) => a - b);
  const thirds: [number, number, number] | null = durationS > 0 ? ([0, 1, 2].map((k) => {
    let acc = 0;
    let n = 0;
    for (let i = 1; i < timeline.clips.length; i++) {
      acc += timeline.clips[i - 1]!.sourceEnd - timeline.clips[i - 1]!.sourceStart;
      if (acc >= (k * durationS) / 3 && acc < ((k + 1) * durationS) / 3) n++;
    }
    return r2((n / (durationS / 3)) * 10);
  }) as [number, number, number]) : null;
  const heads = timeline.texts.filter((t) => t.end - t.start >= 2);
  const bandOf = (y: number): ScreenBand => (y < 0.33 ? "TOP" : y < 0.62 ? "MID" : "LOW");
  const bands = heads.map((h) => bandOf(h.y));
  const chunkSizes = [timeline.captions.maxWordsPerChunk, ...(timeline.captions.chunking ?? []).map((w) => w.maxWords)];
  const ins = timeline.zooms.filter((z) => z.zoom > 1);
  const first = heads.length ? Math.min(...heads.map((h) => h.start)) : null;
  return {
    source: "MINE",
    creatorId: null,
    label,
    weight,
    signalWeights: { headlines: 0, captions: 0, zooms: 0, music: 0, hook: 0, length: 0 },
    durationS: r2(durationS),
    shotMedianS: shots.length ? r2(shots[Math.floor(shots.length / 2)]!) : null,
    cutsPer10s: durationS > 0 ? r2((cuts / durationS) * 10) : null,
    firstCutS: timeline.clips.length > 1 ? r2(timeline.clips[0]!.sourceEnd - timeline.clips[0]!.sourceStart) : null,
    thirdsPer10s: thirds,
    headlinesPer10s: durationS > 0 ? r2((heads.length / durationS) * 10) : null,
    headlineHoldS: heads.length ? r2(heads.map((h) => h.end - h.start).sort((a, b) => a - b)[Math.floor(heads.length / 2)]!) : null,
    headlineWords: heads.length ? heads.map((h) => h.text.trim().split(/\s+/).length).sort((a, b) => a - b)[Math.floor(heads.length / 2)]! : null,
    headlineBand: bands.length ? (["TOP", "MID", "LOW"] as ScreenBand[]).sort((a, b) => bands.filter((x) => x === b).length - bands.filter((x) => x === a).length)[0]! : null,
    headlineUppercase: heads.length ? r2(heads.filter((h) => h.uppercase || h.text === h.text.toUpperCase()).length / heads.length) : null,
    captionPreset: timeline.captions.enabled ? (Math.min(...chunkSizes) === 1 && chunkSizes.filter((c) => c === 1).length * 2 >= chunkSizes.length ? "ONE_WORD" : "PHRASE") : "NONE",
    captionWordsPerChunk: timeline.captions.enabled ? timeline.captions.maxWordsPerChunk : null,
    captionBand: timeline.captions.enabled ? bandOf(timeline.captions.y) : null,
    captionUppercase: timeline.captions.enabled ? (timeline.captions.uppercase ? 1 : 0) : null,
    captionCoverage: timeline.captions.enabled ? 1 : null,
    hookTextByS: first,
    zoomsPer10s: durationS > 0 ? r2((ins.length / durationS) * 10) : null,
    zoomAmount: ins.length ? r2(ins.map((z) => z.zoom).sort((a, b) => a - b)[Math.floor(ins.length / 2)]!) : null,
    zoomHoldS: ins.length ? r2(ins.map((z) => z.end - z.start).sort((a, b) => a - b)[Math.floor(ins.length / 2)]!) : null,
    zoomInOut: ins.length ? r2(ins.filter((z) => (z.easeOutSeconds ?? 0) > 0).length / ins.length) : null,
    gapMedianS: null,
    padTailMs: null,
    padLeadMs: null,
    endsOnLastWord: null,
    musicUnderVoiceDb: null,
    music: timeline.audio ? !!timeline.audio.music : null,
  };
}

/** A stored plan's `timeline` as the structural shape sampleFromTimeline reads (the domain package
 * stays free of @chris/media; the real schema is EditTimelineSchema there). */
export function timelineLike(value: unknown): Parameters<typeof sampleFromTimeline>[0] | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  if (!Array.isArray(t.clips) || !t.clips.length || !t.captions || typeof t.captions !== "object") return null;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  const clips = (t.clips as Array<Record<string, unknown>>).filter((c) => c && num(c.sourceStart) && num(c.sourceEnd) && typeof c.mediaAssetId === "string");
  if (clips.length !== t.clips.length) return null;
  const texts = (Array.isArray(t.texts) ? (t.texts as Array<Record<string, unknown>>) : []).filter((x) => x && typeof x.text === "string" && num(x.start) && num(x.end));
  const zooms = (Array.isArray(t.zooms) ? (t.zooms as Array<Record<string, unknown>>) : []).filter((z) => z && num(z.start) && num(z.end) && num(z.zoom));
  const c = t.captions as Record<string, unknown>;
  return {
    clips: clips.map((x) => ({ sourceStart: x.sourceStart as number, sourceEnd: x.sourceEnd as number, mediaAssetId: x.mediaAssetId as string })),
    texts: texts.map((x) => ({ text: x.text as string, start: x.start as number, end: x.end as number, y: num(x.y) ? (x.y as number) : 0.15, uppercase: x.uppercase === true })),
    captions: {
      enabled: c.enabled !== false,
      maxWordsPerChunk: num(c.maxWordsPerChunk) ? (c.maxWordsPerChunk as number) : 3,
      y: num(c.y) ? (c.y as number) : 0.72,
      uppercase: c.uppercase === true,
      chunking: Array.isArray(c.chunking) ? (c.chunking as Array<Record<string, unknown>>).filter((w) => num(w.maxWords)).map((w) => ({ maxWords: w.maxWords as number })) : [],
    },
    zooms: zooms.map((z) => ({ start: z.start as number, end: z.end as number, zoom: z.zoom as number, easeOutSeconds: num(z.easeOutSeconds) ? (z.easeOutSeconds as number) : 0 })),
    audio: t.audio && typeof t.audio === "object" ? { music: (t.audio as Record<string, unknown>).music ?? null } : undefined,
  };
}

export interface BuildStyleModelOptions {
  /** Per creator: the signals its "don't copy" note excludes (excludedSignals). */
  exclusions?: Array<{ creatorId: string; name: string; signals: StyleSignal[] }>;
}

export function buildStyleModel(samples: StyleSample[], options: BuildStyleModelOptions = {}): StyleModel {
  const ex = new Map((options.exclusions ?? []).map((e) => [e.creatorId, e]));
  const notes: string[] = [];
  const pick = (signal: StyleSignal) =>
    samples.filter((s) => {
      const e = s.creatorId ? ex.get(s.creatorId) : null;
      if (e && e.signals.includes(signal)) {
        const line = `${e.name} left out of ${signal} (don't copy)`;
        if (!notes.includes(line)) notes.push(line);
        return false;
      }
      return true;
    });
  const weightFor = (s: StyleSample, signal: StyleSignal) => s.signalWeights?.[signal] ?? s.weight;
  const W = <T>(xs: StyleSample[], f: (s: StyleSample) => T, signal: StyleSignal) => xs.filter((s) => weightFor(s, signal) > 0).map((s) => ({ v: f(s), w: weightFor(s, signal) }));
  const cuts = pick("cuts");
  const heads = pick("headlines");
  const caps = pick("captions");
  const zooms = pick("zooms");
  const music = pick("music");
  const pads = pick("pads");
  const length = pick("length");
  const hook = pick("hook");
  const refs = samples.filter((s) => s.source === "REFERENCE");
  const thirds = cuts.filter((s) => s.thirdsPer10s);
  const t = (k: 0 | 1 | 2) => band(W(thirds, (s) => s.thirdsPer10s![k], "cuts"));
  const tail = band(W(pads, (s) => s.padTailMs, "pads"));
  const lead = band(W(pads, (s) => s.padLeadMs, "pads"));
  return {
    sampleSize: samples.length,
    referenceCount: refs.length,
    mineCount: samples.length - refs.length,
    creatorCount: new Set(refs.map((s) => s.creatorId)).size,
    confidence: confidenceFor(refs.length),
    lengthS: band(W(length, (s) => s.durationS, "length")),
    shotS: band(W(cuts, (s) => s.shotMedianS, "cuts")),
    cutsPer10s: band(W(cuts, (s) => s.cutsPer10s, "cuts")),
    firstCutS: band(W(cuts, (s) => s.firstCutS, "cuts")),
    thirdsPer10s: thirds.length ? [t(0)!, t(1)!, t(2)!] : null,
    headlinesPer10s: band(W(heads, (s) => s.headlinesPer10s, "headlines")),
    headlineHoldS: band(W(heads, (s) => s.headlineHoldS, "headlines")),
    headlineWords: band(W(heads, (s) => s.headlineWords, "headlines")),
    headlineBand: mode(W(heads, (s) => s.headlineBand, "headlines")),
    headlineUppercaseShare: band(W(heads, (s) => s.headlineUppercase, "headlines"))?.p50 ?? null,
    headlineShare: share(W(heads, (s) => (s.headlinesPer10s == null ? null : s.headlinesPer10s > 0), "headlines")),
    captions: {
      preset: mode(W(caps, (s) => s.captionPreset, "captions")),
      wordsPerChunk: band(W(caps, (s) => s.captionWordsPerChunk, "captions")),
      band: mode(W(caps, (s) => s.captionBand, "captions")),
      uppercaseShare: band(W(caps, (s) => s.captionUppercase, "captions"))?.p50 ?? null,
      coverage: band(W(caps, (s) => s.captionCoverage, "captions")),
      share: share(W(caps, (s) => (s.captionPreset == null ? null : s.captionPreset !== "NONE"), "captions")),
    },
    hookTextByS: band(W(hook, (s) => s.hookTextByS, "hook")),
    hookTextEarlyShare: share(W(hook, (s) => (s.headlinesPer10s == null ? null : s.hookTextByS != null && s.hookTextByS <= 1.5), "hook")),
    zoomsPer10s: band(W(zooms, (s) => s.zoomsPer10s, "zooms")),
    zoomAmount: band(W(zooms, (s) => s.zoomAmount, "zooms")),
    zoomHoldS: band(W(zooms, (s) => s.zoomHoldS, "zooms")),
    zoomInOutShare: band(W(zooms, (s) => s.zoomInOut, "zooms"))?.p50 ?? null,
    pauseKeepS: band(W(cuts, (s) => s.gapMedianS, "cuts")),
    pads: tail && lead ? { tailMs: tail, leadMs: lead } : null,
    endsOnLastWordShare: share(W(cuts, (s) => s.endsOnLastWord, "cuts")),
    musicShare: share(W(music, (s) => s.music, "music")),
    musicUnderVoiceDb: band(W(music, (s) => s.musicUnderVoiceDb, "music")),
    exclusions: notes,
  };
}

const fmtS = (x: number) => (x >= 10 ? `${Math.round(x)} s` : `${x.toFixed(1)} s`);
const rangeS = (b: Band) => (fmtS(b.p25) === fmtS(b.p75) ? fmtS(b.p50) : `${fmtS(b.p25)}–${fmtS(b.p75)}`);
const range = (b: Band, unit = "") => (b.p25 === b.p75 ? `${b.p50}${unit}` : `${b.p25}–${b.p75}${unit}`);

/** One paragraph a creator can agree or disagree with ("your references open with…"). */
export function describeStyleModel(m: StyleModel): string {
  if (m.sampleSize === 0) return "";
  const parts: string[] = [];
  if (m.lengthS) parts.push(`Your references run ${rangeS(m.lengthS)}`);
  if (m.hookTextByS && m.hookTextEarlyShare != null) parts.push(`${m.hookTextEarlyShare >= 0.6 ? "open with text on screen" : "sometimes open with text on screen"} by ${fmtS(m.hookTextByS.p50)}`);
  if (m.headlinesPer10s && m.headlineShare && m.headlineShare > 0) {
    const every = m.headlinesPer10s.p50 > 0 ? 10 / m.headlinesPer10s.p50 : null;
    parts.push(`put a headline up ${every ? `every ${fmtS(every)}` : "rarely"}${m.headlineWords ? `, ${range(m.headlineWords)} words` : ""}${m.headlineHoldS ? `, held ${rangeS(m.headlineHoldS)}` : ""}${m.headlineBand ? `, in the ${m.headlineBand.toLowerCase()} of the frame` : ""}`);
  } else if (m.headlineShare === 0) parts.push("use no headlines");
  if (m.captions.preset === "ONE_WORD") parts.push(`caption one word at a time${m.captions.band ? ` ${m.captions.band === "LOW" ? "low" : m.captions.band === "MID" ? "mid-frame" : "high"}` : ""}`);
  else if (m.captions.preset === "PHRASE") parts.push(`caption in ${m.captions.wordsPerChunk ? `${range(m.captions.wordsPerChunk)}-word` : "short"} phrases${m.captions.band ? ` ${m.captions.band === "LOW" ? "low" : m.captions.band === "MID" ? "mid-frame" : "high"}` : ""}`);
  else if (m.captions.preset === "NONE") parts.push("run no captions");
  if (m.shotS) parts.push(`cut every ${rangeS(m.shotS)}${m.thirdsPer10s ? (m.thirdsPer10s[0].p50 > m.thirdsPer10s[1].p50 * 1.3 ? " (faster in the open)" : m.thirdsPer10s[2].p50 > m.thirdsPer10s[1].p50 * 1.3 ? " (faster at the payoff)" : "") : ""}`);
  if (m.zoomsPer10s) parts.push(m.zoomsPer10s.p50 > 0 ? `punch in ${m.zoomsPer10s.p50.toFixed(1)}× per 10 s${m.zoomAmount ? ` at ${range(m.zoomAmount, "×")}` : ""}${m.zoomInOutShare != null && m.zoomInOutShare >= 0.5 ? ", easing back out" : ""}` : "rarely punch in");
  if (m.pads) parts.push(`leave ${range(m.pads.tailMs, " ms")} before a cut and ${range(m.pads.leadMs, " ms")} after`);
  if (m.endsOnLastWordShare != null) parts.push(m.endsOnLastWordShare >= 0.5 ? "end on the last word" : "let the ending breathe");
  if (m.musicShare != null) parts.push(m.musicShare >= 0.5 ? `run music ${m.musicUnderVoiceDb ? `${Math.round(m.musicUnderVoiceDb.p50)} dB under the voice` : "under the voice"}` : "run no music under the voice");
  let text = `${parts.join(", ")}.`;
  text = text.charAt(0).toUpperCase() + text.slice(1);
  const basis = `${m.referenceCount} reference video${m.referenceCount === 1 ? "" : "s"}${m.creatorCount > 1 ? ` from ${m.creatorCount} creators` : ""}${m.mineCount ? `; cuts and pads also from ${m.mineCount} of your own edits, weighted double` : ""}`;
  return `${text} (${basis}${m.confidence === "early" ? " — early, few videos" : ""}.)`;
}

/** The ten-line digest the Editor reads (what the references do, never a quota). */
export function editorDigest(m: StyleModel): string[] {
  if (m.referenceCount + m.mineCount === 0) return [];
  const lines: string[] = [];
  if (m.lengthS) lines.push(`Length: ${rangeS(m.lengthS)} (typical ${fmtS(m.lengthS.p50)}).`);
  if (m.hookTextByS) lines.push(`Opening: the hook text is on screen by ${fmtS(m.hookTextByS.p50)}${m.hookTextEarlyShare != null ? ` (${Math.round(m.hookTextEarlyShare * 100)} % by 1.5 s)` : ""}.`);
  if (m.headlinesPer10s && m.headlinesPer10s.p50 > 0) lines.push(`Headlines: one every ${fmtS(10 / m.headlinesPer10s.p50)}${m.headlineWords ? `, ${range(m.headlineWords)} words` : ""}${m.headlineHoldS ? `, each held ${rangeS(m.headlineHoldS)}` : ""} — so a beat is an idea of that length.`);
  if (m.captions.preset) lines.push(`Captions: ${m.captions.preset === "ONE_WORD" ? "one word at a time" : m.captions.preset === "PHRASE" ? `${m.captions.wordsPerChunk ? `${range(m.captions.wordsPerChunk)}-word ` : ""}phrases` : "none"} — the headline carries the number, never the caption.`);
  if (m.shotS) lines.push(`Cuts: every ${rangeS(m.shotS)}${m.thirdsPer10s ? `; open / middle / payoff ${m.thirdsPer10s.map((b) => b.p50.toFixed(1)).join(" / ")} cuts per 10 s` : ""}.`);
  if (m.zoomsPer10s) lines.push(`Punch-ins: ${m.zoomsPer10s.p50 > 0 ? `${m.zoomsPer10s.p50.toFixed(1)} per 10 s${m.zoomAmount ? ` at ${range(m.zoomAmount, "×")}` : ""}` : "rare"} — mark emphasis words accordingly.`);
  if (m.pauseKeepS) lines.push(`Pauses kept between words: ${rangeS(m.pauseKeepS)}.`);
  if (m.endsOnLastWordShare != null) lines.push(`Endings: ${m.endsOnLastWordShare >= 0.5 ? "cut on the last word" : "a breath after the last word"}.`);
  if (m.musicShare != null) lines.push(`Sound: ${m.musicShare >= 0.5 ? "music under the voice" : "voice only"}.`);
  if (m.exclusions.length) lines.push(`Left out on purpose: ${m.exclusions.join("; ")}.`);
  return lines.slice(0, 10);
}
