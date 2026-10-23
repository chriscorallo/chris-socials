import type { TranscriptWord } from "../caption-chunking";
import type { FESentence } from "./understand";
import { CHOICE } from "./hook";
import { isHedgy } from "./understand";
import { bare, contentStems, jaccard, tokens } from "./text";

/**
 * Story bot (PURE) — turns a ramble into a tight story, Chris's rule: "like a conversation
 * where you only need to say things once. No extra, straight to the point."
 *
 * 1. Mechanical cleanup: retakes / false starts (keep the LAST complete take), restarts inside
 *    a sentence ("a lot of people, uh, a lot of people think…"), filler words, throat-clearing
 *    lead-ins ("So basically, I think, …") — only where both cut points sit on a measured pause.
 * 2. Say each thing ONCE: sentences that make the same point anywhere in the take (sentence
 *    embeddings + word overlap) collapse to the single best version (most concrete, complete,
 *    best delivered).
 * 3. Fluff out: greetings, "in this video", recaps, sign-offs, tangents ("by the way…"),
 *    transition lines ("Anyway, where was I"), filler lines.
 * 4. Length: the reference videos' length is the target (their median, p25–p75 band). Lowest-
 *    value lines go first until the story fits, protecting the arc (hook → context → points →
 *    payoff) — a list's steps go together, and a line that points back ("That's how they make
 *    money") never survives without the line it points to.
 * Every removal carries its reason so the editor can list it and restore it in one tap.
 */

export type RemovalKind =
  | "RETAKE"
  | "REPEAT"
  | "FLUFF"
  | "TANGENT"
  | "GREETING"
  | "META"
  | "SIGN_OFF"
  | "RECAP"
  | "LOW_VALUE"
  | "DANGLING"
  | "EXTRA_CTA"
  | "SLOW_START"
  | "TRAILING"
  | "HOOK_MOVED";

export interface SentenceDecision {
  id: number;
  kept: boolean;
  kind: RemovalKind | null;
  why: string;
  /** Story value (higher = more worth its seconds). */
  value: number;
  /** For REPEAT / RETAKE: the line kept instead. */
  keptInstead: number | null;
  /** Chris restored it (or forced it out). */
  forced: boolean;
}

export interface WordCut {
  w0: number;
  w1: number;
  kind: "FILLER" | "RESTART" | "LEAD_IN" | "TRIM";
  text: string;
}

export interface StoryTarget {
  /** Aim for this length (s) — the references' median video length. */
  targetS: number;
  /** Their p25–p75 band. */
  minS: number;
  maxS: number;
  source: "REFERENCES" | "DEFAULTS";
}

export const DEFAULT_STORY_TARGET: StoryTarget = { targetS: 58, minS: 45, maxS: 70, source: "DEFAULTS" };

export interface StoryInput {
  words: TranscriptWord[];
  sentences: FESentence[];
  /** Pairwise sentence similarity (embedding cosine), [i][j]. */
  sim: number[][];
  /** "Same point" score threshold (see step 3). */
  sameThreshold: number;
  /** The take's topic words (stems) — shared by every line, so they don't count as overlap. */
  topicStems?: Set<string>;
  /** Topic centrality per sentence (0..1). */
  relevance: number[];
  /** Can we cut between word k and k+1 without clipping a word? (k = -1 → before the first). */
  safeAfter: (k: number) => boolean;
  /** Estimated seconds a set of word ranges will last after pause tightening. */
  estimateS: (spans: Array<{ w0: number; w1: number }>) => number;
  target: StoryTarget;
  /** Hook sentence ids (chosen by the hook bot) — protected, played first. */
  hookIds: number[];
  /** Chris's overrides from the "Removed lines" list. */
  forceKeep?: number[];
  forceDrop?: number[];
  /** Sentence ids that carry the Creative Brief's midpoint / payoff / ending — protected from
   * length trims (the arc the video was planned around survives the cut). */
  protect?: number[];
}

export interface StoryPlan {
  decisions: SentenceDecision[];
  wordCuts: WordCut[];
  /** Playback order: word spans (inclusive), hook first when it's a cold open. */
  order: Array<{ w0: number; w1: number; role: "HOOK" | "STORY"; sentenceIds: number[] }>;
  coldOpen: boolean;
  /** The hook line also stays in its original place (the next line depends on it). */
  hookReplayed: boolean;
  estimatedS: number;
  /** Lines kept although they look like fluff/tangents (shown, not removed). */
  marked: Array<{ id: number; note: string }>;
}

