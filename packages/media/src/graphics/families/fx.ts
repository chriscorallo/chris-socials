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
 *              spiral) · CHAPTER (title = "Storytime", subtitle = "Part 1").
 * COUNTDOWN    items[0].value = start (default 3) · title = the final word ("GO"). NUMBERS ·
 *              RING · FLIP (flip digits) · BAR (draining bar "Ends in").
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
    labels: { title: "Main words", subtitle: "Second line", body: "POV text" },
  }, { preferY: 0.36 }),
  COUNTDOWN: spec("COUNTDOWN", "Countdown", "3-2-1, ring, flip digits or a draining bar", "HOOKS", [["NUMBERS", "3-2-1"], ["RING", "Ring"], ["FLIP", "Flip digits"], ["BAR", "Bar"]], {
    title: true,
    ownFormat: true,
    items: { count: [0, 1], value: true },
    labels: { title: "Final word", value: "Count from", entries: "Start" },
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

export const fxSize: FamilySizer = (p, v, head) => {
  const nI = p.items.length;
  switch (p.component) {
    case "VERDICT":
      if (v === "TAPE") return { width: 1080, height: 420 };
      return { width: 720, height: p.subtitle ? 700 : 620 };
    case "HOOK_TEXT":
      if (v === "MEME") return { width: 1040, height: 1700 };
      if (v === "POV") return { width: 960, height: 160 + Math.max(1, lines(p.body, 22, 4)) * 84 };
      if (v === "WAIT") return { width: 900, height: 380 };
      if (v === "CHAPTER") return { width: 960, height: 460 };
      return { width: 900, height: 760 };
    case "COUNTDOWN":
      if (v === "BAR") return { width: 900, height: 300 };
      if (v === "FLIP") return { width: 820, height: 520 };
      return { width: 720, height: 720 };
    case "QUIZ":
      if (v === "RATING") return { width: 900, height: head + 300 };
      if (v === "SLIDER") return { width: 920, height: head + 360 };
      if (v === "THIS_THAT") return { width: 1000, height: head + 560 };
      return { width: 920, height: head + Math.max(2, nI) * 124 + 60 };
    case "SCREEN_FX":
      return { width: 1080, height: 1920 };
    default:
      return null;
  }
};
