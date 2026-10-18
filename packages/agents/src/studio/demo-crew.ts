import type { StudioFilm, StudioShot } from "./film-types";
import type { FilmBrief, FilmScript, FinalPackResponse, FixPackResponse, HookSet, ReviewPackResponse, WritePackResponse } from "./schemas";

/**
 * A recorded-shape "crew answer" set for tests, evals and the dev demo mode (STUDIO_DEMO_CREW=1 —
 * never on Vercel): what a good ChatGPT answer to each pack looks like, for the proof film's story
 * ("The Raise"). The FIRST draft deliberately repeats the proof film's real flaw — "You raised your
 * baseline." over a picture where no floor visibly rises under the apartment and the car — so the
 * Meaning-Match bot has something real to catch and the revise loop runs.
 */

const cam = (rig: string, target: string | [number, number, number], d: number, az: number, el: number, d2 = d * 0.9, az2 = az + 4, el2 = el + 2, focal = 35): StudioShot["camera"] => ({
  rig,
  target,
  from: { distance: d, azimuth: az, elevation: el },
  ...(rig === "HOLD" ? {} : { to: { distance: d2, azimuth: az2, elevation: el2 } }),
  lens: { focalLength: focal, fStop: 2.8 },
});

export const DEMO_LINES = [
  "Your $10,000 raise is already gone.",
  "Taxes take 35%.",
  "The nicer apartment? $300 more a month.",
  "The car upgrade. $180.",
  "And $60 of small subscriptions.",
  "You didn't just spend the raise.",
  "You raised your baseline.",
  "So flip it: invest half, $270 a month.",
  "At 7% for 20 years, that's about $140,650.",
  "Same raise. Different life.",
] as const;