const FILLER_WORDS = new Set(["um", "uh", "er", "erm", "ah", "hmm", "mm", "uhm", "eh"]);
/** Doubles people say on purpose — never cut as a stutter. */
const DELIBERATE_DOUBLE = new Set(["very", "really", "no", "yes", "boom", "big", "long", "way", "far", "more", "much", "many", "bye", "go", "wait", "okay", "ok"]);
const LEAD_IN = /^(?:so|okay|ok|alright|basically|honestly|look|like|well|and|i mean|i think|i guess|i don't know|i feel like|you know|um|uh|right|anyway|anyways|now)$/i;

const BEAT_VALUE: Record<string, number> = {
  NUMBER: 3.2,
  PAYOFF: 2.8,
  LIST_ITEM: 3.0,
  EXAMPLE: 2.3,
  POINT: 1.3,
  SETUP: 1.2,
  CTA: 1.0,
  TANGENT: 0.2,
  RECAP: 0.1,
  META: 0,
  GREETING: 0,
  SIGN_OFF: 0,
  FLUFF: 0,
};

function sentenceValue(s: FESentence, relevance: number): number {
  let v = BEAT_VALUE[s.beat] ?? 1;
  v += 2 * relevance;
  const real = s.numbers.filter((n) => !n.minor).length;
  v += Math.min(1.5, real * 0.75);
  if (isHedgy(s.text)) v -= 0.8;
  if (s.dependent) v -= 0.2;
  if (s.question && s.wordCount <= 10) v += 0.4;
  if (s.energyDb != null) v += Math.max(-0.4, Math.min(0.5, s.energyDb / 4));
  const dur = s.end - s.start;
  v -= 0.06 * Math.max(0, dur - 4);
  return Math.round(v * 100) / 100;
}

/** "a b c" is (nearly) the start of "a b c d e" — a false start. */
function isFalseStartOf(a: FESentence, b: FESentence): boolean {
  const ta = tokens(a.text).filter((t) => !FILLER_WORDS.has(t));
  const tb = tokens(b.text).filter((t) => !FILLER_WORDS.has(t));
  if (ta.length === 0 || ta.length >= tb.length) return false;
  let same = 0;
  for (let i = 0; i < ta.length; i++) if (ta[i] === tb[i]) same++;
  return same >= Math.max(2, Math.ceil(ta.length * 0.75));
}

/** Pure: the story plan. */
export function planStory(input: StoryInput): StoryPlan {
  const { sentences: S, words, sim } = input;
  const n = S.length;
  const forceKeep = new Set(input.forceKeep ?? []);
  const forceDrop = new Set(input.forceDrop ?? []);
  const hook = new Set(input.hookIds);
  const dec: SentenceDecision[] = S.map((s, i) => ({ id: s.id, kept: true, kind: null, why: "", value: sentenceValue(s, input.relevance[i] ?? 0), keptInstead: null, forced: false }));
  const marked: StoryPlan["marked"] = [];
  /** Length pass 2 only: a line with no pause at an edge may be cut on its word boundary. */
  let allowWordEdgeCuts = false;
  const drop = (i: number, kind: RemovalKind, why: string, keptInstead: number | null = null) => {
    const d = dec[i]!;
    if (!d.kept || forceKeep.has(d.id)) return false;
    if (hook.has(d.id) && kind !== "HOOK_MOVED") return false;
    // Never cut a line we can't cut cleanly (no pause at either end) — unless the video would
    // otherwise run far past the references' length (pass 2 below): then a cut between two
    // words beats shipping a video twice as long as the ones that perform.
    const clean = input.safeAfter(S[i]!.w0 - 1) && input.safeAfter(S[i]!.w1);
    if (!clean && !(allowWordEdgeCuts && kind === "LOW_VALUE")) return false;
    d.kept = false;
    d.kind = kind;
    d.why = why;
    d.keptInstead = keptInstead;
    return true;
  };

  // ---- 1. Beats that are never story: greetings, meta, sign-offs, fluff, recaps, tangents.
  S.forEach((s, i) => {
    const rel = input.relevance[i] ?? 0;
    switch (s.beat) {
      case "GREETING":
        drop(i, "GREETING", `Greeting — ${s.beatWhy}`);
        break;
      case "META":
        drop(i, "META", `Talks about the video, not the topic`);
        break;
      case "SIGN_OFF":
        drop(i, "SIGN_OFF", "Sign-off — the video ends on your point");
        break;
      case "FLUFF":
        drop(i, "FLUFF", `Filler line — ${s.beatWhy}`);
        break;
      case "RECAP":
        drop(i, "RECAP", "Recap — you already said each of these");
        break;
      case "TANGENT": {
        // A side story with a real number that's on topic is kept but flagged.
        if (s.numbers.some((x) => !x.minor) && rel >= 0.5) marked.push({ id: s.id, note: `Possible tangent kept (${s.beatWhy}) — it has a number on your topic` });
        else drop(i, "TANGENT", `Tangent — ${s.beatWhy}`);
        break;
      }
      default:
        break;
    }
  });

  // ---- 2. Retakes / false starts: an earlier attempt of the next line(s) — keep the last take.
  for (let i = 0; i < n; i++) {
    if (!dec[i]!.kept) continue;
    for (let j = i + 1; j < Math.min(n, i + 3); j++) {
      if (!dec[j]!.kept) continue;
      const a = S[i]!;
      const b = S[j]!;
      const lex = jaccard(contentStems(a.text), contentStems(b.text));
      if (isFalseStartOf(a, b) || lex >= 0.6) {
        if (hook.has(a.id) && !hook.has(b.id)) continue;
        drop(i, "RETAKE", `Retake — you said it again right after (“${short(b.text)}”)`, b.id);
        break;
      }
    }
  }

  // ---- 3. Say it once: same point anywhere in the take → keep the best version.
  // Sentence embeddings alone mostly measure TOPIC (every line of a credit-card video is "about
  // the minimum payment"), so `sim` is topic-centred cosine, combined with the overlap of the
  // words that AREN'T the topic, closeness in the take, and restatement cues ("basically…",
  // "it really is…", "in other words"). Measured on the 3-minute test take (decision record).
  const topic = input.topicStems ?? new Set<string>();
  const distinct = (t: string) => contentStems(t).filter((x) => !topic.has(x));
  const RESTATE = /\b(basically|in other words|it really is|again|like i said|i mean|honestly|what i'm saying is)\b/i;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!dec[i]!.kept || !dec[j]!.kept) continue;
      const dj = jaccard(distinct(S[i]!.text), distinct(S[j]!.text));
      const s = sim[i]?.[j] ?? 0;
      const near = S[j]!.id - S[i]!.id <= 2;
      const score = 0.5 * s + dj + (near ? 0.15 : 0) + (RESTATE.test(S[j]!.text) || RESTATE.test(S[i]!.text) ? 0.15 : 0);
      const same = (near ? score >= input.sameThreshold : score >= input.sameThreshold + 0.13) && (s >= 0.4 || dj >= 0.3);
      if (!same) continue;
      // A restatement adds (almost) nothing: the shorter line's own words are in the longer one.
      const [shortT, longT] = S[i]!.wordCount <= S[j]!.wordCount ? [S[i]!.text, S[j]!.text] : [S[j]!.text, S[i]!.text];
      const longSet = new Set(distinct(longT));
      const fresh = distinct(shortT).filter((x) => !longSet.has(x));
      if (fresh.length > Math.max(1, Math.floor(distinct(shortT).length * 0.34))) continue;
      // Two list steps are different steps even when they sound alike.
      if (S[i]!.beat === "LIST_ITEM" && S[j]!.beat === "LIST_ITEM") continue;
      // Different real numbers = different facts.
      const ni = S[i]!.numbers.filter((x) => !x.minor).map((x) => x.value);
      const nj = S[j]!.numbers.filter((x) => !x.minor).map((x) => x.value);
      if (ni.length && nj.length && !ni.some((x) => nj.includes(x))) continue;
      const keepJ = hook.has(S[j]!.id) || (!hook.has(S[i]!.id) && dec[j]!.value > dec[i]!.value);
      const [lose, win] = keepJ ? [i, j] : [j, i];
      drop(lose, "REPEAT", `Says the same thing as “${short(S[win]!.text)}”`, S[win]!.id);
    }
  }

  // ---- 4. Extra CTAs: keep one (the last), short.
  const ctas = S.map((s, i) => ({ s, i })).filter(({ s, i }) => s.beat === "CTA" && dec[i]!.kept);
  ctas.slice(0, -1).forEach(({ i }) => drop(i, "EXTRA_CTA", "Second call to action — one is enough"));

  // ---- Chris's overrides.
  S.forEach((s, i) => {
    if (forceKeep.has(s.id)) Object.assign(dec[i]!, { kept: true, kind: null, why: "Restored by you", forced: true });
    if (forceDrop.has(s.id) && dec[i]!.kept && !hook.has(s.id)) Object.assign(dec[i]!, { kept: false, kind: "LOW_VALUE", why: "Removed by you", forced: true });
  });

  // ---- 4b. Start on the hook: weak set-up lines before it go (strong ones stay → cold open).
  if (hook.size) {
    const firstHook = S.findIndex((s) => hook.has(s.id));
    for (let i = 0; i < firstHook; i++) {
      const s = S[i]!;
      if (!dec[i]!.kept || forceKeep.has(s.id)) continue;
      // Only throat-clearing set-up and teasers ("Here's how it works") — a real claim or a
      // number before the hook stays (the hook becomes a cold open instead).
      const teaser = /^(?:(?:so|and|but|okay|ok)[,]?\s+)*(?:here'?s (?:how|what|why|the thing)|let me explain|there'?s something)\b/i.test(s.text) && s.wordCount <= 9;
      const claim = /\b(most people|nobody|no one|everyone|never|always|actually|but|instead|wrong|mistake)\b/i.test(s.text);
      const strong = dec[i]!.value >= 3.4 || s.numbers.some((x) => !x.minor) || s.beat === "PAYOFF" || (claim && !teaser);
      // A question that frames the video ("who would you rather be?") is never throat-clearing.
      if (s.question || CHOICE.test(s.text)) continue;
      if (!strong && (s.beat === "SETUP" || teaser || s.wordCount <= 6)) drop(i, "SLOW_START", "Slow start — the video opens on your hook instead");
    }
  }

  // ---- 5. Word-level cleanup inside kept sentences.
  const wordCuts = wordLevelCuts(words, S, dec, input.safeAfter);

  // ---- 6. Length: drop the lowest-value lines until the story fits the references' length.
  const lastPayoff = [...S.keys()].reverse().find((i) => dec[i]!.kept && (S[i]!.beat === "PAYOFF" || S[i]!.beat === "POINT" || S[i]!.beat === "NUMBER"));
  const protectedIdx = new Set<number>();
  const protect = new Set(input.protect ?? []);
  S.forEach((s, i) => {
    if (hook.has(s.id) || forceKeep.has(s.id) || (protect.has(s.id) && dec[i]!.kept)) protectedIdx.add(i);
  });
  if (lastPayoff != null) protectedIdx.add(lastPayoff);
  // Context: the most valuable setup/point in the first third that isn't the hook.
  const ctx = S.map((s, i) => ({ s, i }))
    .filter(({ s, i }) => dec[i]!.kept && !hook.has(s.id) && s.start <= (S[n - 1]!.end * 0.35) && (s.beat === "SETUP" || s.beat === "POINT" || s.beat === "EXAMPLE" || s.beat === "NUMBER"))
    .sort((a, b) => dec[b.i]!.value - dec[a.i]!.value)[0];
  if (ctx) protectedIdx.add(ctx.i);
  // One call to action stays (the last one).
  const lastCta = [...S.keys()].reverse().find((i) => dec[i]!.kept && S[i]!.beat === "CTA");
  if (lastCta != null) protectedIdx.add(lastCta);

  const units = budgetUnits(S, dec);
  const spansFor = () => keptSpans(S, dec, wordCuts);
  let est = input.estimateS(spansFor());
  const goal = input.target.targetS;
  /** Lines pinned only because they had no clean pause to cut on (released in pass 2). */
  const pinnedForCleanCut = new Set<number>();
  const lengthPass = () => {
  for (let guard = 0; est > goal * 1.04 && guard < 500; guard++) {
    // Cheapest loss of value per second saved.
    let best: { unit: number[]; score: number } | null = null;
    for (const u of units) {
      if (u.every((i) => !dec[i]!.kept)) continue;
      if (u.some((i) => protectedIdx.has(i) && dec[i]!.kept)) continue;
      const kept = u.filter((i) => dec[i]!.kept);
      const items = kept.filter((i) => S[i]!.beat === "LIST_ITEM");
      const isList = items.length >= 2;
      const value = isList ? Math.max(...items.map((i) => dec[i]!.value)) : kept.reduce((a, i) => a + dec[i]!.value, 0) / kept.length;
      const secs = kept.reduce((a, i) => a + (S[i]!.end - S[i]!.start), 0);
      const score = value - (isList ? 0.02 : 0.05) * secs;
      if (!best || score < best.score) best = { unit: kept, score };
    }
    if (!best) break;
    const ok = best.unit.map((i) => drop(i, "LOW_VALUE", best!.unit.length > 1 ? "Trimmed for length — the weakest part of the story (a list goes together)" : "Trimmed for length — says less than the lines kept"));
    if (!ok.some(Boolean)) {
      best.unit.forEach((i) => {
        if (!protectedIdx.has(i)) pinnedForCleanCut.add(i);
        protectedIdx.add(i);
      });
      continue;
    }
    fixDangling(S, dec, protectedIdx, drop);
    est = input.estimateS(spansFor());
  }
  };
  lengthPass();
  // Pass 2: still past the longest reference length → allow word-boundary cuts on the lines that
  // were only pinned for lacking a pause (hook, context, last payoff and CTA stay protected).
  if (est > input.target.maxS && pinnedForCleanCut.size > 0) {
    pinnedForCleanCut.forEach((i) => protectedIdx.delete(i));
    allowWordEdgeCuts = true;
    lengthPass();
    allowWordEdgeCuts = false;
  }
  fixDangling(S, dec, protectedIdx, drop);

  // ---- 6b. End on the question. After the last question / call to action, short trailing lines
  //          ("Kind of curious." "So, anyway.") blur the ending the viewer should act on.
  const lastAsk = [...S.keys()].reverse().find((i) => dec[i]!.kept && (S[i]!.question || S[i]!.beat === "CTA" || CHOICE.test(S[i]!.text)));
  if (lastAsk != null) {
    for (let i = lastAsk + 1; i < S.length; i++) {
      const s = S[i]!;
      if (!dec[i]!.kept || forceKeep.has(s.id) || hook.has(s.id)) continue;
      const keepsGoing = s.numbers.some((x) => !x.minor) || s.beat === "CTA" || s.question || s.wordCount > 6;
      if (!keepsGoing) {
        protectedIdx.delete(i);
        drop(i, "TRAILING", "Ends on your question — this short line after it blurred the ending");
      }
    }
  }

  // ---- 7. Order: cold open when the hook isn't already the first kept line.
  const keptIdx = S.map((_, i) => i).filter((i) => dec[i]!.kept);
  const hookIdx = S.map((s, i) => (hook.has(s.id) ? i : -1)).filter((i) => i >= 0);
  const firstKept = keptIdx[0];
  const coldOpen = hookIdx.length > 0 && firstKept !== undefined && hookIdx[0] !== firstKept;
  let hookReplayed = false;
  const spans = keptSpans(S, dec, wordCuts);
  let order: StoryPlan["order"];
  if (coldOpen) {
    const hookSpans = spans.filter((sp) => sp.sentenceIds.some((id) => hook.has(id)));
    const lastHook = hookIdx[hookIdx.length - 1]!;
    const nextKept = keptIdx.find((i) => i > lastHook);
    // The line after the hook points back at it ("That's how…") → the hook also stays in place.
    hookReplayed = nextKept !== undefined && S[nextKept]!.dependent;
    const story = hookReplayed ? spans : spans.filter((sp) => !sp.sentenceIds.some((id) => hook.has(id)));
    if (!hookReplayed) hookIdx.forEach((i) => Object.assign(dec[i]!, { kind: "HOOK_MOVED", why: "Moved to the start as the hook" }));
    order = [...hookSpans.map((sp) => ({ ...sp, role: "HOOK" as const })), ...story.map((sp) => ({ ...sp, role: "STORY" as const }))];
  } else {
    order = spans.map((sp) => ({ ...sp, role: (sp.sentenceIds.some((id) => hook.has(id)) ? "HOOK" : "STORY") as "HOOK" | "STORY" }));
  }
  return { decisions: dec, wordCuts, order, coldOpen, hookReplayed, estimatedS: input.estimateS(order), marked };
}

