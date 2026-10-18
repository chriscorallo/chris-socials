import { formatYmdShort } from "../plan-import/preview";

/**
 * The prompt Chris pastes into ChatGPT (his own subscription — no API, $0) to get scripts for
 * his planned videos. Pure; built in the browser so switching batches is instant.
 *
 * It works both in the SAME chat where he planned the videos (it says "if we planned these
 * together, use that") and in a fresh chat (the videos, their hooks/notes, his voice and the
 * format are all embedded). Output is the strict block format ./parse.ts reads.
 */

export interface PromptVideo {
  id: string;
  code: string;
  title: string;
  ymd: string;
  hook?: string | null;
  notes?: string | null;
}

/** Delivery targets embedded in the prompt — from the measured reference videos when there are any. */
export interface ScriptStyle {
  wpm: number;
  minSeconds: number;
  maxSeconds: number;
  minWords: number;
  maxWords: number;
  hookSeconds: number;
  /** "references" = measured from N reference videos; "default" = no measurements yet. */
  source: "references" | "default";
  sampleSize: number;
}

export const DEFAULT_SCRIPT_WPM = 200;

/** Imported plan items keep "Hook: …" as the description's first paragraph (plannedDescription). */
export function splitPlannedDescription(d: string | null | undefined): { hook: string | null; notes: string | null } {
  if (!d) return { hook: null, notes: null };
  const m = /^Hook: (.*)(?:\n\n([\s\S]*))?$/.exec(d);
  if (m) return { hook: m[1]!.trim() || null, notes: m[2]?.trim() || null };
  return { hook: null, notes: d.trim() || null };
}

type Stat = { value: number; n: number; p25: number; p75: number } | null | undefined;

const round5 = (n: number) => Math.round(n / 5) * 5;
const round10 = (n: number) => Math.round(n / 10) * 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Targets from the reference style profile (getReferenceStyleProfile — talking videos only):
 * words a minute = the references' median (sane range only), length = their middle half
 * (p25–p75), hook = their median hook length. Falls back to ~200 wpm, 45–70 s, 3 s.
 */
export function scriptStyleFrom(profile: { sampleSize: number; wpm?: Stat; durationS?: Stat; hookDurationS?: Stat } | null | undefined): ScriptStyle {
  const n = profile?.sampleSize ?? 0;
  const wpmV = profile?.wpm?.value;
  const wpm = n > 0 && wpmV && wpmV >= 140 && wpmV <= 300 ? Math.round(wpmV) : DEFAULT_SCRIPT_WPM;
  const dur = profile?.durationS;
  let minSeconds = 45;
  let maxSeconds = 70;
  if (n > 0 && dur && dur.p25 > 0 && dur.p75 > 0) {
    minSeconds = clamp(round5(dur.p25), 25, 75);
    maxSeconds = clamp(round5(dur.p75), minSeconds + 10, 95);
  }
  const hookV = profile?.hookDurationS?.value;
  const hookSeconds = n > 0 && hookV && hookV >= 1 && hookV <= 6 ? Math.round(hookV) : 3;
  const usedRefs = n > 0 && (wpm !== DEFAULT_SCRIPT_WPM || minSeconds !== 45 || maxSeconds !== 70 || hookSeconds !== 3);
  return {
    wpm,
    minSeconds,
    maxSeconds,
    minWords: round10((minSeconds * wpm) / 60),
    maxWords: round10((maxSeconds * wpm) / 60),
    hookSeconds,
    source: usedRefs ? "references" : "default",
    sampleSize: n,
  };
}

/** Chris's own measured pace (raw takes with word timings) when there are enough takes, else null. */
export function ownPaceWpm(own: { takes: number; wpm?: Stat } | null | undefined): number | null {
  const v = own?.wpm?.value;
  return own && own.takes >= 3 && v && v >= 120 && v <= 320 ? Math.round(v) : null;
}

/** Seconds it takes to say `words` at `wpm`. */
export function estimateSecondsAt(words: number, wpm: number): number {
  return Math.max(1, Math.round((words / Math.max(60, wpm)) * 60));
}

export const BATCH_SIZES = [10, 15, 20, 30] as const;
export const DEFAULT_BATCH_SIZE = 15;

export function batchVideos<T>(videos: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < videos.length; i += n) out.push(videos.slice(i, i + n));
  return out;
}

/**
 * Faithful summary of /brand/BRAND_CONSTITUTION.md and /brand/CHRIS_BRAIN.md (v1). Those
 * files are human-owned and never edited from here; brand-guidance.test.ts fails if a phrase
 * quoted below disappears from them, so this summary can't drift silently.
 */
export const BRAND_GUIDANCE = `WHO I AM
- My personal brand is Chris Corallo. Finance is my strongest pillar right now (money, debt, credit, investing, retirement, insurance, practical adulthood), but I'm not just "the finance guy": mindset, lifestyle and the things I'm into are part of it too.
- Audience: ambitious people in their 20s and 30s trying to get their shit together without pretending they already understand everything.
- Ethos: stop pretending you understand shit you don't. Ask better questions, look at the actual numbers, and build a better life intentionally.
- People should come for useful money content and increasingly stay for me.

HOW I SOUND
- Direct, conversational, skeptical, curious. Confident without pretending certainty. Funny when appropriate. Plain English. Naturally, occasionally, profane.
- I'm interested in actual numbers and how systems really work.
- Use: direct openings, real scenarios, concrete dollar examples, strong questions, plain-English explanations, "okay, but what does that actually mean?" thinking.
- Specific > generic. Interesting > merely informative. Clear > sophisticated-sounding. Real numbers > vague claims. Evidence > guru folklore.
- Never: "unlock your financial future", "level up your finances", "game changer", fake urgency, generic hacks, emoji spam, generic engagement bait, finance-bro language, fake guru tone, corporate educational tone, obviously AI-written copy.`;