export function demoFilm(fixedBaseline: boolean): StudioFilm {
  const shots: StudioShot[] = [
    { id: "hook", purpose: "HOOK — coins still on the pedestal while the line says it's gone", line: DEMO_LINES[0], leadIn: 0.4, camera: cam("PUSH_IN", "raise", 9, 0, 8), text: [{ text: "$10,000", style: "HERO_NUMBER", at: { word: "raise" }, position: "UPPER", strikeAt: { word: "gone" } }] },
    { id: "taxes", line: DEMO_LINES[1], camera: cam("ORBIT", "raise", 9, -10, 10), actions: [{ do: "SET", actor: "raise", param: "count", to: 65, at: { word: "take" }, duration: 1.2 }], text: [{ text: "$6,500", style: "HERO_NUMBER", at: { word: "take" }, position: "UPPER", countFrom: 10000 }], transitionOut: { type: "WHIP" } },
    { id: "rent", line: DEMO_LINES[2], camera: cam("DOLLY", "building", 11, -25, 8), actions: [{ do: "ENTER", actor: "building", style: "BUILD", at: { word: "apartment" } }, { do: "FLOW", actor: "raise", into: "building", amount: 36, at: { word: "more" } }], text: [{ text: "Rent|+$300/mo", style: "LABEL", at: { word: "more" }, position: "UPPER" }] },
    { id: "car", line: DEMO_LINES[3], camera: cam("TRUCK", "car", 11, 25, 6), actions: [{ do: "ENTER", actor: "car", style: "RISE", at: { word: "car" } }, { do: "FLOW", actor: "raise", into: "car", amount: 22, at: { word: "upgrade" } }], text: [{ text: "Car|+$180/mo", style: "LABEL", at: { word: "upgrade" }, position: "UPPER" }] },
    { id: "subs", line: DEMO_LINES[4], camera: cam("ORBIT", "raise", 10, 20, 12), actions: [{ do: "ENTER", actor: "subs", style: "GROW", at: { word: "small" } }, { do: "FLOW", actor: "raise", into: "subs", amount: 7, at: { word: "subscriptions" } }], text: [{ text: "Subscriptions|+$60/mo", style: "LABEL", at: { word: "subscriptions" }, position: "UPPER" }], transitionOut: { type: "DIP_TO_BLACK", duration: 0.5 } },
    { id: "didnt", purpose: "TURN setup", line: DEMO_LINES[5], camera: cam("DOLLY", "car", 8, 30, 4), lighting: { preset: "LOW_DRAMA" } },
    fixedBaseline
      ? {
          id: "baseline",
          purpose: "TWIST — the floor itself rises under the apartment and the car",
          line: DEMO_LINES[6],
          hold: 0.8,
          camera: cam("CRANE_UP", "baseline", 12, 0, 6, 13, 6, 16, 32),
          lighting: { preset: "KEY_RIM", blendSeconds: 0.4 },
          actions: [
            { do: "ENTER", actor: "baseline", style: "FADE", at: 0 },
            { do: "SET", actor: "baseline", param: "level", to: 1.8, at: { word: "raised" }, duration: 1.6 },
            { do: "MOVE", actor: "building", to: [-3.1, 1.8, -0.9], at: { word: "raised" }, duration: 1.6 },
            { do: "MOVE", actor: "car", to: [3.4, 1.8, 1.4], at: { word: "raised" }, duration: 1.6 },
          ],
          text: [{ text: "YOUR BASELINE", style: "KICKER", at: { word: "baseline" }, position: "UPPER" }],
        }
      : {
          id: "baseline",
          purpose: "TWIST",
          line: DEMO_LINES[6],
          hold: 0.8,
          camera: cam("PUSH_IN", "pedestal", 9, 0, 4),
          lighting: { preset: "TOP_SPOT" },
          actions: [{ do: "ENTER", actor: "shaft", style: "FADE", at: 0 }],
          text: [{ text: "You raised your baseline.", style: "STATEMENT", at: { word: "raised" }, position: "UPPER" }],
        },
    { id: "flip", purpose: "PAYOFF setup", line: DEMO_LINES[7], camera: cam("DOLLY", "chart", 12, -15, 8), lighting: { preset: "SOFT_DAWN" }, actions: [...(["building", "car", "subs", "raise", "pedestal", ...(fixedBaseline ? ["baseline"] : ["shaft"])] as const).map((actor) => ({ do: "EXIT" as const, actor, style: "SINK", at: 0, duration: 0.01 })), { do: "ENTER", actor: "chart", style: "RISE", at: { word: "flip" } }, { do: "SET", actor: "chart", param: "progress", to: 0.4, at: { word: "invest" }, duration: 2 }], text: [{ text: "Invest half|$270/mo", style: "LABEL", at: { word: "half" }, position: "UPPER" }] },
    { id: "total", purpose: "PAYOFF — the number", line: DEMO_LINES[8], hold: 0.6, camera: cam("CRANE_UP", "chart", 13, -10, 4), actions: [{ do: "SET", actor: "chart", param: "progress", to: 1, at: 0, duration: 2.5 }], text: [{ text: "$140,650", style: "HERO_NUMBER", at: { word: "about" }, position: "UPPER", countFrom: 0 }, { text: "Hypothetical 7% average annual return, compounded monthly. Not a guarantee.", style: "FOOTNOTE", at: { word: "years" } }] },
    { id: "end", purpose: "BUTTON", line: DEMO_LINES[9], hold: 1.4, camera: cam("PULL_OUT", "chart", 14, 16, 9, 22, 24, 14, 28), text: [{ text: "Same raise.", style: "TITLE", at: { word: "same" }, until: { word: "different" }, position: "UPPER" }, { text: "Different life.", style: "TITLE", at: { word: "different" }, position: "UPPER" }] },
  ];
  return {
    dsl: 1,
    id: "the-raise-studio",
    title: "The Raise",
    logline: "Your $10,000 raise disappears into a nicer life — flipped, the same money becomes $140,650.",
    format: { width: 1080, height: 1920, fps: 30 },
    look: "GOLD_STUDIO",
    narration: { engine: "KOKORO", voice: "am_michael", speed: 0.92 },
    cast: [
      { id: "pedestal", kind: "PEDESTAL", position: [0, 0, 0], visible: true, params: { radius: 1.75, height: 0.6 } },
      { id: "raise", kind: "COIN_STACK", position: [0, 0.6, 0], visible: true, params: { count: 100, columns: 7 } },
      { id: "building", kind: "BUILDING", position: [-3.1, 0, -0.9], params: { floors: 7 } },
      { id: "car", kind: "CAR", position: [3.4, 0, 1.4] },
      { id: "subs", kind: "CARD_FAN", position: [0, 0.75, 0], params: { count: 7 } },
      { id: "shaft", kind: "LIGHT_SHAFT", position: [0, 0.6, 0] },
      { id: "baseline", kind: "BASELINE", position: [0, 0, 0], params: { level: 0.02, size: 16, label: "YOUR BASELINE" } },
      { id: "chart", kind: "COIN_CHART", position: [-8, 0, 0], params: { values: [3, 7, 11, 15, 19, 24, 29, 35, 40, 47, 53, 61, 68, 77, 86, 95, 105, 116, 128, 141], progress: 0 } },
    ],
    scenes: [{ id: "the-raise", set: { kind: "INFINITY_STUDIO" }, shots }],
  } as StudioFilm;
}