function short(t: string): string {
  return t.length > 48 ? `${t.slice(0, 46).trimEnd()}…` : t;
}

/** Budget units: a list's steps (consecutive LIST_ITEMs) form one unit; others are single. */
function budgetUnits(S: FESentence[], dec: SentenceDecision[]): number[][] {
  // A list runs from its first step to its last (steps ≤ 3 lines apart), with the lines that
  // explain each step in between — kept or dropped as one unit, so numbering never breaks.
  const inList = new Map<number, number>();
  let start = -1;
  let last = -1;
  const close = () => {
    if (start >= 0 && last > start) for (let k = start; k <= last; k++) inList.set(k, start);
    // A dependent line right after the last step belongs to it.
    if (start >= 0 && last > start && S[last + 1]?.dependent) inList.set(last + 1, start);
    start = -1;
    last = -1;
  };
  S.forEach((s, i) => {
    if (s.beat !== "LIST_ITEM" || !dec[i]!.kept) return;
    if (start >= 0 && i - last > 3) close();
    if (start < 0) start = i;
    last = i;
  });
  close();
  const units: number[][] = [];
  const byStart = new Map<number, number[]>();
  S.forEach((_, i) => {
    if (!dec[i]!.kept) return;
    const g = inList.get(i);
    if (g == null) {
      units.push([i]);
      return;
    }
    let u = byStart.get(g);
    if (!u) {
      u = [];
      byStart.set(g, u);
      units.push(u);
    }
    u.push(i);
  });
  return units;
}

