import type { FESentence } from "./understand";
import { shortNumberLabel, type SpokenNumber } from "./numbers";
import { bare, capitalizeFirst, STOP_WORDS, tokens } from "./text";

/**
 * Hook bot (PURE) — the most important 1–3 s of the video. Scores every remaining sentence (and
 * a short sentence + its follow-up) as an opening line, from Chris's OWN words only: concrete
 * numbers, contrast/tension words, a direct "you", a question, an imperative, short punchy
 * length, his delivery energy, how central it is to the topic — and whether it can be cut out
 * cleanly (silence on both sides). Then writes on-screen hook titles from templates filled
 * only with his words/numbers (never a claim he didn't make; the brand's avoid list is enforced).
 */

export interface HookFeature {
  /** Short machine name ("money", "contrast", "you"…). */
  key: string;
  /** Points added (can be negative). */
  points: number;
  /** Evidence, plain English ("says “$10,000”"). */
  evidence: string;
}

export interface HookCandidate {
  /** Sentence ids, in order (1 or 2). */
  sentenceIds: number[];
  text: string;
  start: number;
  end: number;
  score: number;
  features: HookFeature[];
  /** One line for the editor ("A real number ($10,000) + contrast ('less money')"). */
  reason: string;
}

const CONTRAST = /\b(but|actually|nobody|no one|stop|most people|never|wrong|mistake|myth|truth|the problem|here'?s why|the reason|instead|less|more than|isn'?t|doesn'?t|don'?t|won'?t|can'?t|before)\b/gi;
const TENSION = /\b(broke|lose|losing|lost|debt|cost(?:s)?|trap|regret|rich|richer|poor|millionaire|everyone|free money|interest|gone|waste|wasting|leave|leaving|turning down|overwhelming|insane|years?)\b/gi;
const IMPERATIVE = /^(?:stop|don'?t|never|quit|check|keep|start|pay|put|save)\b/i;
const VAGUE_OPENERS = /^(?:so|and|but|because|which|okay|ok|alright|anyway|like|um|uh|yeah)\b/i;

export interface HookContext {
  /** Topic centrality per sentence id (0..1). */
  relevance: Map<number, number>;
  /** Cut-safety at the sentence's start/end (silence around it). */
  cleanEdges: (s: FESentence) => boolean;
  /** Sentence ids still in the story (not removed). */
  eligible: Set<number>;
  /** End of the last word (s) — lines near the end are the payoff. */
  takeEndS: number;
}

function featureList(text: string, sentences: FESentence[], ctx: HookContext): HookFeature[] {
  const f: HookFeature[] = [];
  const nums = sentences.flatMap((s) => s.numbers).filter((n) => !n.minor);
  const money = nums.filter((n) => n.kind === "MONEY");
  const pct = nums.filter((n) => n.kind === "PERCENT");
  if (money.length) f.push({ key: "money", points: 1.7, evidence: `says ${money.map((n) => `“${n.raw.replace(/[.,]$/, "")}”`).join(", ")}` });
  else if (pct.length) f.push({ key: "percent", points: 1.4, evidence: `says ${pct.map((n) => `“${n.raw.replace(/[.,]$/, "")}”`).join(", ")}` });
  else if (nums.length) f.push({ key: "number", points: 0.8, evidence: `says “${nums[0]!.raw.replace(/[.,]$/, "")}”` });
  const contrast = [...new Set((text.match(CONTRAST) ?? []).map((m) => m.toLowerCase()))];
  if (contrast.length) f.push({ key: "contrast", points: Math.min(1.8, 0.9 * contrast.length), evidence: `contrast: ${contrast.slice(0, 3).map((c) => `“${c}”`).join(", ")}` });
  const tension = [...new Set((text.match(TENSION) ?? []).map((m) => m.toLowerCase()))];
  if (tension.length) f.push({ key: "tension", points: Math.min(1.5, 0.5 * tension.length), evidence: `stakes: ${tension.slice(0, 3).map((c) => `“${c}”`).join(", ")}` });
  const claim = /\b(most people|nobody|no one|everyone|never|always)\b/i.exec(text);
  if (claim) f.push({ key: "bold-claim", points: 0.6, evidence: `a bold claim (“${claim[1]!.toLowerCase()}”)` });
  if (/^(?:say|let'?s say|imagine|for example|for instance)\b|^\w+ makes \$/i.test(text.trim())) f.push({ key: "hypothetical", points: -0.9, evidence: "a hypothetical set-up, not a claim" });
  if (/\byou(?:r|'re|'ll)?\b/i.test(text)) f.push({ key: "you", points: 0.6, evidence: "talks to “you”" });
  if (/\?["'”’]*$/.test(text.trim())) f.push({ key: "question", points: 0.8, evidence: "a question" });
  if (IMPERATIVE.test(text.trim())) f.push({ key: "imperative", points: 0.9, evidence: "a direct instruction" });
  const n = tokens(text).length;
  const dur = sentences[sentences.length - 1]!.end - sentences[0]!.start;
  if (n >= 4 && n <= 16) f.push({ key: "short", points: 0.8, evidence: `${n} words — punchy` });
  else if (n > 24) f.push({ key: "long", points: -1.0, evidence: `${n} words — too long to open on` });
  else if (n < 4) f.push({ key: "fragment", points: -0.8, evidence: "too short to stand alone" });
  if (dur > 6) f.push({ key: "slow", points: -1.0, evidence: `${dur.toFixed(1)} s to say` });
  const e = sentences.map((s) => s.energyDb).filter((x): x is number => x != null);
  if (e.length) {
    const d = e.reduce((a, b) => a + b, 0) / e.length;
    const pts = Math.max(-0.5, Math.min(0.8, d / 3));
    if (Math.abs(pts) >= 0.1) f.push({ key: "delivery", points: pts, evidence: `delivered ${d >= 0 ? "+" : ""}${d.toFixed(1)} dB vs your average` });
  }
  const rel = Math.max(...sentences.map((s) => ctx.relevance.get(s.id) ?? 0));
  f.push({ key: "topic", points: rel, evidence: `on topic ${(rel * 100).toFixed(0)}%` });
  if (VAGUE_OPENERS.test(text.trim())) f.push({ key: "needs-context", points: -2.0, evidence: `starts with “${VAGUE_OPENERS.exec(text.trim())![0]}” — mid-thought` });
  else if (sentences[0]!.dependent) f.push({ key: "needs-context", points: -1.6, evidence: "points back to an earlier line" });
  const beat = sentences[0]!.beat;
  if (beat === "GREETING" || beat === "META" || beat === "CTA" || beat === "SIGN_OFF" || beat === "TANGENT" || beat === "FLUFF" || beat === "RECAP") {
    f.push({ key: "not-a-hook", points: -4, evidence: `it's a ${beat.toLowerCase().replace("_", "-")}` });
  }
  if (beat === "LIST_ITEM") f.push({ key: "list-step", points: -1.5, evidence: "a list step out of context" });
  if (ctx.takeEndS > 0 && sentences[0]!.start > 0.78 * ctx.takeEndS) f.push({ key: "ending", points: -1.0, evidence: "it's your ending — opening on it spoils the payoff" });
  if (sentences.length > 1 && sentences[1]!.dependent === false && sentences[1]!.beat !== "NUMBER") f.push({ key: "two-thoughts", points: -0.4, evidence: "two separate thoughts" });
  if (!sentences.every((s) => ctx.cleanEdges(s))) f.push({ key: "unclean-edges", points: -6, evidence: "no clean pause to cut on" });
  return f;
}

function reasonOf(features: HookFeature[]): string {
  const good = features.filter((x) => x.points > 0 && x.key !== "topic").sort((a, b) => b.points - a.points);
  const bad = features.filter((x) => x.points < 0).sort((a, b) => a.points - b.points);
  const parts = good.slice(0, 3).map((g) => g.evidence);
  if (bad.length) parts.push(`but ${bad[0]!.evidence}`);
  return capitalizeFirst(parts.join(" · ") || "Plain opening line");
}

/** Pure: every hook candidate, best first. */
export function scoreHookCandidates(sentences: FESentence[], ctx: HookContext): HookCandidate[] {
  const out: HookCandidate[] = [];
  const elig = sentences.filter((s) => ctx.eligible.has(s.id));
  elig.forEach((s, k) => {
    const singles: FESentence[][] = [[s]];
    // A short setup + its follow-up ("Twenty years. For five thousand dollars.") as one hook.
    const next = elig[k + 1];
    // Only when the follow-up continues the thought (points back / lands a number), never a teaser.
    const continues = next && (next.dependent || next.beat === "NUMBER") && !VAGUE_OPENERS.test(next.text.trim());
    if (next && continues && next.id === s.id + 1 && s.wordCount <= 10 && next.wordCount <= 16 && next.end - s.start <= 7 && !s.question) singles.push([s, next]);
    for (const group of singles) {
      const text = group.map((g) => g.text).join(" ");
      const features = featureList(text, group, ctx);
      // The opening line already: a small bonus for not moving anything.
      if (group[0]!.id === elig[0]!.id) features.push({ key: "already-first", points: 0.4, evidence: "already your first line" });
      const score = Math.round(features.reduce((a, b) => a + b.points, 0) * 100) / 100;
      out.push({ sentenceIds: group.map((g) => g.id), text, start: group[0]!.start, end: group[group.length - 1]!.end, score, features, reason: reasonOf(features) });
    }
  });
  return out.sort((a, b) => b.score - a.score || a.start - b.start);
}

// ---------------------------------------------------------------------------------------
// Hook titles
// ---------------------------------------------------------------------------------------

/** The brand's avoid list (brand/CHRIS_BRAIN.md "Avoid") + common clickbait. */
export const TITLE_AVOID = /\b(unlock|level up|game ?changer|hack|hacks|secret|shocking|insane|you won'?t believe|must see|life ?changing|crush|10x|guru|millionaire mindset|financial freedom|smash|don'?t miss)\b|[!]{2,}|[\u{1F300}-\u{1FAFF}]/iu;

export interface HookTitle {
  text: string;
  /** Which template made it. */
  template: "QUOTE" | "NUMBER_TOPIC" | "QUESTION" | "IMPERATIVE" | "CONTRAST";
  /** Every word comes from the take (or is a neutral connector). */
  grounded: boolean;
}

const TITLE_STOP_START = /^(?:and|so|but|because|which|that|um|uh|like|okay|ok|well|then|now)\b\s*/i;

function trimWords(ws: string[], max: number): string[] {
  const out = ws.slice(0, max);
  while (out.length && /^(?:and|or|but|the|a|an|to|of|that|which|so|is|was|for|with|in|on|at|your|my|last|next|this|every|one|than|before|after|it|he|she|they|we|i)$/i.test(bare(out[out.length - 1]!))) out.pop();
  return out;
}

function cleanTitle(s: string): string {
  const t = s
    .replace(/[“”"]/g, "")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/[,;:]+$/, "")
    .replace(/\.$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return capitalizeFirst(t);
}

/** The nouns right after a number ("ten thousand dollar RAISE", "$5,000 of DEBT"). */
function nounAfter(words: string[], n: SpokenNumber, sentenceW0: number): string | null {
  const after = words.slice(n.w1 - sentenceW0 + 1, n.w1 - sentenceW0 + 4).map(bare);
  const skip = new Set(["dollar", "dollars", "of", "in", "a", "at", "the", "bucks", "per", "percent"]);
  for (const w of after) {
    if (!w || /^\d/.test(w)) return null;
    if (skip.has(w)) continue;
    // The first content word after the number ("$10,000 RAISE", "$5,000 of DEBT").
    if (/^[a-z][a-z'-]{2,}$/.test(w) && !STOP_WORDS.has(w) && !/^(last|next|this|that|from|into|over|every|each|more|less|than|and|but|you|your|his|her|their|our)$/.test(w)) return w;
    return null;
  }
  return null;
}

/**
 * Pure: up to 3 short on-screen titles for the hook, from Chris's words + numbers + topic word.
 * Templates: his own question; "Stop …" when he said it; "The $10K raise" / "$5K → 20 years"
 * (numbers he said, next to the noun he said); his punchiest clause (≤ 7 words).
 */
export function hookTitles(hookSentences: FESentence[], allSentences: FESentence[], topicWord: string | null): HookTitle[] {
  const out: HookTitle[] = [];
  const push = (text: string, template: HookTitle["template"]) => {
    const t = cleanTitle(text);
    const n = tokens(t).length;
    if (n < 2 || n > 8 || t.length > 48) return;
    if (TITLE_AVOID.test(t)) return;
    if (out.some((o) => o.text.toLowerCase() === t.toLowerCase())) return;
    out.push({ text: t, template, grounded: true });
  };
  const words = hookSentences.flatMap((s) => s.text.split(/\s+/));
  const w0 = hookSentences[0]!.w0;
  const text = hookSentences.map((s) => s.text).join(" ");
  const nums = hookSentences.flatMap((s) => s.numbers).filter((n) => !n.minor);
  // 1. Number + the noun he said with it.
  for (const n of nums.slice(0, 2)) {
    const noun = nounAfter(words, n, w0);
    const label = shortNumberLabel(n);
    if (noun && !/^(years?|months?)$/.test(noun) && n.kind !== "NUMBER") push(`The ${label} ${noun}`, "NUMBER_TOPIC");
  }
  // An amount and how long it takes ("$5K → 20 years"), both said in the hook.
  const amount = nums.find((n) => n.kind === "MONEY" || n.kind === "PERCENT");
  const span = nums.find((n) => n.kind === "NUMBER" && /^(years?|months?)$/.test(nounAfter(words, n, w0) ?? ""));
  if (amount && span) push(`${shortNumberLabel(amount)} → ${span.value} ${nounAfter(words, span, w0)}`, "NUMBER_TOPIC");
  // Two amounts of the same kind he compared ("2% vs 5%").
  const same = nums.filter((n) => n.kind === amount?.kind);
  if (same.length >= 2 && /\b(instead|vs|versus|compared|than)\b/i.test(text)) push(`${shortNumberLabel(same[0]!)} vs ${shortNumberLabel(same[1]!)}`, "NUMBER_TOPIC");
  // 2. His own question in the hook.
  const q = hookSentences.find((s) => s.question && s.wordCount <= 9);
  if (q) push(q.text.replace(TITLE_STOP_START, "").replace(/\?*$/, "?"), "QUESTION");
  // 3. Imperative he said ("Stop using the card…").
  const imp = /\b(stop|don'?t|never)\s+([^,.;!?]{3,40})/i.exec(text);
  if (imp) push(trimWords(`${imp[1]} ${imp[2]}`.split(/\s+/), 6).join(" "), "IMPERATIVE");
  // 4. Contrast clause ("Most people leave free money on the table").
  const clauses = text.split(/[;!?]|[.,:](?=\s|$)|\s—\s/).map((c) => c.trim().replace(TITLE_STOP_START, "")).filter((c) => tokens(c).length >= 3);
  const scored = clauses
    .map((c) => ({
      c,
      s:
        (c.match(CONTRAST)?.length ?? 0) +
        (c.match(TENSION)?.length ?? 0) +
        (/\b(most people|nobody|no one|everyone|never|always)\b/i.test(c) ? 2 : 0) +
        (/\d|\$/.test(c) ? 1 : 0) -
        (/^(they|it|he|she|that|this|which)\b/i.test(c) ? 1.5 : 0) -
        Math.max(0, tokens(c).length - 8) * 0.3,
    }))
    .sort((a, b) => b.s - a.s);
  for (const { c } of scored.slice(0, 2)) push(trimWords(c.split(/\s+/), 8).join(" "), "CONTRAST");
  // 5. Topic word + the hook amount ("Raises: $10K") as a last resort.
  if (out.length < 3 && topicWord && amount) push(`${capitalizeFirst(topicWord)}: ${shortNumberLabel(amount)}`, "NUMBER_TOPIC");
  if (out.length < 3) {
    const q2 = allSentences.find((s) => s.question && s.wordCount <= 9 && s.beat !== "TANGENT");
    if (q2) push(q2.text.replace(TITLE_STOP_START, "").replace(/\?*$/, "?"), "QUESTION");
  }
  if (out.length < 3) push(trimWords(text.replace(TITLE_STOP_START, "").split(/\s+/), 6).join(" "), "QUOTE");
  return out.slice(0, 3);
}