export const DEMO_BRIEF: FilmBrief = {
  workingTitle: "The Raise",
  premise: "A $10,000 raise disappears into a nicer life — then the same money, flipped, becomes $140,650.",
  audience: "people in their 20s–30s who just got (or want) a raise",
  promise: "why raises vanish, and the one move that keeps one",
  tone: "direct, skeptical, a little dark, then hopeful",
  centralMetaphor: { idea: "the raise is a physical pile of gold coins; the lifestyle is the things that pull them away; the baseline is the floor they all stand on", whyItFits: "money you can see leaving is money you feel", catalogRefs: ["actor:COIN_STACK", "action:FLOW", "actor:BASELINE"] },
  keyNumbers: [
    { label: "raise", value: "$10,000/yr", source: "HYPOTHETICAL", note: null },
    { label: "marginal tax", value: "35%", source: "PUBLIC_FACT", note: "22% federal + 7.65% FICA + ~5% state" },
    { label: "return", value: "7% a year", source: "HYPOTHETICAL", note: "footnoted, not a guarantee" },
  ],
  mustInclude: ["the baseline twist", "the math on screen"],
  doNotExpandInto: ["specific funds", "tax filing advice"],
  targetSeconds: 40,
  successCriteria: ["hook in 2 s", "every line's picture shows its meaning", "numbers check out to the dollar"],
  risks: ["35% is a marginal estimate — must be labelled"],
  uncertainty: "state tax varies; 35% is an approximation",
};

export const DEMO_HOOKS: HookSet = {
  options: [
    { id: "h1", line: "Your $10,000 raise is already gone.", openingVisual: "coins still stacked on the lit pedestal under a big $10,000", catalogRefs: ["actor:COIN_STACK", "actor:PEDESTAL", "text:HERO_NUMBER"], mechanism: "IMAGE_VS_LINE", stopEstimate: { kind: "ESTIMATE", score: 72, uncertainty: "MEDIUM" }, reasons: ["image says win, line says loss"], risks: [] },
    { id: "h2", line: "Where did your raise actually go?", openingVisual: "an empty pedestal in a light shaft", catalogRefs: ["actor:LIGHT_SHAFT"], mechanism: "QUESTION", stopEstimate: { kind: "ESTIMATE", score: 55, uncertainty: "MEDIUM" }, reasons: ["relatable question"], risks: ["soft"] },
    { id: "h3", line: "$10,000 raise. $0 richer.", openingVisual: "$10,000 counting down to $0", catalogRefs: ["text:HERO_NUMBER"], mechanism: "NUMBER", stopEstimate: { kind: "ESTIMATE", score: 64, uncertainty: "MEDIUM" }, reasons: ["numbers up front"], risks: ["reads like a meme"] },
    { id: "h4", line: "Nobody tells you what a raise really costs.", openingVisual: "push in on the coin stack", catalogRefs: ["camera:PUSH_IN"], mechanism: "CURIOSITY_GAP", stopEstimate: { kind: "ESTIMATE", score: 48, uncertainty: "HIGH" }, reasons: ["gap"], risks: ["vague"] },
    { id: "h5", line: "Your raise made you poorer. Here's how.", openingVisual: "coins draining into a building", catalogRefs: ["action:FLOW"], mechanism: "CONTRADICTION", stopEstimate: { kind: "ESTIMATE", score: 60, uncertainty: "MEDIUM" }, reasons: ["contradiction"], risks: ["overclaims — it doesn't literally make you poorer"] },
  ],
  recommendedId: "h1",
  rationale: "Strongest image-vs-line gap and the film pays it off literally.",
};

