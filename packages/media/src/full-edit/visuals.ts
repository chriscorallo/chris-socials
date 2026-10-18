import { GRAPHIC_COMPONENT_SPECS, GraphicPropsSchema, graphicShownNumbers, type GraphicProps } from "../graphics/contract";
import { GRAPHIC_PRESETS, presetById, type GraphicPreset } from "../graphics/presets";
import { suggestGraphics } from "../graphics/suggest";
import { VISUAL_INTERACTION_DEFAULTS, type SfxSound, type TimelineVisual } from "../motion-contract";
import type { FESentence } from "./understand";
import { sameNumber, spokenNumbers, type SpokenNumber } from "./numbers";
import { bare, cosine, tokens, STOP_WORDS } from "./text";

/**
 * Visuals bot (PURE) — picks library graphics for the moments that deserve one (money,
 * percentages, comparisons, lists, searches/texts/news, punchy lines), pre-filled with Chris's
 * own numbers and words (graphics/suggest.ts), matched by meaning (sentence embedding ↔ preset
 * description), with restraint: ~one meaningful visual per 6–12 s, none during the hook, never
 * two at once, never full-screen over his face, timed to the words (starts on the number word,
 * holds long enough to read). The placement engine (visual-placement.ts) then keeps each one
 * clear of his face, the captions and the platform UI; a graphic with no clear spot is dropped.
 */

export interface VisualMoment {
  sentence: FESentence;
  /** Output-timeline seconds of the sentence (and of each word, by index). */
  outStart: number;
  outEnd: number;
  wordOut: (w: number) => number | null;
  /** Sentence embedding. */
  vec: number[];
}

export interface VisualPick {
  visual: TimelineVisual;
  presetId: string;
  presetName: string;
  sentenceId: number;
  /** Plain English: why this graphic here ("You said $400 a month"). */
  reason: string;
  /** Meaning match (cosine sentence ↔ preset description). */
  match: number;
  score: number;
  /** Numbers it shows, each proven in the transcript. */
  numbers: number[];
}

export interface VisualRejection {
  sentenceId: number;
  presetId: string;
  reason: string;
}

export interface VisualsInput {
  moments: VisualMoment[];
  /** Every number spoken in the KEPT story (what may be shown). */
  spoken: SpokenNumber[];
  /** Every word of the take (lower-case stems allowed in graphic text). */
  vocabulary: Set<string>;
  presetVec: (p: GraphicPreset) => number[] | null;
  weakMatch: number;
  hookEndS: number;
  durationS: number;
  /** Seconds per visual, on average (density). */
  secondsPerVisual?: number;
  /** `${sentenceId}:${presetId}` pairs that failed a later check (e.g. no clear spot) — the
   * next-best graphic for that line is tried instead. */
  exclude?: Set<string>;
}

/** Labels a graphic may show that aren't Chris's words but add no claim. */
const NEUTRAL_LABELS = new Set(
  "before after start today now then month monthly year yearly a per total amount you them me option step steps the of and vs or saved save spend spent each every one".split(" "),
);

/** Every number a graphic shows (props + digits in its text). */
export function graphicNumbers(props: GraphicProps): number[] {
  const shown = graphicShownNumbers(props);
  const fromText = shown.texts.flatMap((t) => spokenNumbers(t.text.split(/\s+/)).map((n) => n.value));
  return [...shown.numbers.map((n) => n.value), ...fromText];
}

/** Text fields made only of Chris's words (or neutral labels). Unknown words → field blanked. */
function groundTexts(p: GraphicProps, vocabulary: Set<string>): GraphicProps | null {
  const ok = (s: string | null) => {
    if (!s || !s.trim()) return true;
    const toks = tokens(s).filter((t) => !STOP_WORDS.has(t) && !/^[\d$%.,]+$/.test(t));
    return toks.every((t) => vocabulary.has(bare(t)) || NEUTRAL_LABELS.has(t));
  };
  const out: GraphicProps = structuredClone(p);
  for (const k of ["title", "subtitle", "meta"] as const) if (!ok(out[k])) out[k] = null;
  if (!ok(out.body)) return null;
  out.items = out.items.map((it) => ({ ...it, text: ok(it.text) ? it.text : "", sub: ok(it.sub) ? it.sub : null, meta: ok(it.meta) ? it.meta : null }));
  out.series = out.series.map((s) => ({ ...s, label: ok(s.label) ? s.label : "", note: ok(s.note) ? s.note : null, texts: s.texts.map((x) => (ok(x) ? x : "")) }));
  out.categories = out.categories.map((c) => (ok(c) ? c : ""));
  const r = GraphicPropsSchema.safeParse(out);
  return r.success ? r.data : null;
}

