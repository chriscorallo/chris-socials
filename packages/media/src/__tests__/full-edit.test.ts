import { describe, it, expect } from "vitest";
import {
  buildFullEdit,
  buildSentences,
  classifyBeat,
  hookTitles,
  LEXICAL_EMBEDDER,
  planStory,
  scoreHookCandidates,
  spokenNumbers,
  storyTargetFromProfile,
  TITLE_AVOID,
  type FESentence,
} from "../full-edit";
import { chooseVisuals, graphicNumbers } from "../full-edit/visuals";
import { EditTimelineSchema, timelineDuration, type EditTimeline } from "../timeline";
import { resolveVisualPlacements } from "../visual-placement";
import type { GraphicProps } from "../graphics/contract";
import type { TranscriptWord } from "../caption-chunking";

/** A take: sentences said back to back (0.18 s per word), `gap` s of silence between them. */
function take(lines: string[], gap = 0.6, lead = 0.8) {
  const words: TranscriptWord[] = [];
  const silences: Array<{ start: number; end: number }> = [{ start: 0, end: lead }];
  let t = lead;
  for (const line of lines) {
    for (const w of line.split(" ")) {
      words.push({ word: w, start: +t.toFixed(3), end: +(t + 0.16).toFixed(3) });
      t += 0.18;
    }
    silences.push({ start: +(t - 0.02).toFixed(3), end: +(t + gap).toFixed(3) });
    t += gap;
  }
  return { words, silences, duration: +(t + 0.5).toFixed(3) };
}

const BASE: EditTimeline = EditTimelineSchema.parse({
  version: 2,
  clips: [{ id: "c1", mediaAssetId: "take", sourceStart: 0, sourceEnd: 10 }],
  captions: { fontId: "inter-display-extrabold", fontSize: 64, color: "#FFFFFF", highlightColor: "#FFD84D", y: 0.72 },
});

const ctxFor = (S: FESentence[]) => ({ index: 0, count: S.length, prevBeat: null });

describe("full edit — numbers he said", () => {
  it("reads digits, spelled-out amounts and percentages with their word span; skips plan names and years", () => {
    const n = (s: string) => spokenNumbers(s.split(" ")).map((x) => [x.value, x.kind]);
    expect(n("My friend got a $10,000 raise")).toEqual([[10000, "MONEY"]]);
    expect(n("say you make sixty thousand dollars a year")).toEqual([[60000, "MONEY"]]);
    expect(n("that's a hundred percent return")).toEqual([[100, "PERCENT"]]);
    expect(n("matches up to 5% of your 401(k)")).toEqual([[5, "PERCENT"]]);
    expect(n("back in 2019 I paid $1.2k")).toEqual([[1200, "MONEY"]]);
    const s = spokenNumbers("it takes 20 years".split(" "))[0]!;
    expect([s.w0, s.w1, s.minor]).toEqual([2, 2, false]);
  });
});

describe("full edit — understanding (beats)", () => {
  it("classifies greetings, meta, tangents, fluff, recaps, lists, CTAs and sign-offs from cue phrases", () => {
    const beat = (t: string, index = 0, count = 10) => classifyBeat(t, { index, count, prevBeat: null }, spokenNumbers(t.split(" "))).beat;
    expect(beat("Hey guys, so, um, today I wanna talk about raises.")).toBe("GREETING");
    expect(beat("Okay, so this one is about your 401(k).", 1)).toBe("META");
    expect(beat("By the way, my trainer was not happy.", 4)).toBe("TANGENT");
    expect(beat("That's a whole different video, so I'll do that one later.", 6)).toBe("TANGENT");
    expect(beat("Anyway, um, where was I?", 5)).toBe("FLUFF");
    expect(beat("I know that's a lot.", 6)).toBe("FLUFF");
    expect(beat("So yeah, just to recap, pay more than the minimum.", 7)).toBe("RECAP");
    expect(beat("Second, automate half of it into savings.", 5)).toBe("LIST_ITEM");
    expect(beat("Follow for more money stuff.", 9)).toBe("CTA");
    expect(beat("And, ah, yeah.", 9)).toBe("SIGN_OFF");
    // "Anyway," followed by real content is NOT a filler line (the lead-in is trimmed instead).
    expect(beat("Anyway, what happened is lifestyle creep.", 4)).not.toBe("FLUFF");
  });

  it("splits sentences on punctuation and on long measured pauses, not on a pause Whisper stretched a word over", () => {
    const words: TranscriptWord[] = [
      { word: "Hey", start: 0, end: 1.06 }, // Whisper stretched it over the leading silence
      { word: "guys,", start: 1.06, end: 1.34 },
      { word: "raises", start: 1.4, end: 1.8 },
      { word: "matter", start: 2.8, end: 3.1 },
      { word: "a", start: 3.1, end: 3.2 },
      { word: "lot.", start: 3.2, end: 3.5 },
    ];
    const S = buildSentences(words, [{ start: 0, end: 1.0 }, { start: 1.85, end: 2.75 }]);
    expect(S.map((s) => s.text)).toEqual(["Hey guys, raises", "matter a lot."]);
  });
});

