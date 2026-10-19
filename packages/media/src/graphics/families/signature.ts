import { lines, spec, type FamilySizer, type Spec } from "./types";

/**
 * SIGNATURE family — Chris's own brand recognition (2026-10-19, Content Intelligence): the
 * recurring series identifiers his master strategy asks for ("branding should be recognizable
 * without delaying the hook"). One typographic signature everywhere: a serif series name, a
 * gold rule, a small episode tag, the gold → violet accent. Field mapping:
 *
 * SERIES_CARD   The series opener/stinger. subtitle = series name override (default from the
 *               variant) · meta = episode tag ("EP 12") · title = this episode's line.
 *               POISON (two choices: items[0..1] text + optional value; title = the prompt)
 *               · MATH (items = calculator tape: text + value; body = what it adds up to)
 *               · BUTTERFLY (items = the decision and what it becomes over time: text + sub)
 *               · BROKE (items = a character's budget lines: text + value; body = the verdict)
 *               · NO_SENSE (title = the mystery question; body = the hidden incentive, revealed
 *               late) · ALIVE (items = receipt lines of a normal life: text + value) · EPISODE
 *               (plain: chip + tag + title).
 * DILEMMA       The sound-off opening frame: two huge contrasting amounts. items[0..1] text (the
 *               choice) + value (the amount) · title = the prompt ("You only get one").
 *               SPLIT (stacked) · SIDE (left / right) · TIMER (a 3-second choose clock) ·
 *               FLIP (a coin decides).
 * SIGNATURE_STING  Brand idents. INTRO (gold rule sweep + brand line: title, subtitle = handle)
 *               · OUTRO (title = the follow line, subtitle = handle, meta = "next:" teaser) ·
 *               BUMPER (title = "Part 2") · LOWER (branded lower third: title = name, subtitle =
 *               the line).
 */
const SERIES_VARIANTS = [
  ["POISON", "Pick Your Poison"],
  ["MATH", "I Did The Math"],
  ["BUTTERFLY", "Butterfly Effect"],
  ["BROKE", "How Broke Is This Character?"],
  ["NO_SENSE", "Money Makes No Sense"],
  ["ALIVE", "The Cost of Being Alive"],
  ["EPISODE", "Episode card"],
] as const;

export const SIGNATURE_SPECS = {
  SERIES_CARD: spec("SERIES_CARD", "Series card", "Branded opener for one of the six series: choices, calculator tape, timeline fork, character budget, mystery reveal, life receipt", "SIGNATURE", SERIES_VARIANTS, {
    title: true,
    subtitle: true,
    body: true,
    meta: "Episode tag",
    tone: true,
    items: { count: [0, 6], value: true, sub: true },
    labels: { title: "This episode's line", subtitle: "Series name (optional override)", body: "Answer / verdict", text: "Entry", value: "Amount", entries: "Entries" },
  }, { preferY: 0.36, toneDefault: "DARK" }),
  DILEMMA: spec("DILEMMA", "Dilemma", "Two huge contrasting amounts — the sound-off opening frame (stacked, side by side, with a choose timer, or a coin flip)", "SIGNATURE", [["SPLIT", "Stacked"], ["SIDE", "Side by side"], ["TIMER", "Choose in 3"], ["FLIP", "Coin flip"]], {
    title: true,
    tone: true,
    items: { count: [2, 2], value: true, sub: true },
    highlight: "ITEMS",
    labels: { title: "Prompt", text: "Choice", value: "Amount", sub: "Small line", entries: "The two choices" },
  }, { preferY: 0.4, toneDefault: "DARK" }),
  SIGNATURE_STING: spec("SIGNATURE_STING", "Signature sting", "Brand idents: intro sweep, outro follow line, part bumper, branded lower third", "SIGNATURE", [["INTRO", "Intro"], ["OUTRO", "Outro"], ["BUMPER", "Bumper"], ["LOWER", "Lower third"]], {
    title: true,
    subtitle: true,
    meta: "Next-episode teaser",
    titleRequired: true,
    labels: { title: "Line", subtitle: "Handle / second line" },
  }, { preferY: 0.5 }),
} satisfies Record<string, Spec>;

export const signatureSize: FamilySizer = (p, v) => {
  const n = p.items.length;
  switch (p.component) {
    case "SERIES_CARD": {
      const headLines = p.title ? lines(p.title, 26, 3) : 0;
      const head = 150 + headLines * 62;
      if (v === "POISON") return { width: 1000, height: head + 330 };
      if (v === "MATH") return { width: 960, height: head + Math.max(2, n) * 92 + (p.body ? 150 : 60) };
      if (v === "BUTTERFLY") return { width: 1000, height: head + 440 };
      if (v === "BROKE") return { width: 940, height: head + Math.max(2, n) * 80 + (p.body ? 150 : 50) };
      if (v === "NO_SENSE") return { width: 940, height: head + (p.body ? 300 : 220) };
      if (v === "ALIVE") return { width: 780, height: 200 + Math.max(2, n) * 76 + 120 };
      return { width: 980, height: head + 60 };
    }
    case "DILEMMA":
      if (v === "SIDE") return { width: 1040, height: p.title ? 620 : 520 };
      if (v === "TIMER") return { width: 1000, height: 820 };
      if (v === "FLIP") return { width: 1000, height: 820 };
      return { width: 1000, height: p.title ? 920 : 820 };
    case "SIGNATURE_STING":
      if (v === "BUMPER") return { width: 1080, height: 320 };
      if (v === "LOWER") return { width: 940, height: 200 };
      if (v === "OUTRO") return { width: 1000, height: 560 };
      return { width: 1080, height: 520 };
    default:
      return null;
  }
};
