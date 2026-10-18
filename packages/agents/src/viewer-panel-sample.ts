import type { ViewerReview } from "./viewer-panel-schema";

/**
 * A recorded-shape Viewer Panel output (hand-written to the schema — no real call was made: the
 * account had no credit while this was built). Used by the agent, worker and UI tests and the
 * visual check. Times fit a ~20 s talking-head video with jump cuts and one stat card.
 */
export function sampleViewerReview(): ViewerReview {
  const ev = (t: number, kind: "SEEN" | "SAID" | "HEARD" | "MEASURED", detail: string) => ({ t, kind, detail });
  return {
    persona: "Cold viewer on Instagram Reels who has never seen this creator",
    verdict: {
      tier: "GOOD",
      headline: "Strong hook and a useful number, but the middle drags and the ending fizzles.",
      biggestReason: "Seconds 8–12 restate the hook twice before the payoff, so attention sags right before the stat card.",
      evidence: [ev(8.4, "SAID", "\"so like I said, the thing is\""), ev(12.3, "SEEN", "stat card '$24,500' appears")],
    },
    hook: {
      tEnd: 2.5,
      wouldStopScrolling: "YES",
      stopChancePct: 62,
      firstFrameRead: "A guy looking straight at camera with a bold caption 'Max out your 401(k)?'",
      why: "A direct challenge to common advice in the first second, with a caption that reads with the sound off.",
      evidence: [ev(0, "SEEN", "caption 'Max out your 401(k)?' over a centred talking head"), ev(0.6, "SAID", "\"Everyone says max out your 401k\"")],
    },
    beats: [
      { tStart: 0, tEnd: 2.5, state: "curious", secondaryState: "skeptical", intensity: 4, attention: 82, scrollAwayPct: 20, thinking: "wait, isn't that the right move?", driver: "Contrarian opening line", evidence: [ev(0.6, "SAID", "\"Everyone says max out your 401k\"")] },
      { tStart: 2.5, tEnd: 6, state: "hooked", secondaryState: null, intensity: 4, attention: 78, scrollAwayPct: 10, thinking: "ok what's the real number", driver: "Promise of a concrete number; tight jump cuts keep it moving", evidence: [ev(3.1, "SEEN", "punch-in to a tighter frame on the cut"), ev(4.2, "SAID", "\"what does that actually mean in 2026\"")] },
      { tStart: 6, tEnd: 8.4, state: "educated", secondaryState: null, intensity: 3, attention: 70, scrollAwayPct: 12, thinking: "24.5k, got it", driver: "The number lands clearly", evidence: [ev(6.8, "SAID", "\"twenty-four thousand five hundred\"")] },
      { tStart: 8.4, tEnd: 12, state: "bored", secondaryState: null, intensity: 3, attention: 48, scrollAwayPct: 34, thinking: "you already said that", driver: "Repeats the hook before moving on; one long shot with no new information", evidence: [ev(8.4, "SAID", "\"so like I said, the thing is\""), ev(10, "SEEN", "same wide framing for 3.6 s")] },
      { tStart: 12, tEnd: 16.5, state: "educated", secondaryState: "curious", intensity: 4, attention: 72, scrollAwayPct: 14, thinking: "oh, the match first — that's useful", driver: "Stat card appears exactly as the number is said", evidence: [ev(12.3, "SEEN", "stat card '$24,500' slides in"), ev(12.4, "SAID", "\"get the full match first\"")] },
      { tStart: 16.5, tEnd: 20, state: "neutral", secondaryState: null, intensity: 2, attention: 55, scrollAwayPct: 22, thinking: "is that it?", driver: "Ending trails off after the last line", evidence: [ev(18.6, "SAID", "\"anyway\""), ev(19.5, "SEEN", "held frame after the last word")] },
    ],
    dropOffs: [{ t: 9.2, riskPct: 34, reason: "Restating the hook instead of delivering the next idea", evidence: [ev(8.4, "SAID", "\"so like I said\"")] }],
    craft: [
      { category: "CUT_WITHOUT_PURPOSE", verdict: "MINOR", tStart: 14.1, tEnd: 14.3, finding: "A punch-in mid-sentence that doesn't mark a new idea", evidence: [ev(14.1, "SEEN", "framing jumps 1.0× → 1.2× mid-phrase")] },
      { category: "PACING", verdict: "PROBLEM", tStart: 8.4, tEnd: 12, finding: "3.6 s single shot restating the hook — slower than the rest of the video", evidence: [ev(8.4, "MEASURED", "longest shot 3.6 s vs median 1.9 s")] },
      { category: "GRAPHIC_MISTIMED", verdict: "GOOD", tStart: 12.3, tEnd: null, finding: "Stat card lands exactly on the spoken number", evidence: [ev(12.3, "SEEN", "card appears as '$24,500' is said")] },
      { category: "MUSIC_OVER_VOICE", verdict: "GOOD", tStart: 0, tEnd: null, finding: "No music bed — the voice is clean", evidence: [ev(0, "MEASURED", "no background under the voice")] },
      { category: "ENDING", verdict: "PROBLEM", tStart: 18.6, tEnd: 20, finding: "Ends on 'anyway' with a held frame — no payoff line, no loop", evidence: [ev(18.6, "SAID", "\"anyway\""), ev(19.5, "SEEN", "held frame")] },
    ],
    story: {
      corePromise: "Maxing out a 401(k) means $24,500 — but start with the match",
      promiseClearAtS: 6.8,
      clarity: "MOSTLY_CLEAR",
      cohesive: true,
      confusingJumps: [],
      summary: "One clear idea; the middle repeats itself before the useful part.",
    },
    engagement: {
      watchThrough: { kind: "ESTIMATE", score: 48, uncertainty: "MEDIUM", rationale: "Hook holds, but the 8–12 s stretch is where many would leave", evidenceTimes: [0.6, 9.2] },
      rewatch: { kind: "ESTIMATE", score: 18, uncertainty: "HIGH", rationale: "Nothing dense or looping to rewatch", evidenceTimes: [19.5] },
      save: { kind: "ESTIMATE", score: 41, uncertainty: "MEDIUM", rationale: "A concrete limit and a clear first step are worth keeping", evidenceTimes: [6.8, 12.3] },
      share: { kind: "ESTIMATE", score: 22, uncertainty: "HIGH", rationale: "Useful but not a 'you need to see this' moment", evidenceTimes: [12.3] },
      comment: { kind: "ESTIMATE", score: 27, uncertainty: "HIGH", rationale: "Contrarian opener invites 'but what about…' replies", evidenceTimes: [0.6] },
      follow: { kind: "ESTIMATE", score: 24, uncertainty: "HIGH", rationale: "Clear voice, but no hint of what else this creator covers", evidenceTimes: [18.6] },
    },
    strengths: [{ t: 0, what: "Caption-led hook that works with the sound off", evidence: [ev(0, "SEEN", "bold caption on the first frame")] }],
    fixes: [
      { priority: 1, tStart: 8.4, tEnd: 11.8, instruction: "Cut 8.4–11.8 s (\"so like I said…\") and go straight to \"get the full match first\".", expectedEffect: "Removes the sag before the payoff; likely keeps more viewers to the stat card.", evidence: [ev(8.4, "SAID", "\"so like I said\"")] },
      { priority: 2, tStart: 18.6, tEnd: 20, instruction: "End on \"Your number doesn't have to be.\" and cut the held frame after it.", expectedEffect: "A cleaner landing that can loop back to the opening question.", evidence: [ev(19.5, "SEEN", "held frame after the last word")] },
      { priority: 3, tStart: 14.1, tEnd: 14.3, instruction: "Remove the mid-sentence punch-in at 14.1 s, or move it to 12.3 s with the number.", expectedEffect: "Punch-ins read as emphasis instead of noise.", evidence: [ev(14.1, "SEEN", "framing jump mid-phrase")] },
    ],
    limitations: ["Between sampled frames only the transcript and measured facts were known."],
  };
}