const ln = (i: number) => `l${i + 1}`;

export const DEMO_SCRIPT: FilmScript = {
  title: "The Raise",
  logline: DEMO_BRIEF.premise,
  centralMetaphor: DEMO_BRIEF.centralMetaphor.idea,
  hookId: "h1",
  lines: DEMO_LINES.map((text, i) => ({
    id: ln(i),
    beat: (["HOOK", "SETUP", "ESCALATION", "ESCALATION", "ESCALATION", "TURN", "TURN", "PAYOFF", "PAYOFF", "BUTTON"] as const)[i]!,
    text,
    say: null,
    intent: ["loss before gain", "first cut", "lifestyle pulls money", "more", "death by small cuts", "pause", "the twist", "the move", "the number", "callback"][i]!,
    visualIdea: ["coins on a pedestal, $10,000 struck through", "35 coins vanish, $6,500", "a building pulls coins in", "a car pulls coins in", "subscription cards nibble the rest", "the car and building stay", "the floor rises under them", "a coin chart starts", "it grows to $140,650", "pull out"][i]!,
  })),
  numbers: [
    { id: "n1", label: "raise", display: "$10,000", value: 10000, unit: "USD", appearsIn: ["l1"], source: "HYPOTHETICAL" },
    { id: "n2", label: "marginal tax", display: "35%", value: 35, unit: "PERCENT", appearsIn: ["l2"], source: "PUBLIC_FACT" },
    { id: "n3", label: "after tax", display: "$6,500", value: 6500, unit: "USD", appearsIn: ["l2"], source: "DERIVED" },
    { id: "n4", label: "rent increase", display: "$300", value: 300, unit: "USD", appearsIn: ["l3"], source: "HYPOTHETICAL" },
    { id: "n5", label: "car upgrade", display: "$180", value: 180, unit: "USD", appearsIn: ["l4"], source: "HYPOTHETICAL" },
    { id: "n6", label: "subscriptions", display: "$60", value: 60, unit: "USD", appearsIn: ["l5"], source: "HYPOTHETICAL" },
    { id: "n7", label: "half, monthly", display: "$270", value: 270, unit: "USD", appearsIn: ["l8"], source: "DERIVED" },
    { id: "n8", label: "return", display: "7%", value: 7, unit: "PERCENT", appearsIn: ["l9"], source: "HYPOTHETICAL" },
    { id: "n9", label: "years", display: "20", value: 20, unit: "YEARS", appearsIn: ["l9"], source: "HYPOTHETICAL" },
    { id: "n10", label: "future value", display: "$140,650", value: 140650, unit: "USD", appearsIn: ["l9"], source: "DERIVED" },
  ],
  calculations: [
    { id: "c1", description: "tax on the raise", op: "PERCENT_OF", inputs: [35, 10000], claimed: 3500, approximate: false, resultNumberId: null },
    { id: "c2", description: "raise after tax", op: "SUBTRACT", inputs: [10000, 3500], claimed: 6500, approximate: false, resultNumberId: "n3" },
    { id: "c3", description: "half of the after-tax raise, per month", op: "DIVIDE", inputs: [6500, 24], claimed: 270, approximate: true, resultNumberId: "n7" },
    { id: "c4", description: "$270/mo at 7% for 20 years", op: "FUTURE_VALUE_MONTHLY", inputs: [270, 7, 20], claimed: 140650, approximate: true, resultNumberId: "n10" },
  ],
  claims: [
    { lineId: "l2", text: "Taxes take 35%.", kind: "FACT", sourceNote: "22% federal bracket + 7.65% FICA + ~5% state ≈ 34.65% marginal" },
    { lineId: "l9", text: "At 7% for 20 years, that's about $140,650.", kind: "HYPOTHETICAL", sourceNote: "assumed return, footnoted" },
  ],
  caveats: ["Hypothetical 7% average annual return, compounded monthly. Not a guarantee."],
  estimatedSeconds: 38,
  voiceNotes: "Flat and dry on 'gone.' A beat before 'You raised your baseline.'",
};