describe("full edit — hook bot", () => {
  const lines = [
    "So today I want to talk about raises.",
    "A lot of people think a raise means you finally get ahead.",
    "But here's what actually happens.",
    "My friend got a $10,000 raise last year.",
    "Six months later he had less money than before the raise.",
    "Follow for more.",
  ];
  const { words, silences } = take(lines);
  const S = buildSentences(words, silences);
  const all = new Set(S.map((s) => s.id));
  const score = (clean: (s: FESentence) => boolean = () => true) =>
    scoreHookCandidates(S, { relevance: new Map(S.map((s) => [s.id, 0.6])), cleanEdges: clean, eligible: all, takeEndS: words[words.length - 1]!.end });

  it("picks the concrete, surprising line (a real number + stakes) over the slow setup, with evidence", () => {
    const c = score();
    expect(c[0]!.text).toMatch(/^My friend got a \$10,000 raise last year\./);
    expect(c[0]!.reason).toMatch(/\$10,000/);
    const opener = c.find((x) => x.text.startsWith("But here's"))!;
    expect(opener.features.some((f) => f.key === "needs-context")).toBe(true);
    expect(c.find((x) => x.text.startsWith("So today"))!.score).toBeLessThan(0);
  });

  it("a line that can't be cut out cleanly (no pause around it) loses", () => {
    const c = score((s) => !s.text.startsWith("My friend"));
    expect(c[0]!.text.startsWith("My friend")).toBe(false);
  });

  it("titles come from his words and numbers, short, and never from the brand's avoid list", () => {
    const hook = S.filter((s) => s.text.startsWith("My friend") || s.text.startsWith("Six months"));
    const titles = hookTitles(hook, S, "raise");
    expect(titles.length).toBeGreaterThan(0);
    expect(titles[0]!.text).toBe("The $10K raise");
    for (const t of titles) {
      expect(t.text.split(" ").length).toBeLessThanOrEqual(8);
      expect(TITLE_AVOID.test(t.text)).toBe(false);
    }
    const debt = buildSentences(take(["20 years.", "For $5,000."]).words, null);
    expect(hookTitles(debt, debt, null)[0]!.text).toBe("$5K → 20 years");
    expect(TITLE_AVOID.test("Unlock your financial future")).toBe(true);
  });

  it("a title is a whole thought — never chopped mid-sentence or ending on a bare number (live bug 2026-10-19)", () => {
    const live = buildSentences(take(["If you are literally paying 80, 90% in just your needs, where are you saving?"]).words, null);
    const titles = hookTitles(live, live, "car").map((t) => t.text);
    expect(titles).not.toContain("If you are literally paying 80");
    expect(titles).not.toContain("Car: 90%");
    for (const t of titles) {
      expect(t).not.toMatch(/\b\d[\d,.]*$/);
      expect(t).not.toMatch(/^if\b/i);
    }
  });
});