export interface BuildPromptInput {
  videos: readonly PromptVideo[];
  batchNumber: number;
  batchCount: number;
  style: ScriptStyle;
  /** Real transcripts from /brand/VOICE_SAMPLES.md (empty until Chris fills it). */
  voiceSamples?: string;
}

const MAX_VOICE_SAMPLE_CHARS = 2500;
const MAX_HOOK_CHARS = 220;
const MAX_NOTES_CHARS = 320;

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s*\n+\s*/g, " / ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** "Wed Oct 21" + year → the human date the prompt shows next to the ISO one. */
function humanDate(ymd: string): string {
  return `${formatYmdShort(ymd)}, ${ymd.slice(0, 4)}`;
}

/** "HOW I ACTUALLY TALK" block (empty when /brand/VOICE_SAMPLES.md has no samples yet). */
export function voiceSamplesBlock(voiceSamples?: string): string {
  const samples = (voiceSamples ?? "").trim();
  return samples
    ? `\nHOW I ACTUALLY TALK (real transcripts of me. Match the voice, never copy the lines)\n${samples.length > MAX_VOICE_SAMPLE_CHARS ? `${samples.slice(0, MAX_VOICE_SAMPLE_CHARS)}…` : samples}\n`
    : "";
}

/** The format + delivery rules for every script (single source of truth: the copy-paste prompt
 * and the ChatGPT connector both use this text). */
export function scriptFormatRules(style: ScriptStyle): string {
  return `HOW EACH VIDEO WORKS (me talking to camera, vertical: TikTok, Reels, Shorts)
- Hook in the first ~${style.hookSeconds} seconds. The first sentence has to earn the second one. No "hey guys", no intro, no "in this video".
- Fast and dense: I talk about ${style.wpm} words a minute with no filler and no dead pauses. Every line moves it forward.
- Length: ${style.minSeconds}–${style.maxSeconds} seconds, which is about ${style.minWords}–${style.maxWords} spoken words.
- Tight ending: land the point and stop. One short closing line at most, no long outro.
- Write it exactly how I'd say it out loud: short sentences, contractions, no headings or bullet points inside the script, no stage directions, no emoji, no hashtags.`;
}

/** The facts / [CHECK] rule (the FACTUAL gate still checks every claim before posting). */
export const SCRIPT_FACTS_RULES = `FACTS
- Only claims I can stand behind. No made-up numbers, no guaranteed returns, no personal financial advice.
- Put [CHECK] right after every specific number, statistic, rate, limit, date or rule, like: "...and most cards charge over 20% [CHECK]". I fact-check every [CHECK] before I post. If you're not sure something is true, say it in a way that is true, or leave it out.`;

/** Brand + voice + format + facts — everything a script writer needs except the video list. */
export function scriptWritingRules(style: ScriptStyle, voiceSamples?: string): string {
  return `${BRAND_GUIDANCE}
${voiceSamplesBlock(voiceSamples)}
${scriptFormatRules(style)}

${SCRIPT_FACTS_RULES}`;
}

export function buildScriptPrompt(input: BuildPromptInput): string {
  const { videos, style } = input;
  const count = videos.length;
  const list = videos
    .map((v, i) => {
      const lines = [`${i + 1}. ${v.title}`, `   Date: ${v.ymd} (${humanDate(v.ymd)}) · Code: ${v.code}`];
      if (v.hook?.trim()) lines.push(`   Hook idea: ${oneLine(v.hook, MAX_HOOK_CHARS)}`);
      if (v.notes?.trim()) lines.push(`   Notes: ${oneLine(v.notes, MAX_NOTES_CHARS)}`);
      return lines.join("\n");
    })
    .join("\n");
  const first = videos[0];
  const example = first
    ? `### VIDEO 1 | ${first.ymd} | ${first.title} | ${first.code}`
    : "### VIDEO 1 | 2026-10-21 | Video title | K3F9";
  const batchLine = input.batchCount > 1 ? ` (batch ${input.batchNumber} of ${input.batchCount})` : "";

  return `Write the scripts for ${count} of my short-form videos${batchLine}. If we planned these videos together earlier in this chat, use what we talked about. Everything you need is also below.

${scriptWritingRules(style, input.voiceSamples)}

THE VIDEOS
${list}

ANSWER FORMAT (follow it exactly, my app reads it automatically)
Put all ${count} blocks inside ONE code block, in the same order as the list, with nothing before or after them. Each block:

${example}
HOOK: the first line I say
SCRIPT:
every word I say, starting with the hook line, as normal paragraphs
ON-SCREEN: optional short text overlays, separated by " / "
CTA: optional closing line, only if it isn't already the last line of the script

Copy each header line exactly: VIDEO number, date (YYYY-MM-DD), title and code, separated by " | ". The code is how my app matches each script to its video. Write all ${count}. Don't stop early and don't ask if you should continue.`;
}