/** A list (first… second… third…) as a STEPS graphic made of the steps' own words. */
export function listGraphic(steps: FESentence[]): GraphicProps | null {
  if (steps.length < 2) return null;
  const items = steps.slice(0, 6).map((s) => {
    const words = s.text
      .replace(/^(?:(?:okay|ok|so|and|then)[,.]?\s+)*(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth|fifth|last(?:ly)?|finally|step (?:one|two|three|four|five|\d)|number (?:one|two|three|four|five|\d))[,:]?\s*/i, "")
      .replace(/[.!?]+$/, "")
      .split(/\s+/);
    let t = words.slice(0, 6).join(" ");
    while (/\b(?:the|a|an|to|of|and|it|your|on|in|for|with|than|before|after|that|is|are|was)$/i.test(t)) t = t.replace(/\s*\S+$/, "");
    return { text: t.charAt(0).toUpperCase() + t.slice(1), sub: null, value: null, icon: null, color: "AUTO" as const, op: "NONE" as const, state: "NONE" as const, side: "NONE" as const, meta: null };
  });
  if (items.some((i) => i.text.length < 3 || i.text.length > 48)) return null;
  const base = presetById("steps-debt-plan");
  const r = GraphicPropsSchema.safeParse({ ...(base?.props ?? { component: "STEPS" }), preset: "steps-debt-plan", title: null, items });
  return r.success ? r.data : null;
}

function kindWeight(presetId: string, reason: string, props: GraphicProps): number {
  if (/^You said \$|money|a year of it|\bvs\b|From /i.test(reason)) return 1.0;
  if (props.component === "BIG_NUMBER" || props.component === "STAT_TILES") return 0.95;
  if (["VERSUS", "VALUE_COLUMNS", "BEFORE_AFTER", "ENTITY_CARDS", "MONTH_GRID", "DONUT", "PROGRESS"].includes(props.component)) return 0.9;
  if (["SEARCH_BAR", "DM_CHAT", "NEWS", "NOTIFICATION", "TRENDING", "SOCIAL_POST", "VERDICT", "PAYMENT"].includes(props.component)) return 0.85;
  if (props.component === "STEPS" || props.component === "CHECKLIST") return 0.8;
  if (props.component === "CTA") return 0.5;
  if (props.component === "KINETIC") return 0.35;
  void presetId;
  return 0.6;
}