describe("full edit — story bot (say it once, cut the fluff, fit the references' length)", () => {
  const lines = [
    "Hey everyone, so, um, I've been wanting to make this video for a while now.",
    "Most people overpay on rent.",
    "Most people overpay on rent every single month.",
    "If you pay $2,000 a month you lose $24,000 a year.",
    "By the way, my landlord has a boat.",
    "Anyway, where was I?",
    "First, ask for the renewal price early.",
    "Second, compare three places nearby.",
    "Third, negotiate with the numbers.",
    "So yeah, again, just to recap, ask early, compare, negotiate.",
    "The bottom line is rent is the bill you can actually negotiate.",
    "That's it.",
  ];
  const { words, silences } = take(lines);
  const S = buildSentences(words, silences);
  const n = S.length;
  const ident = S.map((_, i) => S.map((__, j) => (i === j ? 1 : 0)));
  const base = {
    words,
    sentences: S,
    sim: ident,
    sameThreshold: 0.62,
    relevance: S.map(() => 0.6),
    safeAfter: () => true,
    estimateS: (spans: Array<{ w0: number; w1: number }>) => spans.reduce((a, sp) => a + (words[sp.w1]!.end - words[sp.w0]!.start) + 0.3, 0),
    target: { targetS: 1000, minS: 10, maxS: 1000, source: "DEFAULTS" as const },
    hookIds: [] as number[],
  };
  const kindOf = (p: ReturnType<typeof planStory>, start: string) => {
    const s = S.find((x) => x.text.startsWith(start))!;
    return p.decisions[s.id]!.kept ? "KEPT" : p.decisions[s.id]!.kind;
  };

  it("drops the earlier take of a retake, greetings, tangents, transitions, recaps and sign-offs — each with a reason", () => {
    const p = planStory(base);
    expect(kindOf(p, "Most people overpay on rent.")).toBe("RETAKE");
    expect(kindOf(p, "Most people overpay on rent every")).toBe("KEPT");
    expect(kindOf(p, "Hey everyone")).toMatch(/GREETING|META/);
    expect(kindOf(p, "By the way")).toBe("TANGENT");
    expect(kindOf(p, "Anyway, where")).toBe("FLUFF");
    expect(kindOf(p, "So yeah, again")).toBe("RECAP");
    expect(kindOf(p, "That's it")).toBe("SIGN_OFF");
    for (const d of p.decisions.filter((x) => !x.kept)) expect(d.why.length).toBeGreaterThan(5);
  });

  it("says each point once: a restatement of an earlier line goes (topic-centred similarity + shared words + cue)", () => {
    const L = ["The minimum payment is designed to keep you in debt.", "It's basically designed so you stay in debt as long as possible.", "Nobody starts with $18,000."];
    const t2 = take(L);
    const S2 = buildSentences(t2.words, t2.silences);
    const sim = [
      [1, 0.48, 0.1],
      [0.48, 1, 0.1],
      [0.1, 0.1, 1],
    ];
    const p = planStory({ ...base, words: t2.words, sentences: S2, sim, relevance: [0.6, 0.6, 0.6], topicStems: new Set(["minimum", "payment"]) });
    expect(p.decisions[1]!.kind).toBe("REPEAT");
    expect(p.decisions[1]!.keptInstead).toBe(0);
    expect(p.decisions[2]!.kept).toBe(true);
  });

  it("fits the target length by dropping the lowest-value lines; a list goes together; a pointer never outlives its line", () => {
    const p = planStory({ ...base, target: { targetS: 9, minS: 6, maxS: 12, source: "REFERENCES" } });
    const steps = ["First,", "Second,", "Third,"].map((x) => kindOf(p, x));
    expect(new Set(steps).size).toBe(1); // all kept or all dropped
    expect(p.estimatedS).toBeLessThanOrEqual(9 * 1.04 + 4); // within the target (+ protected arc lines)
    expect(kindOf(p, "If you pay $2,000")).toBe("KEPT"); // the number is the most valuable line
  });

  it("a fast talker with no clean pauses still lands near the references' length (word-edge cuts in pass 2)", () => {
    // No pause anywhere except the very start/end — pass 1 can't cut a single line.
    const noPauses = (k: number) => k < 0 || k >= words.length - 1;
    const target = { targetS: 9, minS: 6, maxS: 12, source: "REFERENCES" as const };
    const full = planStory({ ...base, safeAfter: noPauses, target: { ...target, targetS: 1000, maxS: 1000 } });
    const p = planStory({ ...base, safeAfter: noPauses, target });
    expect(p.estimatedS).toBeLessThan(full.estimatedS * 0.75);
    expect(p.decisions.filter((d) => d.kind === "LOW_VALUE").length).toBeGreaterThan(0);
    // Within the longest reference length, give or take the protected arc lines.
    expect(p.estimatedS).toBeLessThanOrEqual(target.maxS + 6);
    // A video already inside the references' range never takes word-edge cuts.
    const roomy = planStory({ ...base, safeAfter: noPauses, target: { ...target, maxS: full.estimatedS + 1 } });
    expect(roomy.decisions.filter((d) => d.kind === "LOW_VALUE")).toEqual([]);
  });

  it("restoring a removed line (Chris's one tap) keeps it", () => {
    const tangent = S.find((s) => s.text.startsWith("By the way"))!;
    const p = planStory({ ...base, forceKeep: [tangent.id] });
    expect(p.decisions[tangent.id]!.kept).toBe(true);
    expect(p.decisions[tangent.id]!.forced).toBe(true);
  });

  it("starts on the hook: weak set-up before it goes; a strong line before it makes a cold open (hook played first)", () => {
    const hook = S.find((s) => s.text.startsWith("If you pay"))!;
    const p = planStory({ ...base, hookIds: [hook.id] });
    expect(p.order[0]!.sentenceIds).toEqual([hook.id]);
    expect(p.order[0]!.role).toBe("HOOK");
    // "Most people overpay on rent every single month." is a claim → kept → cold open.
    expect(p.coldOpen).toBe(true);
    expect(p.decisions[hook.id]!.kind).toBe("HOOK_MOVED");
    // Never played twice unless the next line points back at it.
    expect(p.order.filter((o) => o.sentenceIds.includes(hook.id)).length).toBe(1);
    void n;
  });

  it("removes restarts and fillers only where both cut points sit on a pause", () => {
    const t = take(["So, a lot of people, uh, a lot of people think raises fix everything."]);
    const S3 = buildSentences(t.words, null);
    const safeEverywhere = planStory({ ...base, words: t.words, sentences: S3, sim: [[1]], relevance: [0.6] });
    expect(safeEverywhere.wordCuts.map((c) => c.kind)).toEqual(expect.arrayContaining(["LEAD_IN", "RESTART"]));
    const nowhere = planStory({ ...base, words: t.words, sentences: S3, sim: [[1]], relevance: [0.6], safeAfter: (k) => k < 0 || k >= t.words.length - 1 });
    expect(nowhere.wordCuts).toEqual([]);
  });
});