/**
 * A kept line that points back ("That's how they make money", "Which means…") needs the line it
 * points to. If that line is gone: keep both when the pointer is protected, else drop the pointer.
 */
function fixDangling(S: FESentence[], dec: SentenceDecision[], protectedIdx: Set<number>, drop: (i: number, k: RemovalKind, why: string) => boolean) {
  const skip = new Set(["FLUFF", "GREETING", "SIGN_OFF"]);
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    S.forEach((s, i) => {
      if (!dec[i]!.kept || !s.dependent) return;
      let p = i - 1;
      while (p >= 0 && skip.has(S[p]!.beat)) p--;
      if (p < 0 || dec[p]!.kept) return;
      if (dec[p]!.kind === "REPEAT" || dec[p]!.kind === "RETAKE") {
        // Its twin is still there — but only if the twin plays BEFORE this line; a twin that
        // comes later leaves "that" pointing at nothing when the viewer hears it.
        const twin = dec[p]!.keptInstead;
        const twinIdx = twin == null ? -1 : S.findIndex((x) => x.id === twin);
        if (twinIdx >= 0 && twinIdx < i && dec[twinIdx]!.kept) return;
      }
      if (protectedIdx.has(i)) {
        Object.assign(dec[p]!, { kept: true, kind: null, why: "Kept — the next line refers to it" });
        changed = true;
      } else if (drop(i, "DANGLING", `Refers back to a removed line (“${short(S[p]!.text)}”)`)) changed = true;
    });
    if (!changed) break;
  }
}