export function demoWriteAnswer(): WritePackResponse {
  return structuredClone({
    brief: DEMO_BRIEF,
    hooks: DEMO_HOOKS,
    script: DEMO_SCRIPT,
    shots: {
      film: demoFilm(false) as unknown as Record<string, unknown>,
      shotNotes: demoFilm(false).scenes[0]!.shots.map((s) => ({ shotId: s.id, lineId: `l${demoFilm(false).scenes[0]!.shots.indexOf(s) + 1}`, depicts: s.purpose ?? (s.line ?? s.id), catalogRefs: [`camera:${s.camera.rig}`] })),
      changeSummary: "first draft",
    },
  });
}

const ev = (kind: "LINE" | "STILL" | "DSL" | "REPORT", ref: string, detail: string) => ({ kind, ref, detail });

/** REVIEW answer: round 1 (baseline not fixed) → REVISE with the fixed film; after the fix → APPROVE. */
export function demoReviewAnswer(currentFilm: unknown): ReviewPackResponse {
  const shots = ((currentFilm as StudioFilm)?.scenes ?? []).flatMap((s) => s.shots);
  const baseline = shots.find((s) => s.id === "baseline");
  const fixed = !!baseline?.actions?.some((a) => a.do === "SET" && (a as { param?: string }).param === "level");
  const checks = shots.filter((s) => s.line).map((s) =>
    s.id === "baseline" && !fixed
      ? { shotId: s.id, lineId: "l7", line: s.line!, meaning: "Your lifestyle became your new floor — the minimum you now need.", shown: "An empty pedestal under a spotlight; nothing rises; the apartment and car are out of frame.", verdict: "MISMATCH" as const, evidence: [ev("LINE", "l7", s.line!), ev("STILL", "baseline@0.6", "empty pedestal, light shaft, no floor moving")], replacement: { description: "The YOUR BASELINE plane rises under the apartment and the car, lifting to where the raise stood.", catalogRefs: ["actor:BASELINE", "action:SET.level", "camera:CRANE_UP"], dslHint: "SET baseline.level 0.02→1.8 on 'raised', CRANE_UP wide" } }
      : { shotId: s.id, lineId: null, line: s.line!, meaning: "as said", shown: "shows it", verdict: "MATCH" as const, evidence: [ev("STILL", `${s.id}@0.6`, "matches the line")], replacement: null },
  );
  const est = (score: number) => ({ kind: "ESTIMATE" as const, score, uncertainty: "MEDIUM" as const });
  return {
    meaningMatch: { checks, summary: fixed ? "Every line's picture shows it." : "Shot 'baseline' doesn't show the floor rising." },
    cohesion: { metaphor: { holds: true, notes: "Coins → things → floor → chart, one world.", evidence: [ev("DSL", "cast", "same pedestal/coins throughout")] }, world: { consistent: true, notes: "Gold studio throughout.", evidence: [ev("DSL", "look", "GOLD_STUDIO")] }, storyLogic: { clear: true, notes: "Loss → why → twist → fix.", evidence: [ev("LINE", "l6", "You didn't just spend the raise.")] }, pacingArc: { notes: "Fast escalation, held twist.", evidence: [ev("DSL", "baseline.hold", "0.8")] }, ending: { lands: true, why: "Callback to 'raise'.", evidence: [ev("LINE", "l10", "Same raise. Different life.")] }, issues: [], score: est(78) },
    retention: { hook: { stop: est(70), why: "Image vs line gap.", evidence: [ev("STILL", "hook@0.6", "coins + $10,000 struck")] }, beats: [{ ref: "l6", attention: est(58), dropOffRisk: "MEDIUM", why: "Quiet beat.", evidence: [ev("LINE", "l6", "You didn't just spend the raise.")] }], fixes: fixed ? [] : [{ ref: "baseline", kind: "ESCALATE_VISUAL", suggestion: "Make the floor visibly rise under the things.", evidence: [ev("REPORT", "meaning-match:baseline", "MISMATCH")] }], rewatchShareSave: est(55), summary: "Holds well until the twist.", caveat: "Estimates of a cold viewer's attention, not view predictions." },
    quality: { stage: "STORYBOARD", perShot: shots.map((s) => ({ shotId: s.id, composition: est(75), legibility: est(80), note: "" })), issues: [], premiumBar: { verdict: "AT", why: "Clean product-film lighting.", evidence: [ev("STILL", "total@0.6", "big number reads")] }, verdict: "PASS", topFixes: [] },
    factCheck: { claims: [{ claimText: "Taxes take 35%.", sourceSupport: "approximate marginal rate (22% + 7.65% + ~5%)", evidenceStrength: "MODERATE", freshnessConcern: false, numericConsistency: true, omittedCaveatRisk: true, overstatesEvidence: false }], result: "PASS", requiredEdits: [], blockReason: null },
    director: fixed
      ? { decision: "APPROVE", rationale: "Every line's picture shows it, the math checks out, the twist lands.", revisions: [], overruled: [], notesForChris: "Storyboard's ready. The baseline shot now shows the floor rising." }
      : { decision: "REVISE", rationale: "The twist line's picture doesn't show a baseline rising — the film's key idea is invisible.", revisions: [{ target: "SHOTS", refs: ["baseline"], instruction: "Raise the YOUR BASELINE plane under the apartment and car on 'raised'; crane up wide enough to keep them in frame.", because: [ev("REPORT", "meaning-match:baseline", "MISMATCH")] }], overruled: [], notesForChris: "One fix: the 'baseline' shot didn't show the floor rising. Fixed in round 2." },
    revisedFilm: fixed ? null : (demoFilm(true) as unknown as Record<string, unknown>),
    revisedScript: null,
  };
}

