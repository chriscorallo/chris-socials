import { lines, spec, type FamilySizer, type Spec } from "./types";

/**
 * HOOKS, REACTIONS & FX family — retention beats and editing effects. Field mapping:
 *
 * VERDICT      title = the word (MYTH / FACT / TRUE / FALSE / WRONG / SOLD OUT…) · subtitle =
 *              small line. Colour follows the word (TRUE/FACT/YES/RIGHT → positive, FALSE/MYTH/
 *              WRONG/NO/SCAM → negative, else primary) unless items[0].color is set.
 *              STAMP rubber stamp slam · CHECK big tick · CROSS big X · TAPE banner tape.
 * HOOK_TEXT    POW (comic burst + title) · MEME (title = top text, subtitle = bottom text) ·
 *              POV (body = the situation after "POV:"; title overrides the label) · WAIT
 *              ("wait for it" — title, animated dots + bar) · PLOT_TWIST (title slams with a
 *              spiral) · CHAPTER (title = "Storytime", subtitle = "Part 1"). Tone: POV / WAIT /
 *              CHAPTER cards.
 * COUNTDOWN    items[0].value = start in seconds (default 3) · title = the final word ("GO") ·
 *              subtitle = label (FLIP above the digits, BAR "Ends in"). NUMBERS · RING · FLIP
 *              (m:ss flip digits to 0:00) · BAR (draining bar, clock counts down). Tone: RING /
 *              FLIP / BAR.
 * QUIZ         title = question · items = options (text, value = %, state DONE = correct) ·
 *              range = slider scale. QUESTION (answer reveal) · POLL (results bars) · RATING
 *              (stars: items[0].value of 5) · SLIDER ("rate this 1–10": items[0].value) ·
 *              THIS_THAT (two options, vote split).
 * SCREEN_FX    full-frame overlays: GLITCH · FILM_BURN · LIGHT_LEAK · SPEED_LINES · VHS (meta =
 *              timestamp) · SPOTLIGHT · ZOOM_PUNCH · SPLIT (before/after wipe: items[0..1].text
 *              labels). title = optional word.
 */
export const FX_SPECS = {
  VERDICT: spec("VERDICT", "Verdict stamp", "MYTH / FACT / TRUE / FALSE stamps, big tick, big X", "REACTIONS", [["STAMP", "Stamp"], ["CHECK", "Big tick"], ["CROSS", "Big X"], ["TAPE", "Tape"]], {
    title: true,
    subtitle: true,
    items: { count: [0, 1] },
    labels: { title: "Word", subtitle: "Small line (optional)", entries: "Colour override" },
  }, { preferY: 0.36 }),
  HOOK_TEXT: spec("HOOK_TEXT", "Hook text", "POW, meme captions, POV, wait for it, plot twist, chapter", "HOOKS", [["POW", "Comic POW"], ["MEME", "Meme caption"], ["POV", "POV"], ["WAIT", "Wait for it"], ["PLOT_TWIST", "Plot twist"], ["CHAPTER", "Chapter"]], {
    title: true,
    subtitle: true,
    body: true,
    tone: true,
    labels: { title: "Main words", subtitle: "Second line", body: "POV text" },
  }, { preferY: 0.36 }),
  COUNTDOWN: spec("COUNTDOWN", "Countdown", "3-2-1, ring, flip digits or a draining bar", "HOOKS", [["NUMBERS", "3-2-1"], ["RING", "Ring"], ["FLIP", "Flip digits"], ["BAR", "Bar"]], {
    title: true,
    subtitle: true,
    tone: true,
    ownFormat: true,
    items: { count: [0, 1], value: true },
    labels: { title: "Final word", subtitle: "Label (flip / bar)", value: "Count from (seconds)", entries: "Start" },
  }, { preferY: 0.4 }),
  QUIZ: spec("QUIZ", "Quiz & poll", "Question with answer reveal, poll results, stars, rate-this slider", "HOOKS", [["QUESTION", "Question"], ["POLL", "Poll results"], ["RATING", "Stars"], ["SLIDER", "Rate 1–10"], ["THIS_THAT", "This or that"]], {
    title: true,
    subtitle: true,
    tone: true,
    ownFormat: true,
    quick: "QUERY",
    items: { count: [0, 4], value: true, state: true },
    range: true,
    highlight: "ITEMS",
    labels: { title: "Question", subtitle: "Small line", text: "Option", value: "% / score", entries: "Options (✓ = correct)" },
  }, { preferY: 0.38 }),
  SCREEN_FX: spec("SCREEN_FX", "Screen effect", "Glitch, film burn, light leak, speed lines, VHS, spotlight, punch, split", "REACTIONS", [["GLITCH", "Glitch"], ["FILM_BURN", "Film burn"], ["LIGHT_LEAK", "Light leak"], ["SPEED_LINES", "Speed lines"], ["VHS", "VHS"], ["SPOTLIGHT", "Spotlight"], ["ZOOM_PUNCH", "Punch frame"], ["SPLIT", "Before / after"]], {
    title: true,
    meta: "Timestamp",
    items: { count: [0, 2] },
    labels: { title: "Word (optional)", text: "Label", entries: "Labels" },
  }, { preferY: 0.5, kind: "FULL_FRAME" }),
} satisfies Record<string, Spec>;

/** QUIZ header: the question (≤ 3 lines at ~28 chars) + small line. */
function quizHead(p: { title: string | null; subtitle: string | null }): number {
  const n = p.title ? lines(p.title, 28, 3) : 0;
  return n * 61 + (p.subtitle ? 48 : 0) + (n || p.subtitle ? 32 : 0);
}

export const fxSize: FamilySizer = (p, v) => {
  const nI = p.items.length;
  switch (p.component) {
    case "VERDICT":
      if (v === "TAPE") return { width: 1080, height: 480 };
      if (v === "STAMP") return { width: 720, height: p.subtitle ? 520 : 440 };
      return { width: 720, height: 430 + (p.title ? 146 : 0) + (p.subtitle ? 58 : 0) };
    case "HOOK_TEXT":
      if (v === "MEME") return { width: 1040, height: 1700 };
      if (v === "POV") return { width: 960, height: 104 + Math.max(1, lines(`POV: ${p.body ?? p.subtitle ?? ""}`, 23, 6)) * 78 };
      if (v === "WAIT") return { width: 900, height: p.subtitle ? 304 : 250 };
      if (v === "CHAPTER") return { width: 960, height: 420 };
      if (v === "PLOT_TWIST") return { width: 900, height: p.subtitle ? 720 : 640 };
      return { width: 900, height: 760 };
    case "COUNTDOWN":
      if (v === "BAR") return { width: 900, height: 250 };
      if (v === "FLIP") return { width: 820, height: 290 + (p.subtitle ? 70 : 0) + (p.title ? 120 : 0) };
      if (v === "RING") return { width: 720, height: 720 };
      return { width: 680, height: 680 };
    case "QUIZ": {
      const head = quizHead(p);
      if (v === "RATING") return { width: 900, height: 96 + head + 130 };
      if (v === "SLIDER") return { width: 920, height: 96 + head + 250 };
      if (v === "THIS_THAT") return { width: 1000, height: 96 + head + 330 + (p.items.some((it) => it.value != null) ? 100 : 0) };
      const n = Math.max(2, nI);
      return { width: 920, height: 96 + head + n * 104 + (n - 1) * 18 };
    }
    case "SCREEN_FX":
      return { width: 1080, height: 1920 };
    default:
      return null;
  }
};