describe("full edit — visuals bot", () => {
  it("only shows numbers said in the line it illustrates; never full-screen; spaced out; none during the hook", () => {
    const L = ["The new car payment was $400 a month.", "Pay off your debt.", "Your company matches up to 5%.", "Keep the car."];
    const t = take(L, 2);
    const S = buildSentences(t.words, t.silences);
    const moments = S.map((s) => ({ sentence: s, outStart: s.start, outEnd: s.end, wordOut: (w: number) => t.words[w]!.start, vec: [1] }));
    const { picks, rejected } = chooseVisuals({ moments, spoken: S.flatMap((s) => s.numbers), vocabulary: new Set(t.words.map((w) => w.word.toLowerCase().replace(/[^a-z0-9$%']/g, ""))), presetVec: () => [1], weakMatch: 0.1, hookEndS: 1, durationS: t.duration });
    expect(picks.length).toBeGreaterThan(0);
    for (const p of picks) {
      const s = S.find((x) => x.id === p.sentenceId)!;
      for (const v of graphicNumbers(p.visual.props as unknown as GraphicProps)) expect(s.numbers.map((x) => x.value)).toContain(v);
      expect((p.visual.props as { screen?: string }).screen).not.toBe("FULL");
      expect(p.visual.start).toBeGreaterThanOrEqual(1);
    }
    for (let i = 1; i < picks.length; i++) expect(picks[i]!.visual.start).toBeGreaterThanOrEqual(picks[i - 1]!.visual.end);
    // A line with no number never gets a number on screen (e.g. "debt → 0" would invent the 0).
    const debt = S.find((s) => s.text.startsWith("Pay off"))!;
    for (const p of picks.filter((x) => x.sentenceId === debt.id)) expect(p.numbers).toEqual([]);
    void rejected;
  });
});

describe("full edit — end to end (pure, model-free embedder)", () => {
  const lines = [
    "Hey guys, so, um, today I wanna talk about raises.",
    "A lot of people think a raise means you finally get ahead.",
    "But here's what actually happens.",
    "My friend got a $10,000 raise last year.",
    "Six months later he had less money than before the raise.",
    "How does that even happen?",
    "Side note, he also bought a jet ski.",
    "What happened is lifestyle creep.",
    "The new car payment was $400 a month.",
    "First, decide where the raise goes before it lands.",
    "Second, automate half of it into savings.",
    "Third, spend the other half guilt free.",
    "Do that and the raise actually makes you richer.",
    "Follow for more.",
  ];
  const t = take(lines);
  const input = { base: BASE, mediaAssetId: "take", words: t.words, durationSeconds: t.duration, silences: t.silences, story: storyTargetFromProfile({ durationS: { value: 30, n: 10, p25: 22, p75: 40 } }) };

  it("produces a valid timeline: hook first, cuts inside pauses, only his audio, a grounded title, numbers verified", async () => {
    const r = await buildFullEdit(input, LEXICAL_EMBEDDER);
    if (!r.ok) throw new Error(r.message);
    const tl = EditTimelineSchema.parse(r.timeline);
    expect(tl.clips.every((c) => c.mediaAssetId === "take")).toBe(true);
    // Every clip edge sits outside every word (no clipped words).
    for (const c of tl.clips) {
      for (const w of t.words) {
        expect(c.sourceStart <= w.start + 1e-6 || c.sourceStart >= w.end - 1e-6).toBe(true);
        expect(c.sourceEnd <= w.start + 1e-6 || c.sourceEnd >= w.end - 1e-6).toBe(true);
      }
    }
    expect(r.report.hook.text).toMatch(/\$10,000/);
    // The first clip plays the hook.
    const hookStart = t.words.find((w) => w.word === "My")!.start;
    expect(tl.clips[0]!.sourceStart).toBeLessThanOrEqual(hookStart);
    expect(tl.clips[0]!.sourceEnd).toBeGreaterThan(hookStart);
    // Greeting, tangent gone; each with a reason in "Removed lines".
    expect(r.report.removed.map((x) => x.kind)).toEqual(expect.arrayContaining(["GREETING", "TANGENT"]));
    // Title: his words / numbers only.
    expect(tl.texts[0]?.text).toBe("The $10K raise");
    // Shorter than the take, close to the reference length.
    expect(timelineDuration(tl)).toBeLessThan(t.duration);
    expect(r.report.lengthLine).toMatch(/→/);
    // Every number on screen was said.
    const spoken = spokenNumbers(t.words.map((w) => w.word)).map((n) => n.value);
    for (const v of r.report.visuals) for (const n of v.numbers) expect(spoken).toContain(n);
    // No two graphics at once, none during the hook title.
    const vs = [...tl.visuals].sort((a, b) => a.start - b.start);
    for (let i = 1; i < vs.length; i++) expect(vs[i]!.start).toBeGreaterThanOrEqual(vs[i - 1]!.end);
    for (const v of vs) expect(v.start).toBeGreaterThanOrEqual(tl.texts[0]?.end ?? 0);
    // Checks are reported, typed.
    expect(r.report.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["MEANING_MATCH", "VERIFICATION", "COHESION", "QUALITY", "RETENTION"]));
  });

  it("follows the Creative Brief: the planned hook opens the video and the planned payoff survives a tight length target", async () => {
    const brief = { hook: "How does that even happen?", keep: ["Do that and the raise actually makes you richer."] };
    const tight = { ...input, story: { targetS: 8, minS: 6, maxS: 10, source: "REFERENCES" as const } };
    const without = await buildFullEdit(tight, LEXICAL_EMBEDDER);
    const withBrief = await buildFullEdit({ ...tight, brief }, LEXICAL_EMBEDDER);
    if (!without.ok || !withBrief.ok) throw new Error("full edit failed");
    expect(withBrief.report.hook.fromBrief).toBe(true);
    expect(withBrief.report.hook.text).toBe("How does that even happen?");
    expect(without.report.hook.fromBrief).toBe(false);
    const kept = (r: typeof withBrief) => r.sentences.filter((s) => r.story.decisions[s.id]!.kept).map((s) => s.text);
    expect(kept(withBrief)).toContain("Do that and the raise actually makes you richer.");
    // The brief changes the plan, never Chris's own choices: an explicit hook pick still wins.
    const chosen = await buildFullEdit({ ...tight, brief, choices: { hookIndex: 0 } }, LEXICAL_EMBEDDER);
    if (!chosen.ok) throw new Error("full edit failed");
    expect(chosen.report.hook.chosenIndex).toBe(0);
  });

  it("is deterministic (same inputs → same key + timeline) and the renderer's placement re-solve changes nothing (parity)", async () => {
    const a = await buildFullEdit(input, LEXICAL_EMBEDDER);
    const b = await buildFullEdit(input, LEXICAL_EMBEDDER);
    if (!a.ok || !b.ok) throw new Error("failed");
    expect(a.inputsKey).toBe(b.inputsKey);
    expect(JSON.stringify(a.timeline)).toBe(JSON.stringify(b.timeline));
    const resolved = resolveVisualPlacements(a.timeline, { subjectTracks: { take: null }, wordsByAsset: { take: t.words } });
    expect(resolved.map((v) => [v.placement.x, v.placement.y, v.placement.scale])).toEqual(a.timeline.visuals.map((v) => [v.placement.x, v.placement.y, v.placement.scale]));
  });

  it("“Try another hook” uses the chosen candidate; a different key", async () => {
    const a = await buildFullEdit(input, LEXICAL_EMBEDDER);
    const b = await buildFullEdit({ ...input, choices: { hookIndex: 1 } }, LEXICAL_EMBEDDER);
    if (!a.ok || !b.ok) throw new Error("failed");
    expect(b.report.hook.chosenIndex).toBe(1);
    expect(b.report.hook.text).toBe(a.report.hook.candidates[1]!.text);
    expect(b.inputsKey).not.toBe(a.inputsKey);
  });

  it("no transcript → a plain reason, nothing built", async () => {
    const r = await buildFullEdit({ ...input, words: [] }, LEXICAL_EMBEDDER);
    expect(r.ok).toBe(false);
  });

  it("buildSentences context helper", () => {
    const S = buildSentences(t.words, t.silences);
    expect(classifyBeat(S[0]!.text, ctxFor(S), S[0]!.numbers).beat).toBe("GREETING");
  });
});

describe("hook titles never carry profanity or insults", () => {
  it("TITLE_PROFANITY blocks insults, keeps normal words", async () => {
    const { TITLE_PROFANITY } = await import("../full-edit/hook");
    expect(TITLE_PROFANITY.test("Somebody who has $400,000 You are a bitch")).toBe(true);
    expect(TITLE_PROFANITY.test("Holy shit, the 401k")).toBe(true);
    expect(TITLE_PROFANITY.test("The $10K raise trap")).toBe(false);
    expect(TITLE_PROFANITY.test("Assets vs liabilities")).toBe(false);
    expect(TITLE_PROFANITY.test("Classic budgeting mistakes")).toBe(false);
  });
});

describe("close-up placement protects the face core, not the whole head", () => {
  it("shrinks protection to eyes→mouth only when the head fills the frame", async () => {
    const { protectedFaceRect } = await import("../visual-placement");
    const safe = { x: 60, y: 240, width: 900, height: 1000 };
    const closeUp = { x: 100, y: 250, width: 850, height: 900 };
    const core = protectedFaceRect(closeUp, safe);
    expect(core.width * core.height).toBeLessThan(0.45 * closeUp.width * closeUp.height);
    expect(core.y).toBeGreaterThan(closeUp.y + 200); // hair/forehead left free
    const wide = { x: 400, y: 500, width: 250, height: 280 };
    expect(protectedFaceRect(wide, safe)).toEqual(wide);
  });
});
