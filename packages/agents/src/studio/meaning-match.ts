import { flattenShots, type StudioFilm, type StudioShot } from "./film-types";
import type { FilmCatalog, ShotFacts } from "./engine-port";
import { applyShot, describeShotPicture, lineIdForShot, worldBeforeEachShot, type WorldState } from "./deterministic";
import type { FilmScript, MeaningCheck, MeaningMatchReport, MeaningVerdict } from "./schemas";

/**
 * Meaning-Match FIRST PASS — free and automatic. For every narrated shot: does the PICTURE show
 * what the LINE says? Two deterministic signals:
 *
 *  1. Concept rules (the strong signal): when a line names a concept the engine has a literal
 *     picture for ("you raised your baseline" → a BASELINE plane whose level rises while it's in
 *     frame; "gone" → something exits/drains; "compound growth" → a chart grows; "rent" → the
 *     building is on screen…), the shot must contain that picture. Violations are MISMATCH and the
 *     orchestrator will not let the Director approve over them while revision rounds remain.
 *  2. Sentence embeddings (the soft signal): cosine similarity between the line and a plain-words
 *     description of what the shot shows (actors on screen, what changes, camera — on-screen text
 *     that just repeats the line is excluded, it isn't picture). Low similarity = WEAK, with the
 *     closest catalog alternatives as the suggested replacement. Advisory only.
 *
 * The embedder is a port: the app uses a small local sentence-embedding model
 * (`@chris/media/embeddings`, all-MiniLM-L6-v2, Apache-2.0, runs on CPU, $0); tests and any host
 * where the model can't load use `LexicalEmbedder` (hashed word stems — deterministic, worse at
 * synonyms, and labelled as such in the report).
 */

export interface TextEmbedder {
  readonly id: string;
  /** Similarity bands for this embedder: ≥ match → MATCH, ≥ weak → WEAK, else low. */
  readonly thresholds: { match: number; weak: number };
  embed(texts: string[]): Promise<number[][]>;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const STOP = new Set("a an the and or but of to in on at for is are was were be been it its this that these those you your yours i we our they their he she his her with as by from so just not no do does did have has had what when where how which who will would can could than then there here".split(" "));

export function stem(w: string): string {
  return w
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(ings|ing|edly|ed|es|s|ly)$/, "")
    .replace(/(.)\1$/, "$1");
}

/** Deterministic fallback embedder: hashed word stems (+ bigrams) into 512 dims. */
export class LexicalEmbedder implements TextEmbedder {
  readonly id = "lexical-hash-v1";
  readonly thresholds = { match: 0.3, weak: 0.12 };
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(512).fill(0);
      const words = t.split(/\s+/).map(stem).filter((w) => w && !STOP.has(w));
      const add = (tok: string, weight: number) => {
        let h = 2166136261;
        for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
        v[Math.abs(h) % 512]! += weight;
      };
      words.forEach((w, i) => {
        add(w, 1);
        if (i > 0) add(`${words[i - 1]}_${w}`, 0.5);
      });
      return v;
    });
  }
}

/** Uses the local model; if it can't load (no network on first run, missing native runtime),
 * degrades to the lexical embedder for that call — and says so through `id`. */