/** Kept word spans in source order, minus word-level cuts. */
function keptSpans(S: FESentence[], dec: SentenceDecision[], cuts: WordCut[]): Array<{ w0: number; w1: number; sentenceIds: number[] }> {
  const removed = new Set<number>();
  for (const c of cuts) for (let k = c.w0; k <= c.w1; k++) removed.add(k);
  const out: Array<{ w0: number; w1: number; sentenceIds: number[] }> = [];
  S.forEach((s, i) => {
    if (!dec[i]!.kept) return;
    let cur: { w0: number; w1: number; sentenceIds: number[] } | null = null;
    for (let k = s.w0; k <= s.w1; k++) {
      if (removed.has(k)) {
        if (cur) out.push(cur);
        cur = null;
        continue;
      }
      // Spans never cross sentences (the hook must be separable); contiguous ranges are merged
      // again at assembly.
      if (!cur) cur = { w0: k, w1: k, sentenceIds: [s.id] };
      cur.w1 = k;
    }
    if (cur) out.push(cur);
  });
  return out;
}

/** Restarts, filler words, throat-clearing lead-ins — only where both cut points are clean. */
export function wordLevelCuts(words: TranscriptWord[], S: FESentence[], dec: SentenceDecision[], safeAfter: (k: number) => boolean): WordCut[] {
  const cuts: WordCut[] = [];
  const b = words.map((w) => bare(w.word));
  const taken = new Set<number>();
  const add = (w0: number, w1: number, kind: WordCut["kind"]) => {
    if (w1 < w0) return false;
    for (let k = w0; k <= w1; k++) if (taken.has(k)) return false;
    if (!safeAfter(w0 - 1) || !safeAfter(w1)) return false;
    for (let k = w0; k <= w1; k++) taken.add(k);
    cuts.push({ w0, w1, kind, text: words.slice(w0, w1 + 1).map((w) => w.word).join(" ") });
    return true;
  };
  S.forEach((s, i) => {
    if (!dec[i]!.kept) return;
    // Lead-in: strip leading discourse words up to a pause ("So basically, I think, | a lot…").
    let k = s.w0;
    let lastSafe = -1;
    while (k <= s.w1 - 3) {
      let matched = 0;
      for (let len = 3; len >= 1; len--) {
        if (k + len - 1 > s.w1) continue;
        const joined = b.slice(k, k + len).join(" ");
        if (LEAD_IN.test(joined) || (len === 1 && FILLER_WORDS.has(joined))) {
          matched = len;
          break;
        }
      }
      if (!matched) break;
      k += matched;
      if (/[,.;:—-]$/.test(words[k - 1]!.word) && safeAfter(k - 1)) lastSafe = k - 1;
    }
    if (lastSafe >= s.w0 && s.w1 - lastSafe >= 3) add(s.w0, lastSafe, "LEAD_IN");
    // Restart: the same 2–4 words said twice close together ("a lot of people, uh, a lot of people").
    // The repeat may start the next kept sentence ("…the math. | The math on this…"), so the
    // search runs to the end of a directly following kept sentence.
    const next = S[i + 1];
    const limit = next && dec[i + 1]!.kept && next.w0 === s.w1 + 1 ? next.w1 : s.w1;
    for (let a = s.w0; a <= s.w1; a++) {
      for (let len = 4; len >= 1; len--) {
        for (let gap = 0; gap <= 2; gap++) {
          const c = a + len + gap;
          if (c + len - 1 > limit) continue;
          // One repeated word counts with a filler between ("it's, um, it's") or as a stutter
          // back to back ("So So a a higher higher") — never a deliberate double ("very very",
          // "boom, boom, boom": punctuated, or the same word a third time).
          if (len === 1 && FILLER_WORDS.has(b[a]!)) continue;
          if (len === 1 && gap === 0) {
            const w = b[a]!;
            const deliberate = DELIBERATE_DOUBLE.has(w) || /[,.;:!?]$/.test(words[a]!.word) || b[a + 2] === w || words[a + 1]!.start - words[a]!.end > 0.4;
            if (deliberate) continue;
          }
          let same = true;
          for (let t = 0; t < len; t++) if (b[a + t] !== b[c + t] || !b[a + t]) same = false;
          const between = b.slice(a + len, c);
          if (len === 1 && !between.every((x) => FILLER_WORDS.has(x))) continue;
          if (same && between.every((x) => FILLER_WORDS.has(x) || LEAD_IN.test(x)) && add(a, c - 1, "RESTART")) {
            a = c + len - 1;
            len = 0;
            break;
          }
        }
      }
    }
    // Filler words anywhere in the sentence.
    for (let w = s.w0; w <= s.w1; w++) {
      if (FILLER_WORDS.has(b[w]!)) add(w, w, "FILLER");
      else if (b[w] === "you" && b[w + 1] === "know" && /,$/.test(words[w + 1]!.word) && w > s.w0) add(w, w + 1, "FILLER");
    }
  });
  return cuts.sort((x, y) => x.w0 - y.w0);
}
