import { parseDateText, resolveDateSpec } from "../plan-import/dates";
import { cleanTitle } from "../plan-import/rows";

/**
 * Reads scripts ChatGPT wrote for Chris's planned videos — deterministic, no model call.
 *
 * The prompt (./prompt.ts) asks for repeated blocks:
 *
 *   ### VIDEO 3 | 2026-10-21 | Making six figures and still broke | K3F9
 *   HOOK: …
 *   SCRIPT:
 *   …
 *   ON-SCREEN: … (optional)
 *   CTA: … (optional)
 *
 * Real answers drift, so this tolerates: a wrapping ``` code block (or several), markdown
 * headings / bold / italics around headers and labels, "Video 3 — Oct 21 — Title" headers,
 * the date or code missing or on their own "DATE:" / "CODE:" lines, smart quotes, numbering
 * that restarts or skips, missing optional parts, "Hook (0–3s):" style labels, timestamps in
 * front of script lines, "Word count: 182" lines, preambles ("Here are your scripts!") and a
 * trailing "Want me to keep going with the next batch?".
 */

export interface ParsedScriptBlock {
  /** 0-based order in the pasted text. */
  index: number;
  /** "VIDEO 3" → 3 (weak hint only — ChatGPT renumbers freely). */
  number: number | null;
  /** Planned day the header named, resolved to "YYYY-MM-DD"; null when there wasn't one. */
  ymd: string | null;
  title: string;
  /** The 4-character video code the prompt gave each video ("K3F9"), when ChatGPT kept it. */
  code: string | null;
  hook: string | null;
  /** The SCRIPT section as written (markers removed). */
  script: string;
  onScreen: string[];
  cta: string | null;
  /** The BRIEF section's JSON (the Creative Brief), when ChatGPT wrote one and it parsed. */
  brief: unknown | null;
  /** Sentences ChatGPT flagged with [CHECK] (the marker itself removed from the spoken text). */
  checks: string[];
  /** What Chris will say: the script, with the hook / CTA added only if they aren't in it already. */
  spokenScript: string;
  wordCount: number;
  /** The block exactly as pasted (provenance — stored with the saved version). */
  raw: string;
  warnings: string[];
}

export interface ParseScriptsResult {
  blocks: ParsedScriptBlock[];
  /** Text that wasn't part of any block (preamble / sign-off), for "we ignored this" display. */
  ignored: string[];
}

type Label = "HOOK" | "SCRIPT" | "ONSCREEN" | "CTA" | "DATE" | "TITLE" | "CODE" | "BRIEF";

const LABELS: Array<[RegExp, Label]> = [
  [/^(?:the\s+)?hook(?:\s+line)?$/i, "HOOK"],
  [/^(?:full\s+|spoken\s+)?script(?:\s+text)?$|^voice\s*over$|^vo$|^body$/i, "SCRIPT"],
  [/^(?:on[\s-]*screen(?:\s+text)?|text\s+on[\s-]*screen|overlays?|text\s+overlays?|captions?\s+on\s+screen|b[\s-]*roll)$/i, "ONSCREEN"],
  [/^(?:cta|call\s+to\s+action|ending|close|closer|closing(?:\s+line)?|outro)$/i, "CTA"],
  [/^(?:date|post\s+date|posting\s+date|day)$/i, "DATE"],
  [/^(?:title|video\s+title|topic)$/i, "TITLE"],
  [/^(?:code|id|video\s+code|video\s+id)$/i, "CODE"],
  [/^(?:brief|creative\s+brief|plan)$/i, "BRIEF"],
];

/** The BRIEF section's JSON object, read tolerantly (fences, prose around it, smart quotes,
 * trailing commas); null when there's none or it doesn't parse. */