export function demoFixAnswer(): FixPackResponse {
  return { film: demoFilm(true) as unknown as Record<string, unknown>, script: null, changeSummary: "Baseline shot: the floor now rises under the apartment and car." };
}

export function demoFinalAnswer(): FinalPackResponse {
  const est = (score: number) => ({ kind: "ESTIMATE" as const, score, uncertainty: "MEDIUM" as const });
  return {
    quality: { stage: "RENDER", perShot: [{ shotId: "hook", composition: est(80), legibility: est(85), note: "" }], issues: [], premiumBar: { verdict: "AT", why: "Reads as a premium motion piece.", evidence: [{ kind: "STILL", ref: "total@0.5", detail: "$140,650 crisp" }] }, verdict: "PASS", topFixes: [] },
    analysis: { verdict: "GOOD", headline: "Strong hook and a twist that lands; the subscriptions beat is small on a phone.", hook: { stop: est(70), why: "coins vs 'gone'", evidence: [{ kind: "STILL", ref: "hook@0.5", detail: "$10,000 struck through" }] }, dropOffs: [{ ref: "subs", why: "cards are small", evidence: [{ kind: "STILL", ref: "subs@0.5", detail: "cards tiny" }] }], topFixes: ["Make the subscription cards bigger"], caveat: "One simulated viewing — estimates, not predictions." },
  };
}

/** The demo answer for whatever the film is waiting on (dev demo mode only). */
export function demoAnswerFor(kind: "WRITE" | "REVIEW" | "FIX" | "FINAL", currentFilm: unknown): string {
  const v = kind === "WRITE" ? demoWriteAnswer() : kind === "REVIEW" ? demoReviewAnswer(currentFilm) : kind === "FIX" ? demoFixAnswer() : demoFinalAnswer();
  return "Here's the JSON:\n```json\n" + JSON.stringify(v, null, 2) + "\n```";
}