export class FallbackEmbedder implements TextEmbedder {
  private usingFallback = false;
  private readonly fallback = new LexicalEmbedder();
  lastError: string | null = null;
  constructor(private readonly primary: TextEmbedder) {}
  get id() {
    return this.usingFallback ? `${this.fallback.id} (local model unavailable)` : this.primary.id;
  }
  get thresholds() {
    return this.usingFallback ? this.fallback.thresholds : this.primary.thresholds;
  }
  async embed(texts: string[]): Promise<number[][]> {
    try {
      const v = await this.primary.embed(texts);
      this.usingFallback = false;
      return v;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.usingFallback = true;
      return this.fallback.embed(texts);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Concept rules

interface RuleCtx {
  film: StudioFilm;
  shot: StudioShot;
  before: WorldState;
  after: WorldState;
  facts: ShotFacts | null;
}

interface ConceptRule {
  id: string;
  when: RegExp;
  /** null = the shot shows it; otherwise what's missing. */
  check: (c: RuleCtx) => string | null;
  replacement: { description: string; catalogRefs: string[]; dslHint: string };
}

const idsOfKind = (film: StudioFilm, kinds: string[]) => film.cast.filter((a) => kinds.includes(a.kind)).map((a) => a.id);

function onScreen(c: RuleCtx, id: string): boolean {
  const entering = (c.shot.actions ?? []).some((a) => a.do === "ENTER" && a.actor === id);
  const visible = c.before.get(id)?.visible === true || entering;
  const inFrame = c.facts?.actors.find((a) => a.id === id)?.inFrame;
  return visible && inFrame !== false;
}

function anyOnScreen(c: RuleCtx, kinds: string[]): boolean {
  return idsOfKind(c.film, kinds).some((id) => onScreen(c, id));
}

function changes(c: RuleCtx, pred: (a: NonNullable<StudioShot["actions"]>[number], before: WorldState) => boolean): boolean {
  return (c.shot.actions ?? []).some((a) => pred(a, c.before));
}

export const CONCEPT_RULES: ConceptRule[] = [
  {
    id: "BASELINE_RISES",
    when: /\b(rais(e|ed|es|ing)|lift(s|ed)?|bump(ed)?|went up|goes up|higher|rose|ris(e|es|ing))\b[^.?!]*\b(baseline|floor|new normal|standard of living)\b|\b(baseline|floor|new normal|standard of living)\b[^.?!]*\b(ris(e|es|ing)|rose|went up|goes up|higher|raised)\b/i,
    check: (c) => {
      // BASELINE = the glowing level plane (v1); PLATFORM = the solid floor that RAISEs and lifts
      // what rides on it (v1.1 — the literal "the floor under your life goes up").
      const baselines = idsOfKind(c.film, ["BASELINE", "PLATFORM"]);
      if (!baselines.length) return "there is no BASELINE or PLATFORM in the cast at all — nothing on screen is a floor/level";
      const levelTo = (a: NonNullable<StudioShot["actions"]>[number]): number | null =>
        a.do === "SET" && a.param === "level" && typeof a.to === "number" ? a.to : a.do === "RAISE" && typeof a.to === "number" ? a.to : null;
      const rising = baselines.filter((id) => changes(c, (a, w) => a.actor === id && (levelTo(a) ?? -Infinity) > (w.get(id)?.level ?? 0)));
      if (!rising.length) return "no baseline/floor rises during the line (needs a RAISE on a PLATFORM, or a SET level going UP on the BASELINE)";
      if (!rising.some((id) => onScreen(c, id))) return "the rising baseline is not on screen/in frame while it's said";
      const things = idsOfKind(c.film, ["BUILDING", "CAR", "CARD", "CARD_FAN"]).filter((id) => c.before.get(id)?.everEntered || c.before.get(id)?.visible);
      if (things.length && !things.some((id) => onScreen(c, id))) return "the floor rises alone — the things that raised it (apartment, car, subscriptions) aren't in frame, so it doesn't read as YOUR lifestyle rising";
      // A baseline is the floor your life stands on: if it rises THROUGH the apartment and the car
      // (they stay on the ground) it reads as a glow passing by, not as the floor going up.
      const target = Math.max(...rising.map((id) => {
        const a = (c.shot.actions ?? []).find((x) => x.actor === id && levelTo(x) !== null);
        return a ? (levelTo(a) ?? 0) : 0;
      }));
      const visibleThings = things.filter((id) => onScreen(c, id));
      // carried = moved up with it, or riding on the rising floor (cast `parent` chain)
      const ridesOn = (id: string): boolean => {
        let p = c.film.cast.find((x) => x.id === id)?.parent;
        for (let i = 0; p && i < 8; i++) {
          if (rising.includes(p)) return true;
          p = c.film.cast.find((x) => x.id === p)?.parent;
        }
        return false;
      };
      const carried = visibleThings.filter((id) => ridesOn(id) || (c.shot.actions ?? []).some((a) => a.actor === id && a.do === "MOVE" && a.to[1] >= target * 0.6));
      if (visibleThings.length && target > 0.3 && !carried.length) return `the baseline rises to ${target} m THROUGH the ${visibleThings.join(" and ")} while they stay on the ground — it reads as a glow passing by, not as the floor under your life going up`;
      return null;
    },
    replacement: {
      description: "The glowing YOUR BASELINE plane rises from the floor UNDER the apartment and the car and lifts them with it (they ride on it, in frame) to the height the raise used to stand — the floor itself going up.",
      catalogRefs: ["recipe:raise-baseline", "actor:PLATFORM", "action:RAISE", "actor:BASELINE", "action:SET.level", "action:MOVE", "actor:BUILDING", "actor:CAR", "camera:CRANE_UP"],
      dslHint: '{"do":"SET","actor":"baseline","param":"level","to":1.8,"at":{"word":"raised"},"duration":1.6} plus {"do":"MOVE","actor":"building","to":[x,1.8,z],"at":{"word":"raised"},"duration":1.6} and the same for the car; camera CRANE_UP on the baseline wide enough (distance ≥ 11) to keep both in frame.',
    },
  },
  {
    id: "GONE",
    when: /\b(gone|disappear(s|ed)?|vanish(es|ed)?|evaporat\w*|wiped out|nothing left|spent it all)\b/i,
    check: (c) => {
      const loses = changes(c, (a, w) => a.do === "EXIT" || a.do === "FLOW" || (a.do === "SET" && a.param === "count" && typeof a.to === "number" && a.to < (w.get(a.actor)?.count ?? Infinity)));
      const strike = (c.shot.text ?? []).some((t) => t.strikeAt !== undefined ||/^\$?0$/.test(t.text.trim()));
      const empty = [...c.before].filter(([, s]) => s.visible).length <= 1 && !c.shot.actions?.some((a) => a.do === "ENTER");
      return loses || strike || empty ? null : "nothing disappears, drains or gets struck through while the line says it's gone";
    },
    replacement: { description: "The money visibly leaves: the coin stack drains/dissolves or the number gets struck through to $0.", catalogRefs: ["action:EXIT", "action:SET.count", "text:HERO_NUMBER"], dslHint: '{"do":"EXIT","actor":"<stack>","style":"DISSOLVE","at":{"word":"gone"}} or a HERO_NUMBER "$0" / strikeAt on the amount.' },
  },
  {
    id: "GROWTH",
    when: /\b(grow(s|n|ing)?|compound(s|ed|ing)?|snowball\w*|multipl(y|ies)|over \w+ years|year after year)\b/i,
    check: (c) => (changes(c, (a, w) => (a.do === "SET" && a.param === "progress") || (a.do === "SET" && a.param === "count" && typeof a.to === "number" && a.to > (w.get(a.actor)?.count ?? 0)) || (a.do === "SCALE" && a.to > 1)) || anyOnScreen(c, ["COIN_CHART"]) ? null : "nothing grows on screen while the line talks about growth"),
    replacement: { description: "A coin chart sculpture grows column by column (one column per year).", catalogRefs: ["actor:COIN_CHART", "action:SET.progress", "camera:TRUCK"], dslHint: '{"do":"SET","actor":"chart","param":"progress","to":1,"at":0,"duration":3}' },
  },
  {
    id: "MONEY_TAKEN",
    when: /\b(tax(es)? take|takes? \$?\d|eats?|costs? you|pays? for|goes to|went to|drains?)\b/i,
    check: (c) => (changes(c, (a, w) => a.do === "FLOW" || a.do === "EXIT" || (a.do === "SET" && a.param === "count" && typeof a.to === "number" && a.to < (w.get(a.actor)?.count ?? Infinity))) ? null : "no money leaves the pile while the line says something takes it"),
    replacement: { description: "Coins stream out of the pile into what takes them.", catalogRefs: ["action:FLOW", "actor:COIN_STACK"], dslHint: '{"do":"FLOW","actor":"<stack>","into":"<thing>","amount":<coins>,"at":{"word":"<verb>"}}' },
  },
  ...(
    [
      ["RENT_BUILDING", /\b(rent|apartment|condo|housing|mortgage|place to live)\b/i, ["BUILDING"], "actor:BUILDING", "the apartment (BUILDING) is not on screen"],
      ["CAR", /\b(car|truck|lease|car payment)\b/i, ["CAR"], "actor:CAR", "the car is not on screen"],
      ["SUBSCRIPTIONS", /\b(subscriptions?|streaming|memberships?|bills?)\b/i, ["CARD", "CARD_FAN"], "actor:CARD_FAN", "no subscription cards are on screen"],
    ] as const
  ).map(
    ([id, when, kinds, ref, missing]): ConceptRule => ({
      id,
      when,
      check: (c) => (anyOnScreen(c, [...kinds]) ? null : missing),
      replacement: { description: `Show ${missing.replace(/ is not on screen| are on screen/, "").replace(/^no |^the /, "the ")} in frame while it's named.`, catalogRefs: [ref], dslHint: `ENTER the ${kinds[0]} actor at the word, camera target on it.` },
    }),
  ),
];

// ---------------------------------------------------------------------------------------------

export interface MeaningDetail {
  shotId: string;
  similarity: number | null;
  ruleIds: string[];
  /** Rule-based MISMATCH — the strong signal the Director can't approve over while rounds remain. */
  forcing: boolean;
  alternatives: Array<{ id: string; score: number }>;
  picture: string;
}

export interface MeaningFirstPass {
  report: MeaningMatchReport;
  details: MeaningDetail[];
  embedderId: string;
}

export async function runMeaningMatchFirstPass(input: { film: StudioFilm; script: FilmScript | null; catalog: FilmCatalog; embedder: TextEmbedder; facts?: ShotFacts[] | null }): Promise<MeaningFirstPass> {
  const { film, catalog, embedder } = input;
  const byId = new Map(catalog.entries.map((e) => [e.id, e]));
  const describe = (id: string) => byId.get(id)?.depicts ?? null;
  const worlds = worldBeforeEachShot(film);
  const narrated = flattenShots(film).filter((f) => f.shot.line);
  const pictures = narrated.map(({ shot }) => describeShotPicture(film, shot, worlds.get(shot.id)!, describe, input.facts?.find((x) => x.shotId === shot.id) ?? null));
  const visualEntries = catalog.entries.filter((e) => e.kind === "ACTOR" || e.kind === "ACTION");
  const entryTexts = visualEntries.map((e) => `${e.depicts}. ${e.goodFor.join(", ")}`);
  const vecs = await embedder.embed([...narrated.map((f) => f.shot.line!), ...pictures, ...entryTexts]);
  const n = narrated.length;
  const checks: MeaningCheck[] = [];
  const details: MeaningDetail[] = [];
  narrated.forEach(({ shot }, i) => {
    const lineVec = vecs[i]!;
    const sim = cosine(lineVec, vecs[n + i]!);
    const alternatives = visualEntries.map((e, k) => ({ id: e.id, score: cosine(lineVec, vecs[2 * n + k]!) })).sort((a, b) => b.score - a.score).slice(0, 3);
    const before = worlds.get(shot.id)!;
    const ctx: RuleCtx = { film, shot, before, after: applyShot(before, shot), facts: input.facts?.find((x) => x.shotId === shot.id) ?? null };
    const fired = CONCEPT_RULES.filter((r) => r.when.test(shot.line!));
    const failures = fired.map((r) => ({ r, problem: r.check(ctx) })).filter((x): x is { r: ConceptRule; problem: string } => x.problem !== null);
    let verdict: MeaningVerdict;
    if (failures.length) verdict = "MISMATCH";
    else if (fired.length) verdict = "MATCH";
    else verdict = sim >= embedder.thresholds.match ? "MATCH" : "WEAK";
    if (!fired.length && sim < embedder.thresholds.weak) verdict = "WEAK";
    const lineId = input.script ? lineIdForShot(input.script, shot) : null;
    const evidence = [
      { kind: "LINE" as const, ref: lineId ?? shot.id, detail: shot.line! },
      { kind: "SHOT" as const, ref: shot.id, detail: pictures[i]! },
      { kind: "CALC" as const, ref: `similarity:${embedder.id}`, detail: `line ↔ picture similarity ${sim.toFixed(2)} (match ≥ ${embedder.thresholds.match})` },
      ...fired.map((r) => ({ kind: "DSL" as const, ref: `rule:${r.id}`, detail: failures.find((f) => f.r === r)?.problem ?? "the shot shows it" })),
    ];
    const replacement =
      verdict === "MATCH"
        ? null
        : failures.length
          ? failures[0]!.r.replacement
          : { description: `Show it literally — closest things the engine can show: ${alternatives.map((a) => byId.get(a.id)?.depicts).join("; ")}.`, catalogRefs: alternatives.map((a) => a.id), dslHint: alternatives.map((a) => byId.get(a.id)?.usage ?? a.id).join(" | ") };
    checks.push({
      shotId: shot.id,
      lineId,
      line: shot.line!,
      meaning: fired.length ? `Names: ${fired.map((r) => r.id.toLowerCase().replace(/_/g, " ")).join(", ")}` : "No literal concept rule applies — judged by similarity only.",
      shown: pictures[i]!,
      verdict,
      evidence,
      replacement,
    });
    details.push({ shotId: shot.id, similarity: sim, ruleIds: fired.map((r) => r.id), forcing: failures.length > 0, alternatives, picture: pictures[i]! });
  });
  const mism = checks.filter((c) => c.verdict === "MISMATCH").length;
  const weak = checks.filter((c) => c.verdict === "WEAK").length;
  return {
    report: { checks: checks.length ? checks : [{ shotId: "film", lineId: null, line: "", meaning: "No narrated shots.", shown: "—", verdict: "WEAK", evidence: [{ kind: "DSL", ref: "film", detail: "no shot has a line" }], replacement: { description: "Add narration lines to the shots.", catalogRefs: ["text:STATEMENT"], dslHint: "shot.line" } }], summary: `${checks.length} lines checked: ${checks.length - mism - weak} match, ${weak} weak, ${mism} mismatch (first pass: concept rules + ${embedder.id}).` },
    details,
    embedderId: embedder.id,
  };
}
