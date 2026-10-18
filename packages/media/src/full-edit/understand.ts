import type { TranscriptWord } from "../caption-chunking";
import { spokenNumbers, type SpokenNumber } from "./numbers";
import { bare, contentStems, tokens } from "./text";

/**
 * "Understand the video" (PURE): sentences/beats from Whisper words, per-sentence features,
 * and the cut-safety of every word boundary (measured silences say where a cut can't clip a
 * word). Deterministic rules; semantic similarity comes in from embeddings (index.ts).
 */

export type Beat = "GREETING" | "META" | "SETUP" | "POINT" | "EXAMPLE" | "NUMBER" | "LIST_ITEM" | "PAYOFF" | "CTA" | "SIGN_OFF" | "TANGENT" | "RECAP" | "FLUFF";

export interface FESentence {
  id: number;
  /** Word index span (inclusive) into the cleaned word list. */
  w0: number;
  w1: number;
  text: string;
  start: number;
  end: number;
  numbers: SpokenNumber[];
  question: boolean;
  beat: Beat;
  /** Plain-English evidence for the beat ("starts with 'by the way'"). */
  beatWhy: string;
  /** Starts with a word that needs the sentence before it ("That's how…", "Which…"). */
  dependent: boolean;
  /** List marker ("first", "step two") — list items are kept or dropped together. */
  listIndex: number | null;
  /** Mean loudness of the sentence vs the take's speech median (dB), when measured. */
  energyDb: number | null;
  wordCount: number;
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

/** Splits words into sentences on Whisper punctuation, and on a long silence (≥ 0.7 s). */
export function segmentSentences(words: TranscriptWord[], silences: Array<{ start: number; end: number }> | null): Array<{ w0: number; w1: number }> {
  const out: Array<{ w0: number; w1: number }> = [];
  let s = 0;
  const longGapAfter = (i: number) => {
    const a = words[i]!;
    const b = words[i + 1];
    if (!b) return false;
    // Whisper often stretches a word across the silence before it — the silence must come
    // after the middle of `a` to count as a pause between a and b.
    if (silences?.length) return silences.some((x) => x.end - x.start >= 0.7 && x.start >= (a.start + a.end) / 2 && x.end <= b.end + 0.05);
    return b.start - a.end >= 0.7;
  };
  for (let i = 0; i < words.length; i++) {
    const last = i === words.length - 1;
    // A run-on of 45+ words is split at the next comma so one sentence never swallows a minute.
    const tooLong = i - s >= 45 && /[,;:]$/.test(words[i]!.word);
    if (last || SENTENCE_END.test(words[i]!.word) || longGapAfter(i) || tooLong) {
      out.push({ w0: s, w1: i });
      s = i + 1;
    }
  }
  return out;
}

const RX = {
  greeting: /^(?:(?:okay|ok|alright|all right|so|um|uh)[,.]?\s+)*(?:hey|hi|hello|what'?s up|yo|welcome back)\b(?:\s+(?:guys|everyone|everybody|y'all|friends|you guys))?/i,
  meta: /\b(?:in this video|there'?s something you (?:need|have|want) to know|today i(?:'m| am)? (?:wanna|want to|gonna|going to) (?:talk|cover|share|show)|this (?:video|one) is (?:about|on)|i(?:'ve| have) been wanting to (?:make|do|talk)|let'?s talk about|quick one|let me back up|where was i|that'?s (?:kind of |sort of )?the (?:whole )?point of this video)\b/i,
  cta: /\b(?:follow (?:for|me)|subscribe|comment\b|save this|share this|link in (?:my )?bio|let me know in the comments|send (?:this|it) to)\b/i,
  signOff: /^(?:(?:and|so|okay|ok|alright)[,.]?\s+)*(?:(?:uh|um|ah|er)[,.]?\s+)?(?:yeah|that'?s (?:it|all)|see (?:you|ya)(?: guys)?|bye|peace|later|catch you)\b[\s\S]{0,20}$/i,
  tangentStart: /^(?:(?:oh|and|so|but)[,.]?\s+)*(?:by the way|side note|on a side note|random(?:ly)?|funny enough|fun fact|not to get off topic|off topic|tangent|one more thing|oh,? and also)\b/i,
  tangentEnd: /^(?:(?:anyway|anyways)\b|where was i|back to\b|ok(?:ay)? so back|right\.?$)/i,
  transitionOnly: /^(?:(?:anyway|anyways|okay|ok|so|um|uh|right)[,.]?\s*)+(?:where was i|back to [a-z' ]{1,30})?[.?!]*$/i,
  later: /\b(?:a whole (?:other|different) video|another video|(?:do|make) that one later|for another day)\b/i,
  recap: /\b(?:to recap|just to recap|so again|like i said|as i said|in summary|to sum (?:it )?up)\b/i,
  payoff: /\b(?:bottom line|the point is|that'?s why|which means|so the lesson|here'?s the thing|the takeaway|the real (?:answer|lesson)|do that,? and|that'?s how you)\b/i,
  example: /\b(?:for example|for instance|let'?s say|say you|imagine|my friend|i (?:actually )?ran the numbers|when i|last (?:week|year|month)|a buddy of mine)\b/i,
  fluffOnly: /^(?:(?:and|so|but|like|honestly|look|i mean|okay|ok)[,.]?\s+)*(?:i know (?:that'?s a lot|it'?s a lot|it sounds like a lot)[\s\S]{0,10}|(?:it'?s )?(?:really )?not that (?:complicated|hard)[\s\S]*|trust me[\s\S]{0,20}|which is,? (?:you know,? )?kind of insane[\s\S]*|that'?s kind of[\s\S]*|it really is[\s\S]*|you know what i mean\??|right\??|anyway[\s\S]{0,15}|so,? yeah\.?|okay\.?|ok\.?|alright\.?|cool\.?|um\.?|uh\.?)$/i,
  hedge: /\b(?:i think|i feel like|i don'?t know|kind of|sort of|basically|i guess|maybe|probably|i don'?t want to sound)\b/i,
  dependentStart: /^(?:that'?s|that is|that was|this is|it'?s|it is|which|and that|so that|they|those|these|he|she|it|do that|do this|(?:\w+ )?(?:days?|weeks?|months?|years?) later|later|after that|then|because|(?:how|why) (?:does|did|is|was|would|could|can) (?:that|this|it)|that'?s called)\b/i,
  list: /^(?:(?:okay|ok|so|and|then)[,.]?\s+)*(first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth|fifth|last(?:ly)?|finally|step (?:one|two|three|four|five|\d)|number (?:one|two|three|four|five|\d)|tip (?:one|two|three|\d))\b/i,
};

const LIST_ORDER: Record<string, number> = { first: 1, firstly: 1, second: 2, secondly: 2, third: 3, thirdly: 3, fourth: 4, fifth: 5, last: 9, lastly: 9, finally: 9, one: 1, two: 2, three: 3, four: 4, five: 5 };

function listIndexOf(text: string): number | null {
  const m = RX.list.exec(text);
  if (!m) return null;
  const k = m[1]!.toLowerCase().split(" ").pop()!;
  return LIST_ORDER[k] ?? (Number(k) || null);
}

export interface ClassifyContext {
  index: number;
  count: number;
  /** Previous sentence text (tangent continuity). */
  prevBeat: Beat | null;
}

/** Pure: the beat of one sentence + why, from cue phrases and position. */
export function classifyBeat(text: string, ctx: ClassifyContext, numbers: SpokenNumber[]): { beat: Beat; why: string } {
  const t = text.trim();
  const words = tokens(t).length;
  const rel = ctx.count > 1 ? ctx.index / (ctx.count - 1) : 0;
  if (RX.signOff.test(t) && rel > 0.6) return { beat: "SIGN_OFF", why: "a sign-off" };
  if (RX.cta.test(t) && rel > 0.5) return { beat: "CTA", why: "asks the viewer to act (follow / comment / save)" };
  if (RX.greeting.test(t) && ctx.index <= 2 && words <= 14) return { beat: "GREETING", why: "a greeting" };
  if (RX.tangentStart.test(t)) return { beat: "TANGENT", why: `starts with “${RX.tangentStart.exec(t)![0].trim()}”` };
  if (RX.later.test(t)) return { beat: "TANGENT", why: "saved for another video" };
  if (ctx.prevBeat === "TANGENT" && !RX.tangentEnd.test(t) && words <= 14 && numbers.length === 0) return { beat: "TANGENT", why: "continues the side story" };
  if (RX.transitionOnly.test(t) || /^(?:anyway|anyways)\b[^a-z]*(?:um,?\s*)?where was i/i.test(t)) return { beat: "FLUFF", why: "a transition back from a tangent" };
  if (RX.recap.test(t)) return { beat: "RECAP", why: "repeats what was already said (recap)" };
  if (RX.meta.test(t) && numbers.every((n) => n.minor)) return { beat: "META", why: "talks about the video instead of the topic" };
  if (RX.fluffOnly.test(t)) return { beat: "FLUFF", why: "filler line — no new information" };
  const li = listIndexOf(t);
  if (li != null) return { beat: "LIST_ITEM", why: "a list step" };
  if (RX.payoff.test(t) && rel > 0.4) return { beat: "PAYOFF", why: "lands the point" };
  if (numbers.some((n) => !n.minor)) return { beat: "NUMBER", why: "has a real number" };
  if (RX.example.test(t)) return { beat: "EXAMPLE", why: "a concrete example" };
  if (rel < 0.2) return { beat: "SETUP", why: "sets up the topic" };
  if (rel > 0.85 && /\b(?:so|that'?s|and)\b/i.test(t)) return { beat: "PAYOFF", why: "the closing point" };
  return { beat: "POINT", why: "a point" };
}

export function isHedgy(text: string): boolean {
  return RX.hedge.test(text);
}

export function isDependentStart(text: string): boolean {
  return RX.dependentStart.test(text.trim().replace(/^(?:and|so|but)[,]?\s+/i, ""));
}

/** Pure: sentences with features. `energyAt` = mean dB over [start,end] relative to the speech median. */
export function buildSentences(
  words: TranscriptWord[],
  silences: Array<{ start: number; end: number }> | null,
  energyAt?: (start: number, end: number) => number | null,
): FESentence[] {
  const spans = segmentSentences(words, silences);
  const out: FESentence[] = [];
  let prevBeat: Beat | null = null;
  spans.forEach((sp, index) => {
    const ws = words.slice(sp.w0, sp.w1 + 1);
    const text = ws.map((w) => w.word).join(" ").replace(/\s+/g, " ").trim();
    const nums = spokenNumbers(ws.map((w) => w.word)).map((n) => ({ ...n, w0: n.w0 + sp.w0, w1: n.w1 + sp.w0 }));
    const { beat, why } = classifyBeat(text, { index, count: spans.length, prevBeat }, nums);
    prevBeat = beat;
    out.push({
      id: index,
      w0: sp.w0,
      w1: sp.w1,
      text,
      start: ws[0]!.start,
      end: ws[ws.length - 1]!.end,
      numbers: nums,
      question: /\?["'”’]*$/.test(text),
      beat,
      beatWhy: why,
      dependent: isDependentStart(text),
      listIndex: beat === "LIST_ITEM" ? listIndexOf(text) : null,
      energyDb: energyAt ? energyAt(ws[0]!.start, ws[ws.length - 1]!.end) : null,
      wordCount: ws.length,
    });
  });
  return out;
}

/** The most frequent content stems — the take's keywords (for titles and topic). */
export function keywords(sentences: FESentence[], limit = 8): Array<{ stem: string; word: string; count: number }> {
  const counts = new Map<string, { word: string; count: number }>();
  for (const s of sentences) {
    if (s.beat === "TANGENT" || s.beat === "GREETING" || s.beat === "SIGN_OFF") continue;
    for (const tok of tokens(s.text)) {
      const st = contentStems(tok)[0];
      if (!st || st.length < 3 || /^\d/.test(st)) continue;
      const e = counts.get(st) ?? { word: bare(tok), count: 0 };
      e.count++;
      counts.set(st, e);
    }
  }
  return [...counts.entries()].map(([stem, v]) => ({ stem, ...v })).sort((a, b) => b.count - a.count || a.stem.localeCompare(b.stem)).slice(0, limit);
}
