import type { PlanContextMessage } from "./types";

/**
 * "Highlights": the sections of the conversation whose HEADING names one of the things Chris
 * planned — business model, audience, offer, pillars, posting cadence, monetization.
 * Deterministic and deliberately simple (headings only, never a guess from body text), shown
 * in the UI as "found by headings" so it's clearly not an AI summary. Newest first: in a long
 * planning chat the later answer is usually the one he settled on.
 */

export type HighlightCategory = "businessModel" | "audience" | "offer" | "pillars" | "cadence" | "monetization";

export const HIGHLIGHT_LABELS: Record<HighlightCategory, string> = {
  businessModel: "Business model",
  audience: "Audience",
  offer: "Offer",
  pillars: "Content pillars",
  cadence: "Posting cadence",
  monetization: "Monetization",
};

export const HIGHLIGHT_ORDER: HighlightCategory[] = ["businessModel", "audience", "offer", "pillars", "cadence", "monetization"];

const KEYWORDS: Record<HighlightCategory, RegExp> = {
  businessModel: /\b(business model|business plan|revenue model|how (?:you|i|we)(?:'ll| will)? make money|the business|positioning|brand strategy|vision|mission)\b/i,
  audience: /\b(target audience|audience|avatar|ideal (?:viewer|customer|follower|client)s?|who (?:it'?s|this is) for|niche|demographics?|personas?)\b/i,
  offer: /\b(offers?|products?|courses?|coaching|lead magnets?|funnels?|newsletter|membership|digital products?|services?)\b/i,
  pillars: /\b(content pillars?|pillars?|content buckets?|content themes?|themes|content categories|series)\b/i,
  cadence: /\b(posting (?:cadence|schedule|frequency|plan)|cadence|upload schedule|how often|frequency|(?:videos?|posts?) (?:a|per) (?:day|week)|weekly schedule|content calendar|batch(?:ing)? (?:schedule|plan))\b/i,
  monetization: /\b(monetiz\w*|brand deals?|sponsor\w*|affiliates?|creator fund|income streams?|revenue streams?|revenue|ways to make money)\b/i,
};

export interface Highlight {
  category: HighlightCategory;
  heading: string;
  /** Heading + section body (clipped). */
  text: string;
  messageIndex: number;
  role: PlanContextMessage["role"];
  at: string | null;
}

interface Heading {
  line: number;
  level: number;
  title: string;
  /** "Label: text" on one line — the section is that line. */
  inline: string | null;
}

const MAX_SECTION_CHARS = 1500;

function stripMarks(s: string): string {
  return s.replace(/^#{1,6}\s*/, "").replace(/\*\*|__/g, "").replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").replace(/[:：]\s*$/, "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

export function findHeadings(text: string): Heading[] {
  const lines = text.split("\n");
  const out: Heading[] = [];
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.length > 90) return;
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.+)$/.exec(t))) return void out.push({ line: i, level: m[1]!.length, title: stripMarks(m[2]!), inline: null });
    if (/^(\*\*|__)[^*_]+(\*\*|__)\s*[:：]?\s*$/.test(t)) return void out.push({ line: i, level: 4, title: stripMarks(t), inline: null });
    if (/^\d+[.)]\s+\S.{0,60}$/.test(t) && /^\d+[.)]\s+(\*\*)?[A-Z]/.test(t) && !/[.!?]$/.test(t)) return void out.push({ line: i, level: 4, title: stripMarks(t), inline: null });
    if (/^[^\n]{2,50}[:：]\s*$/.test(t) && !/^(?:[-*•]\s)/.test(t)) return void out.push({ line: i, level: 5, title: stripMarks(t), inline: null });
    // "**Target audience:** 25–34 …" / "Target audience: 25–34 …"
    if ((m = /^(?:[-*•]\s*)?(?:\*\*|__)?([A-Za-z][A-Za-z &/'-]{2,40}?)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(\S.*)$/.exec(t))) {
      out.push({ line: i, level: 6, title: m[1]!.trim(), inline: t });
    }
  });
  return out;
}

function sectionText(lines: string[], headings: Heading[], idx: number): string {
  const h = headings[idx]!;
  if (h.inline) return h.inline.replace(/\*\*|__/g, "");
  let end = lines.length;
  for (let j = idx + 1; j < headings.length; j++) {
    const n = headings[j]!;
    if (!n.inline && n.level <= h.level) {
      end = n.line;
      break;
    }
  }
  const body = lines.slice(h.line, end).join("\n").trim();
  return body.length > MAX_SECTION_CHARS ? `${body.slice(0, MAX_SECTION_CHARS - 1).trimEnd()}…` : body;
}

export function categoryOf(heading: string): HighlightCategory | null {
  for (const c of HIGHLIGHT_ORDER) if (KEYWORDS[c].test(heading)) return c;
  return null;
}

/** Every heading-matched section, newest message first; at most `perCategory` per category. */
export function findHighlights(messages: PlanContextMessage[], opts: { perCategory?: number } = {}): Highlight[] {
  const per = opts.perCategory ?? 3;
  const found: Highlight[] = [];
  const counts = new Map<HighlightCategory, number>();
  const seenText = new Set<string>();
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const m = messages[mi]!;
    const lines = m.text.split("\n");
    const headings = findHeadings(m.text);
    headings.forEach((h, hi) => {
      const category = categoryOf(h.title);
      if (!category) return;
      if ((counts.get(category) ?? 0) >= per) return;
      const text = sectionText(lines, headings, hi);
      // A heading with nothing under it isn't a highlight.
      if (text.replace(/[#*_:\s]/g, "").length < h.title.replace(/\s/g, "").length + 12) return;
      const key = `${category}:${text.slice(0, 200)}`;
      if (seenText.has(key)) return;
      seenText.add(key);
      counts.set(category, (counts.get(category) ?? 0) + 1);
      found.push({ category, heading: h.title, text, messageIndex: mi, role: m.role, at: m.at });
    });
  }
  return found.sort((a, b) => HIGHLIGHT_ORDER.indexOf(a.category) - HIGHLIGHT_ORDER.indexOf(b.category) || b.messageIndex - a.messageIndex);
}
