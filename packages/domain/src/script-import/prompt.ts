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
 * Faithful summary of /brand/BRAND_CONSTITUTION.md and /brand/CHRIS_BRAIN.md (v2, 2026-10-19).
 * Those files are human-owned and never edited from here; script-import-prompt.test.ts fails if
 * a phrase quoted below disappears from them, so this summary can't drift silently.
 */
export const BRAND_GUIDANCE = `WHO I AM
- Entertainment that happens to teach people about money. I investigate ridiculous questions about money and life, do the actual math, and show you what the answers really mean.
- Finance is the tool used to answer an interesting question, not necessarily the topic announced at the beginning. People arrive for curiosity and entertainment and stay for me.
- Audience: ambitious people in their twenties and thirties who want to improve their lives, understand money, make better decisions and be entertained (not only people already into finance).
- My series: Pick Your Poison, I Did The Math, The Financial Butterfly Effect, How Broke Is This Character?, Money Makes No Sense, The Cost of Being Alive.

HOW I SOUND
- Like an interesting person explaining something surprising to a friend. Direct, conversational, curious, skeptical. Intelligent without sounding academic. Confident without pretending certainty. Occasionally sarcastic, naturally funny, occasionally profane when it fits naturally. Honest about assumptions and uncertainty.
- About a fifth-to-seventh-grade reading level. Plain words: "what else could that money have done?", not "opportunity cost".
- Never: corporate language, motivational clichés, generic financial-influencer advice ("unlock your financial future", "level up", "game changer"), forced gen z slang, fake excitement, patronizing explanations, filler suspense ("but here's the crazy part"), predictable "like, comment and follow" endings, generic intros ("hey guys, welcome back"), obviously ai-written copy.
- Humor comes from the scenario. Never mock people for poverty, debt, disability or circumstances outside their control.`;

/**
 * Condensed /prompts/shared/CONTENT_INTELLIGENCE.md (Chris's master strategy) for the free
 * ChatGPT path — the same craft rules the in-app Script Agent gets. script-import-prompt.test.ts
 * fails if a quoted phrase disappears from the playbook, so the two can't drift.
 */
/** The one-line JSON shape each block's BRIEF carries (parsed into a Creative Brief). */
export const BRIEF_JSON_SHAPE = `one JSON object on one line: {"series":"PICK_YOUR_POISON|I_DID_THE_MATH|BUTTERFLY_EFFECT|HOW_BROKE_IS_THIS_CHARACTER|MONEY_MAKES_NO_SENSE|COST_OF_BEING_ALIVE|OTHER","targetAudience":"","primaryObjective":"COMMENT|SHARE|FOLLOW|PUNCHLINE","coreReaction":"","whyInteresting":"","hooks":[{"text":"","mechanism":"","onScreenText":"","openingVisual":""},{…},{…}],"chosenHookIndex":0,"hookRationale":"","story":{"hook":"","setup":"","firstDiscovery":"","midpointReversal":"or null","payoff":"","ending":""},"storyboard":{"openingFrame":"","onScreenText":[],"scenes":[],"keyCalculations":[],"midpointVisual":"or null","payoffVisual":"","closingFrame":""},"engagement":{"whyShare":"","whyComment":"","whyFollow":""},"scorecard":{"hookStrength":0,"immediateClarity":0,"curiosity":0,"narrativeProgression":0,"retentionPotential":0,"emotionalRelevance":0,"entertainment":0,"visualStorytelling":0,"factualAccuracy":0,"payoffQuality":0,"brandFit":0,"followerConversion":0},"editorial":{"strongest":"","weakest":"","mostImportantRevision":"","whatToTest":""},"research":{"verified":[],"assumptions":[],"unverified":[],"complianceFlags":[]}}`;

export const PLAYBOOK_GUIDANCE = `HOW TO MAKE EACH VIDEO GOOD (my playbook)
- Pick the series it belongs to: PICK_YOUR_POISON (a dilemma, the viewer decides first, the middle challenges the choice), I_DID_THE_MATH (an absurd calculation with an unexpected payoff), BUTTERFLY_EFFECT (one decision over years), HOW_BROKE_IS_THIS_CHARACTER (a fictional character's finances), MONEY_MAKES_NO_SENSE (a mystery, then the hidden incentive), COST_OF_BEING_ALIVE (the hidden economics of normal life), or OTHER.
- Write three hooks that differ in psychological mechanism, not wording: IMPOSSIBLE_CHOICE, ABSURD_INVESTIGATION, PERSONAL_CONTRADICTION, IMPOSSIBLE_QUESTION, SHOWDOWN, SOCIAL_ACCUSATION, FUTURE_SELF_WARNING, MONEY_MYSTERY, RELATABLE_CONFESSION, COUNTDOWN, UNPOPULAR_OPINION, BEFORE_AFTER. Pick the strongest and say why. Be decisive. The script opens with the chosen hook.
- Assume sound off: the opening frame alone should say something interesting.
- Story: hook, setup, first discovery, midpoint (only a legitimate second reveal; if the facts don't support one, don't invent it), payoff, ending. The viewer should feel rewarded, not tricked.
- One ending objective: COMMENT (a genuine decision), SHARE (a legitimate reason to send it), FOLLOW (a repeatable reason to return) or PUNCHLINE (just memorable). Never "like, comment, share and follow".
- Every sentence earns its place. No filler suspense ("it gets even crazier"). Estimate duration from the actual word count.
- Never fabricate numbers, sources, rules or results. Label hypotheticals. No guaranteed returns. Correlation is not causation.
- Score it honestly as a cold viewer (1–10, not every script is a 9): hookStrength, immediateClarity, curiosity, narrativeProgression, retentionPotential, emotionalRelevance, entertainment, visualStorytelling, factualAccuracy, payoffQuality, brandFit, followerConversion.`;

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

${PLAYBOOK_GUIDANCE}
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
BRIEF: ${BRIEF_JSON_SHAPE}

Copy each header line exactly: VIDEO number, date (YYYY-MM-DD), title and code, separated by " | ". The code is how my app matches each script to its video. Write all ${count}. Don't stop early and don't ask if you should continue.`;
}