export function parseBriefJson(text: string): unknown | null {
  const t = straightenQuotes(text).replace(/```(?:json)?/gi, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const body = t.slice(start, end + 1);
  for (const candidate of [body, body.replace(/,\s*([}\]])/g, "$1")]) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      /* try the next repair */
    }
  }
  return null;
}

/** Invisible characters and odd spaces ChatGPT / iOS copy-paste sometimes carry. */
function normalizeChars(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
    .replace(/[\u00A0\u2007\u202F]/g, " ");
}

/** Smart quotes → straight (for matching / label detection; the script keeps what was written). */
export function straightenQuotes(s: string): string {
  return s.replace(/[‘’‛′]/g, "'").replace(/[“”‟″]/g, '"');
}

/** Removes markdown decoration from a header/label line: leading #, >, list bullets, bold/italic markers. */
function stripLineDecor(line: string): string {
  return line
    .replace(/^\s*(?:>\s*)+/, "")
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/^\s*[-*•]\s+/, "")
    .replace(/^\s*\*(\S.*\S|\S)\*\s*$/, "$1")
    .trim();
}

const CODE_RE = /^(?:code|id)?\s*[:#]?\s*\[?#?\s*([A-Z0-9]{4})\s*\]?$/i;
const VIDEO_HEAD_RE = /^(?:\d{1,3}[.)]\s*)?(video|script|reel|short|tiktok|post)\s*(?:#|no\.?\s*|number\s*)?(\d{1,3})?(?![\w'])\s*(.*)$/i;

/** A header line → its parts, or null when the line isn't a header. */
function parseHeader(rawLine: string, today: string): { number: number | null; ymd: string | null; title: string; code: string | null } | null {
  const line = straightenQuotes(stripLineDecor(rawLine));
  const m = VIDEO_HEAD_RE.exec(line);
  if (!m) return null;
  // "Video games cost…" / "SCRIPT: …" are not headers: a header has a number ("VIDEO 3"), or is
  // "VIDEO | date | title" with the pipe separator.
  const number = m[2] ? Number(m[2]) : null;
  let rest = (m[3] ?? "").trim();
  if (number == null && !(/^video$/i.test(m[1]!) && /^\|/.test(rest))) return null;
  // "Script 3." / "Video 2 of this series…" in prose: an undecorated header must have nothing
  // after the number, or a separator ("VIDEO 3 | …", "Video 3: …", "Video 3 — …").
  const decorated = /^\s*(?:#{1,6}\s|\*\*|__)/.test(rawLine);
  if (!decorated && rest && !/^[|:–—-]/.test(rest)) return null;
  rest = rest.replace(/^[|:–—\-.)\s]+/, "");
  return { number, ...headerFields(rest, today) };
}

/** Markdown heading / bold-only line that could be a header in a format without "VIDEO n". */
function looseHeader(rawLine: string, today: string): { number: number | null; ymd: string | null; title: string; code: string | null } | null {
  const t = rawLine.trim();
  const isHeading = /^#{1,6}\s+\S/.test(t) || /^\*\*[^*]+\*\*:?$/.test(t) || /^__[^_]+__$/.test(t);
  if (!isHeading) return null;
  const line = straightenQuotes(stripLineDecor(t)).replace(/:$/, "");
  if (!line || labelOf(line + ":")) return null;
  const num = /^(\d{1,3})[.)]\s*(.*)$/.exec(line);
  return { number: num ? Number(num[1]) : null, ...headerFields(num ? num[2]! : line, today) };
}

function headerFields(rest: string, today: string): { ymd: string | null; title: string; code: string | null } {
  let parts = rest.split(/\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) parts = rest.split(/\s+[–—-]\s+|\s*·\s*/).map((p) => p.trim()).filter(Boolean);
  let ymd: string | null = null;
  let code: string | null = null;
  const titleParts: string[] = [];
  for (let p of parts) {
    // "(Oct 21)" / "[K3F9]" wrappers.
    const bracketCode = /[[(]\s*(?:code|id)?\s*[:#]?\s*#?([A-Z0-9]{4})\s*[\])]\s*$/i.exec(p);
    if (bracketCode && /\d/.test(bracketCode[1]!) && /[A-Z]/i.test(bracketCode[1]!)) {
      code ??= bracketCode[1]!.toUpperCase();
      p = p.slice(0, bracketCode.index).trim();
      if (!p) continue;
    }
    const plain = p.replace(/^[([]|[)\]]$/g, "").trim();
    const cm = CODE_RE.exec(plain);
    if (cm && (/^(?:code|id)\b/i.test(plain) || (/\d/.test(cm[1]!) && /[A-Z]/i.test(cm[1]!)))) {
      code ??= cm[1]!.toUpperCase();
      continue;
    }
    if (!ymd) {
      const d = dateOf(plain.replace(/^(?:date|post(?:ing)?\s+date|day)\s*[:-]\s*/i, ""), today);
      if (d) {
        ymd = d;
        continue;
      }
      // Trailing "(Oct 21)" on a title.
      const paren = /\(([^()]+)\)\s*$/.exec(p);
      const pd = paren ? dateOf(paren[1]!, today) : null;
      if (pd) {
        ymd = pd;
        p = p.slice(0, paren!.index).trim();
        if (!p) continue;
      }
    }
    titleParts.push(p.replace(/^title\s*[:-]\s*/i, ""));
  }
  return { ymd, code, title: cleanTitle(titleParts.join(" — ")) };
}

/** Only real calendar dates count in a header ("2026-10-21", "Oct 21", "Wed 10/21", "Today"). */
function dateOf(text: string, today: string): string | null {
  const t = text.trim().replace(/[.,]$/, "");
  if (!t || t.length > 40) return null;
  const parsed = parseDateText(t);
  if (!parsed) return null;
  if (parsed.spec.kind !== "absolute" && parsed.spec.kind !== "relative") return null;
  // A title that merely starts with a weekday / month word isn't a date: require the whole part to be date-like.
  const leftovers = t
    .replace(/\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?/gi, "")
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?/gi, "")
    .replace(/\b(?:today|tomorrow|tonight)\b/gi, "")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\b/gi, "")
    .replace(/\b(?:at|@)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, "")
    .replace(/[\d/\-.,:T\s]/g, "");
  if (leftovers.length > 0) return null;
  return resolveDateSpec(parsed.spec, { today });
}

/** "HOOK: text" / "**Hook (0–3s):** text" / "Script —" → label + rest of the line. */
function labelOf(rawLine: string): { label: Label; rest: string } | null {
  const line = rawLine
    .replace(/^\s*(?:>\s*)+/, "")
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/^\s*[-*•]\s+(?=\S)/, "")
    .trim();
  const m = /^(?:\*\*|__|\*)?\s*([A-Za-z][A-Za-z\s-]{0,28}?)\s*(?:\([^)]{0,30}\))?\s*(?:\*\*|__|\*)?\s*[:：]\s*(?:\*\*|__|\*)?\s*(.*)$/.exec(line);
  const dash = m ? null : /^(?:\*\*|__)?\s*([A-Za-z][A-Za-z\s-]{0,28}?)\s*(?:\*\*|__)?\s*[—–]\s*(.*)$/.exec(line);
  const hit = m ?? dash;
  if (!hit) return null;
  const name = hit[1]!.trim();
  for (const [re, label] of LABELS) {
    if (re.test(name)) return { label, rest: hit[2]!.replace(/^(?:\*\*|__)\s*/, "").trim() };
  }
  return null;
}

/** ChatGPT sign-offs / offers to continue — dropped from the end of a block. */
const CHATTER_RE =
  /^(?:want me to|would you like|do you want|should i|shall i|let me know|i can (?:also )?|if you(?:'d| would)? like|happy to|hope (?:this|these)|here (?:are|is|'s)|next (?:up|batch)|ready for|say (?:the word|"?next"?)|that'?s (?:all|batch)|these (?:scripts|are)|(?:all )?\d+ scripts?\b|continue\b|end of batch)/i;
/** "Word count: ~95 · Est. 30s", "(~190 words, about 55 seconds)", "Runtime: 0:52". */
const META_LINE_RE =
  /^\(?\s*(?:(?:word\s*count|words|length|runtime|duration|reading\s+time|est(?:imated)?\.?(?:\s+(?:time|length|runtime|read(?:ing)?\s+time))?|approx(?:imately)?\.?)\s*(?:[:=~≈]|\s(?=~?\s*\d))\s*~?\s*\d[^\n]{0,60}|~?\s*\d+\s*(?:words|sec(?:onds)?|s)\b[^\n]{0,60})\)?\s*$/i;

function isChatter(paragraph: string): boolean {
  const p = straightenQuotes(stripLineDecor(paragraph))
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s]+$/u, "")
    .replace(/^\*|\*$/g, "")
    .trim();
  if (!p) return true;
  if (/^[-–—_*=]{3,}$/.test(p)) return true;
  if (META_LINE_RE.test(p)) return true;
  return (
    CHATTER_RE.test(p) &&
    p.length < 400 &&
    (p.endsWith("?") || p.endsWith("!") || /\b(?:batch|next|continue|keep going|scripts|the rest|remaining|more|tweak|adjust|longer|shorter|videos)\b/i.test(p))
  );
}

/** Cleans spoken text: markdown, line timestamps, bracketed stage directions (keeps [CHECK]). */
function cleanSpoken(text: string): string {
  return text
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*(?:>\s*)+/, "")
        .replace(/^\s*[-*•]\s+/, "")
        .replace(/^\s*\d{1,2}[.)]\s+(?=[A-Z"'“‘])/, "")
        .replace(/^\s*[[(]\s*\d{1,2}(?::\d{2})?\s*s?\s*[–-]\s*\d{1,2}(?::\d{2})?\s*s?\s*[\])]\s*[:\-–—]?\s*/i, "")
        .replace(/^\s*\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}\s*[:\-–—]?\s*/, "")
        .replace(/\*\*|__/g, "")
        .replace(/(^|[\s(])\*(\S[^*\n]*?\S|\S)\*(?=[\s).,!?;:]|$)/g, "$1$2")
        .replace(/\[(?:pause|beat|cut|b-?roll[^\]]*|on[\s-]*screen[^\]]*|visual[^\]]*|music[^\]]*|sfx[^\]]*)\]/gi, "")
        .replace(/[ \t]+/g, " ")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** “Wrapped in quotes” → wrapped in quotes (only when the quotes wrap the whole thing). */
function unquote(s: string): string {
  const t = s.trim();
  const m = /^["“]([\s\S]*)["”]$/.exec(t);
  return m && !/["“”]/.test(m[1]!) ? m[1]!.trim() : t;
}

const CHECK_SRC =String.raw`\s*[[(]\s*check(?:\s*[:\-–][^\])]*)?\s*[\])]`;
const CHECK_TEST = new RegExp(CHECK_SRC, "i");
const checkAll = () => new RegExp(CHECK_SRC, "gi");

/** Pulls out the sentences ChatGPT flagged with [CHECK] and removes the markers. */
export function extractChecks(text: string): { text: string; checks: string[] } {
  const checks: string[] = [];
  // Sentence-ish units (keep "$1.5" and "401(k)" together).
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z"'“‘$0-9])|\n+/);
  for (const s of sentences) {
    if (CHECK_TEST.test(s)) {
      const note = /[[(]\s*check\s*[:\-–]\s*([^\])]+)[\])]/i.exec(s)?.[1]?.trim();
      const claim = s.replace(checkAll(), "").replace(/\s+/g, " ").trim();
      if (claim) checks.push(note ? `${claim} (${note})` : claim);
    }
  }
  return { text: text.replace(checkAll(), "").replace(/[ \t]+([.,!?;:])/g, "$1").replace(/[ \t]{2,}/g, " "), checks };
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9$%]/.test(w)).length;
}

function wordsKey(s: string): string {
  return straightenQuotes(s).toLowerCase().replace(/[^a-z0-9$%]+/g, " ").trim();
}

/** True when `part` (a hook / CTA) is already in `text` — roughly (ChatGPT rewords slightly). */
function alreadyIn(part: string, text: string, where: "start" | "end"): boolean {
  const p = wordsKey(part);
  if (!p) return true;
  const t = wordsKey(text);
  if (t.includes(p)) return true;
  const pw = p.split(" ");
  const tw = t.split(" ");
  const window = where === "start" ? tw.slice(0, pw.length + 12) : tw.slice(-(pw.length + 12));
  const set = new Set(window);
  const hits = pw.filter((w) => set.has(w)).length;
  return hits / pw.length >= 0.7;
}

/** The text Chris will read on the prompter. */
export function composeSpokenScript(parts: { hook: string | null; script: string; cta: string | null }): string {
  let s = parts.script.trim();
  if (parts.hook && !alreadyIn(parts.hook, s, "start")) s = s ? `${parts.hook.trim()}\n\n${s}` : parts.hook.trim();
  if (parts.cta && !alreadyIn(parts.cta, s, "end")) s = s ? `${s}\n\n${parts.cta.trim()}` : parts.cta.trim();
  return s;
}

interface RawBlock {
  header: { number: number | null; ymd: string | null; title: string; code: string | null };
  headerLine: string;
  lines: string[];
}

export function parseChatGptScripts(input: string, opts: { today: string }): ParseScriptsResult {
  const lines = normalizeChars(input).split("\n");
  const ignored: string[] = [];
  const raws: RawBlock[] = [];
  let current: RawBlock | null = null;
  let pre: string[] = [];

  // Loose headers (no "VIDEO n") only count when a label follows soon after.
  const labelSoon = (i: number) => {
    for (let j = i + 1, seen = 0; j < lines.length && seen < 4; j++) {
      const l = lines[j]!.trim();
      if (!l || /^```/.test(l)) continue;
      seen++;
      const lab = labelOf(l);
      if (lab && (lab.label === "HOOK" || lab.label === "SCRIPT" || lab.label === "DATE" || lab.label === "CODE" || lab.label === "TITLE")) return true;
    }
    return false;
  };

  for (const [i, line] of lines.entries()) {
    if (/^\s*```/.test(line)) continue; // code fences (ChatGPT's "Copy code" box)
    const header = parseHeader(line, opts.today) ?? (labelSoon(i) ? looseHeader(line, opts.today) : null);
    if (header) {
      if (current) raws.push(current);
      else if (pre.join("").trim()) ignored.push(pre.join("\n").trim());
      current = { header, headerLine: line, lines: [] };
      pre = [];
      continue;
    }
    if (current) current.lines.push(line);
    else pre.push(line);
  }
  if (current) raws.push(current);
  else if (pre.join("").trim()) ignored.push(pre.join("\n").trim());

  const blocks: ParsedScriptBlock[] = [];
  for (const raw of raws) {
    const b = buildBlock(raw, blocks.length, opts.today, ignored, raw === raws[raws.length - 1]);
    if (b) blocks.push(b);
  }
  return { blocks, ignored };
}

function buildBlock(raw: RawBlock, index: number, today: string, ignored: string[], isLast: boolean): ParsedScriptBlock | null {
  const sections: Record<Label | "NONE", string[]> = { HOOK: [], SCRIPT: [], ONSCREEN: [], CTA: [], DATE: [], TITLE: [], CODE: [], BRIEF: [], NONE: [] };
  let cur: Label | "NONE" = "NONE";
  let lastSection: Label | "NONE" = "NONE";
  /** Unlabeled text between the header and the first label. */
  const pre: string[] = [];
  for (const line of raw.lines) {
    // Inside the BRIEF's JSON, "hook": … lines are keys, not labels.
    const lab: { label: Label; rest: string } | null = cur === "BRIEF" && /^\s*["{}\[\],]/.test(line) ? null : labelOf(line);
    if (lab) {
      cur = lastSection = lab.label;
      if (lab.rest) sections[cur].push(lab.rest);
      continue;
    }
    // HOOK / CTA / ON-SCREEN / DATE… are one paragraph: a blank line after their text ends them
    // ("Hook: …" followed by the script as plain paragraphs). SCRIPT runs to the next label.
    if (!line.trim() && cur !== "SCRIPT" && cur !== "BRIEF" && cur !== "NONE" && sections[cur].some((l) => l.trim())) cur = "NONE";
    sections[cur].push(line);
    if (lastSection === "NONE" && !/^\s*[-–—_*=]{3,}\s*$/.test(line)) pre.push(line);
  }
  const join = (ls: string[]) => ls.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // Trailing chatter: from the end of whichever section came last, drop sign-off paragraphs.
  const trimTrailing = (key: Label | "NONE") => {
    const paras = join(sections[key]).split(/\n\s*\n/);
    const dropped: string[] = [];
    // Never empty the script itself on a heuristic (a one-paragraph script ending in "?" is fine).
    const keep = key === "SCRIPT" || (key === "NONE" && !sections.SCRIPT.some((l) => l.trim())) ? 1 : 0;
    while (paras.length > keep && isChatter(paras[paras.length - 1]!)) dropped.unshift(paras.pop()!);
    // A single-line section (ON-SCREEN / CTA) may carry the sign-off on its next line.
    if (key !== "SCRIPT" && key !== "NONE" && paras.length) {
      const ls = paras[paras.length - 1]!.split("\n");
      while (ls.length > 1 && isChatter(ls[ls.length - 1]!)) dropped.unshift(ls.pop()!);
      paras[paras.length - 1] = ls.join("\n");
    }
    if (dropped.length && isLast) ignored.push(dropped.join("\n\n").trim());
    sections[key] = paras.join("\n\n").split("\n");
  };
  for (const k of new Set<Label | "NONE">([lastSection, "SCRIPT", "NONE"])) if (sections[k].length) trimTrailing(k);
  // Separator lines between blocks.
  for (const k of Object.keys(sections) as Array<Label | "NONE">) sections[k] = sections[k].filter((l) => !/^\s*[-–—_*=]{3,}\s*$/.test(l));

  const warnings: string[] = [];
  let hook = join(sections.HOOK) || null;
  let scriptRaw = join(sections.SCRIPT);
  const unlabeled = join(sections.NONE);
  if (!scriptRaw && unlabeled) scriptRaw = unlabeled;
  else if (scriptRaw && !hook && join(pre)) hook = join(pre).split("\n")[0]!.trim() || null; // a line between header and SCRIPT
  if (!scriptRaw && !hook) return null;
  if (!scriptRaw) warnings.push("Only a hook — no script under it");

  const header = { ...raw.header };
  if (!header.ymd && sections.DATE.length) header.ymd = dateOf(join(sections.DATE), today);
  if (!header.title && sections.TITLE.length) header.title = cleanTitle(straightenQuotes(join(sections.TITLE)));
  if (!header.code && sections.CODE.length) {
    const cm = CODE_RE.exec(join(sections.CODE).trim());
    if (cm) header.code = cm[1]!.toUpperCase();
  }

  const hookClean = hook ? unquote(cleanSpoken(hook)) : null;
  const ctaRaw = join(sections.CTA);
  const ctaClean = ctaRaw ? unquote(cleanSpoken(ctaRaw)) : null;
  const scriptClean = cleanSpoken(scriptRaw);

  const hk = hookClean ? extractChecks(hookClean) : { text: "", checks: [] };
  const sc = extractChecks(scriptClean);
  const ct = ctaClean ? extractChecks(ctaClean) : { text: "", checks: [] };
  const checks = [...new Set([...hk.checks, ...sc.checks, ...ct.checks])];

  const onScreen = join(sections.ONSCREEN)
    .split(/\n|\s+\/\s+|\s*;\s*/)
    .map((s) => unquote(cleanSpoken(s)))
    .filter((s) => s && !/^(?:none|n\/a|-)$/i.test(s));

  const spokenScript = composeSpokenScript({ hook: hk.text.trim() || null, script: sc.text.trim(), cta: ct.text.trim() || null });
  const briefText = join(sections.BRIEF);
  const brief = briefText ? parseBriefJson(briefText) : null;
  if (briefText && !brief) warnings.push("The BRIEF wasn't valid JSON — the script was kept, the plan wasn't");
  if (!header.title) warnings.push("No title in the header");
  if (!header.ymd) warnings.push("No date in the header");

  return {
    index,
    number: header.number,
    ymd: header.ymd,
    title: header.title,
    code: header.code,
    hook: hk.text.trim() || null,
    script: sc.text.trim(),
    onScreen,
    cta: ct.text.trim() || null,
    brief,
    checks,
    spokenScript,
    wordCount: countWords(spokenScript),
    raw: [raw.headerLine, ...raw.lines].join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    warnings,
  };
}