const PUNCHY = /\b(stop|never|nobody|no one|most people|keep|don'?t|free money|trap|instead|before)\b/i;

/** Pure: choose the graphics. Returns picks (time-sorted) + every rejection with its reason. */
export function chooseVisuals(input: VisualsInput): { picks: VisualPick[]; rejected: VisualRejection[] } {
  const rejected: VisualRejection[] = [];
  const cands: Array<VisualPick & { anchorOut: number; minEnd: number; group?: string }> = [];
  const listDone = new Set<number>();
  for (const m of input.moments) {
    const s = m.sentence;
    if (m.outStart < input.hookEndS + 0.4) continue;
    if (s.beat === "GREETING" || s.beat === "SIGN_OFF") continue;
    // Lists: one STEPS graphic at the last step, made of the steps' own words.
    if (s.beat === "LIST_ITEM" && !listDone.has(s.id)) {
      const run = input.moments.filter((x) => x.sentence.beat === "LIST_ITEM" && Math.abs(x.sentence.id - s.id) <= 6 && x.sentence.id >= s.id);
      const steps: VisualMoment[] = [];
      for (const x of run) {
        if (steps.length && x.sentence.id - steps[steps.length - 1]!.sentence.id > 2) break;
        steps.push(x);
      }
      steps.forEach((x) => listDone.add(x.sentence.id));
      // Each step as a small tag in his words while he says it (fits around a centred head).
      const tag = presetById("lower-third-tag");
      const labels = steps.length >= 2 ? listGraphic(steps.map((x) => x.sentence))?.items.map((i) => i.text) : null;
      if (tag && labels) {
        const group = `list-${s.id}`;
        steps.forEach((x, k) => {
          const r = GraphicPropsSchema.safeParse({ ...tag.props, preset: tag.id, title: labels[k], subtitle: null });
          if (!r.success) return;
          cands.push({
            visual: makeVisual(`fe-v-${x.sentence.id}-step`, tag, r.data, x.outStart, x.outEnd, x.sentence.text),
            presetId: tag.id,
            presetName: `Step ${k + 1} tag`,
            sentenceId: x.sentence.id,
            reason: `Step ${k + 1} of your ${steps.length}, in your words`,
            match: input.weakMatch,
            score: 1.5,
            numbers: [],
            anchorOut: x.outStart,
            minEnd: x.outEnd + 0.1,
            group,
          });
        });
      }
      const props = listGraphic(steps.map((x) => x.sentence));
      if (props && steps.length >= 2) {
        const last = steps[steps.length - 1]!;
        const preset = presetById("steps-debt-plan")!;
        const match = cosine(m.vec, input.presetVec(preset) ?? []);
        cands.push({
          visual: makeVisual(`fe-v-${s.id}`, preset, props, last.outStart, last.outStart + 3.5, s.text),
          presetId: preset.id,
          presetName: "Your steps",
          sentenceId: last.sentence.id,
          reason: `Your ${steps.length} steps, in your words`,
          match: Math.max(match, input.weakMatch),
          score: 1.6,
          numbers: [],
          anchorOut: last.outStart,
          minEnd: last.outEnd + 0.6,
        });
      }
      continue;
    }
    if (s.beat === "CTA") {
      const verb = /\b(follow|comment|save|share|send)\b/i.exec(s.text)?.[1]?.toLowerCase();
      const preset = presetById(verb === "comment" ? "cta-comment" : verb === "save" ? "cta-save" : verb === "share" || verb === "send" ? "cta-share" : "cta-follow");
      // Start at the action itself ("If this helped, follow for more" → "Follow for more").
      const fromVerb = s.text.replace(/[.!?]+$/, "").replace(/^[\s\S]*?\b(follow|comment|save|share|send)\b/i, (_m, v: string) => v.charAt(0).toUpperCase() + v.slice(1));
      const words = fromVerb.split(/\s+/);
      // Short enough to show whole on the CTA bar (≈ 20 characters).
      let n = Math.min(words.length, 6);
      let title = words.slice(0, n).join(" ");
      while (n > 2 && (title.length > 20 || /\b(?:the|a|to|of|and|that|for|you|your|i'll|me|money|stuff)$/i.test(title))) title = words.slice(0, --n).join(" ");
      title = title.replace(/[,;:]+$/, "");
      const r = preset ? GraphicPropsSchema.safeParse({ ...preset.props, preset: preset.id, title: title.charAt(0).toUpperCase() + title.slice(1), subtitle: null }) : null;
      if (preset && r?.success && title.length >= 4 && graphicNumbers(r.data).every((v) => s.numbers.some((n) => sameNumber(n.value, v)))) {
        cands.push({
          visual: makeVisual(`fe-v-${s.id}-cta`, preset, r.data, m.outStart, m.outEnd + 0.4, s.text),
          presetId: preset.id,
          presetName: "Call to action",
          sentenceId: s.id,
          reason: "Your call to action, in your words",
          match: input.weakMatch,
          score: 0.9,
          numbers: graphicNumbers(r.data),
          anchorOut: m.outStart,
          minEnd: m.outEnd + 0.4,
        });
      }
      continue;
    }
    const sugg = suggestGraphics(s.text, 10);
    for (const g of sugg) {
      const preset = g.preset;
      let props = GraphicPropsSchema.safeParse(g.props).success ? (GraphicPropsSchema.parse(g.props) as GraphicProps) : null;
      if (!props || preset.template !== "GRAPHIC") continue;
      const spec = GRAPHIC_COMPONENT_SPECS[props.component];
      // Never a full-screen scene over Chris's face.
      if (spec.kind === "FULL_FRAME") {
        rejected.push({ sentenceId: s.id, presetId: preset.id, reason: "Full-screen — would hide your face" });
        continue;
      }
      if (props.screen === "FULL") props = { ...props, screen: "OVERLAY" };
      if (props.component === "KINETIC" && !(s.wordCount <= 9 && PUNCHY.test(s.text))) continue;
      if (props.component === "CTA") continue;
      const grounded = groundTexts(props, input.vocabulary);
      if (!grounded) {
        rejected.push({ sentenceId: s.id, presetId: preset.id, reason: "Its text isn't something you said" });
        continue;
      }
      props = grounded;
      // Verification (hard): every number shown was said — in THIS line (continuity).
      const shown = graphicNumbers(props);
      const said = s.numbers.map((n) => n.value);
      const bad = shown.filter((v) => !said.some((x) => sameNumber(x, v)));
      if (bad.length) {
        rejected.push({ sentenceId: s.id, presetId: preset.id, reason: `Would show ${bad.slice(0, 3).join(", ")} — not what you said here` });
        continue;
      }
      if (shown.length && !shown.every((v) => input.spoken.some((n) => sameNumber(n.value, v)))) continue;
      const pv = input.presetVec(preset);
      const match = pv ? cosine(m.vec, pv) : input.weakMatch;
      // Explicit-number graphics are grounded by the number itself; others must match in meaning.
      if (shown.length === 0 && match < input.weakMatch && props.component !== "STEPS") {
        rejected.push({ sentenceId: s.id, presetId: preset.id, reason: `Weak meaning match (${match.toFixed(2)})` });
        continue;
      }
      const real = s.numbers.filter((n) => !n.minor);
      const anchorW = real[0]?.w0 ?? s.w0;
      const anchorOut = m.wordOut(anchorW) ?? m.outStart;
      const score = kindWeight(preset.id, g.reason, props) + 0.8 * match + (shown.length ? 0.4 : 0) + (s.beat === "NUMBER" ? 0.3 : 0);
      cands.push({
        visual: makeVisual(`fe-v-${s.id}-${preset.id}`, preset, props, anchorOut, anchorOut + 3, s.text),
        presetId: preset.id,
        presetName: preset.name,
        sentenceId: s.id,
        reason: g.reason,
        match: Math.round(match * 100) / 100,
        score: Math.round(score * 100) / 100,
        numbers: shown,
        anchorOut,
        minEnd: m.outEnd + 0.3,
      });
    }
  }

  // Density + no stacking: best first, at least `gap` apart, at most one per sentence.
  const per = input.secondsPerVisual ?? 8;
  const cap = Math.max(1, Math.round((input.durationS - input.hookEndS) / per));
  const gap = 2.0;
  const chosen: typeof cands = [];
  let units = 0;
  const doneGroups = new Set<string>();
  // Variety: each earlier use of the same preset costs 0.5 (three identical big numbers read as a template).
  const uses = new Map<string, number>();
  const remaining = [...cands];
  const nextBest = () => {
    let bi = -1;
    let bs = -Infinity;
    remaining.forEach((c, i) => {
      const s = c.score - 0.5 * (uses.get(c.presetId) ?? 0);
      if (s > bs + 1e-9 || (Math.abs(s - bs) < 1e-9 && bi >= 0 && c.anchorOut < remaining[bi]!.anchorOut)) {
        bs = s;
        bi = i;
      }
    });
    return bi < 0 ? null : remaining.splice(bi, 1)[0]!;
  };
  for (let c = nextBest(); c; c = nextBest()) {
    if (units >= cap) break;
    if (input.exclude?.has(`${c.sentenceId}:${c.presetId}`)) continue;
    if (chosen.some((x) => x.sentenceId === c.sentenceId)) continue;
    if (c.group) {
      // A list's step tags go in together (or not at all), back to back.
      if (doneGroups.has(c.group)) continue;
      doneGroups.add(c.group);
      const members = cands.filter((x) => x.group === c.group).sort((a, b) => a.anchorOut - b.anchorOut);
      if (members.some((x) => input.exclude?.has(`${x.sentenceId}:${x.presetId}`))) continue;
      const placed = members.map((x, k) => {
        const start = Math.max(input.hookEndS + 0.3, x.anchorOut - 0.08);
        const next = members[k + 1];
        const end = Math.min(input.durationS - 0.25, next ? next.anchorOut - 0.2 : Math.max(start + 2.2, x.minEnd));
        return { x, start, end };
      });
      if (placed.some((p) => p.end - p.start < 1.2)) continue;
      const g0 = placed[0]!.start;
      const g1 = placed[placed.length - 1]!.end;
      if (chosen.some((x) => g0 < x.visual.end + gap && x.visual.start < g1 + gap)) continue;
      for (const p of placed) {
        p.x.visual = { ...p.x.visual, start: r3(p.start), end: r3(p.end), enterSfx: p.x === placed[0]!.x ? p.x.visual.enterSfx : "TICK" };
        chosen.push(p.x);
      }
      units++;
      continue;
    }
    const start = Math.max(input.hookEndS + 0.3, c.anchorOut - 0.08);
    const read = readSeconds(c.visual);
    let end = Math.min(input.durationS - 0.25, Math.max(start + read, c.minEnd), start + 5.5);
    if (end - start < 1.6) continue;
    const clash = chosen.find((x) => start < x.visual.end + gap && x.visual.start < end + gap);
    if (clash) {
      // Shorten to fit before the next one if it still reads.
      if (clash.visual.start > start && clash.visual.start - gap - start >= Math.max(2, read * 0.8)) end = clash.visual.start - gap;
      else continue;
    }
    c.visual = { ...c.visual, start: r3(start), end: r3(end) };
    chosen.push(c);
    uses.set(c.presetId, (uses.get(c.presetId) ?? 0) + 1);
    units++;
  }
  const picks = chosen.sort((a, b) => a.visual.start - b.visual.start).map(({ anchorOut: _a, minEnd: _m, group: _g, ...p }) => p);
  return { picks, rejected };
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Seconds to read a graphic: ~1.4 s + 0.22 s per word/number on it (max 5.5). */
export function readSeconds(v: TimelineVisual): number {
  const p = v.props as unknown as GraphicProps;
  const texts = [p.title, p.subtitle, p.body, ...p.items.map((i) => i.text), ...p.series.map((s) => s.label)].filter(Boolean).join(" ");
  const n = tokens(texts).length + (graphicNumbers(p).length || 0);
  return Math.min(5.5, Math.max(2.2, 1.4 + 0.22 * n));
}

function makeVisual(id: string, preset: GraphicPreset, props: GraphicProps, start: number, end: number, anchor: string): TimelineVisual {
  return {
    id,
    template: "GRAPHIC",
    props: { ...(props as unknown as Record<string, unknown>), preset: preset.id },
    start: r3(start),
    end: r3(end),
    placement: { mode: "AUTO", x: preset.placement?.x ?? 0.5, y: preset.placement?.y ?? 0.3, scale: 1 },
    palette: preset.palette ?? "BRAND",
    enter: "AUTO",
    exit: "AUTO",
    enterSfx: (preset.enterSfx === undefined ? "SOFT_POP" : preset.enterSfx) as SfxSound | null,
    anchorText: anchor.slice(0, 200),
    ...VISUAL_INTERACTION_DEFAULTS,
  };
}

/** Preset text for meaning-match embeddings ("Big number — salary. One hero number…"). */
export function presetDescription(p: GraphicPreset): string {
  return `${p.name}. ${p.description} ${p.tags.join(", ")}`;
}

export const ALL_GRAPHIC_PRESETS = GRAPHIC_PRESETS;
