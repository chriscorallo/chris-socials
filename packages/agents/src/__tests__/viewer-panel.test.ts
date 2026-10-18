import { describe, it, expect } from "vitest";
import { prisma } from "@chris/domain";
import { z } from "zod";
import { MockModelProvider } from "../providers/mock-provider";
import { AnthropicModelProvider } from "../providers/anthropic-provider";
import { CostTrackingModelProvider } from "../providers/cost-tracking-provider";
import { SpendCapCheckFailedError, SpendCapExceededError } from "../spend-cap";
import type { ModelProvider } from "../model-provider";
import {
  CERTAINTY_RE,
  checkViewerReview,
  estimateViewerReviewCost,
  estimateViewerReviewForVideo,
  formatEstimateUsd,
  formatViewerFacts,
  imageTokens,
  planViewerFrames,
  runViewerPanelAgent,
  transcriptLines,
  viewerFrameSize,
  ViewerReviewSchema,
  VIEWER_OUTPUT_TOKENS_ESTIMATE,
  type ViewerFrameImage,
  type ViewerReviewFacts,
} from "../viewer-panel";
import { sampleViewerReview } from "../viewer-panel-sample";

function facts(overrides: Partial<ViewerReviewFacts> = {}): ViewerReviewFacts {
  const words = "Everyone says max out your 401k. What does that actually mean in 2026? It means twenty four thousand five hundred.".split(" ").map((w, i) => ({ word: w, start: 0.3 + i * 0.4, end: 0.3 + i * 0.4 + 0.32 }));
  return {
    subject: "CHRIS_RENDER",
    title: "401k limit",
    platform: "INSTAGRAM",
    persona: "COLD",
    durationS: 20,
    width: 1080,
    height: 1920,
    words,
    wordsSource: "from the edit's transcript",
    talking: true,
    cuts: [
      { t: 3.1, kind: "PAUSE_REMOVED", removedS: 0.42, zoomFrom: 1, zoomTo: 1.12 },
      { t: 14.1, kind: "FRAMING", zoomFrom: 1, zoomTo: 1.2 },
    ],
    cutsSource: "EDIT",
    zooms: [],
    captions: { enabled: true, preset: "BOLD_HIGHLIGHT", uppercase: false },
    texts: [],
    graphics: [{ template: "STAT_CARD", start: 12.3, end: 15, label: "$24,500" }],
    music: { present: true, levelDb: -18, duckDb: 10 },
    sfxCount: 1,
    audio: {
      integratedLufs: -14.2,
      truePeakDbtp: -1.1,
      clipping: false,
      voiceLevelDb: -18,
      backgroundLevelDb: -27,
      backgroundUnderVoiceDb: 9,
      background: "present",
      levelPerSecond: [-30, -19, -18],
      levelJumps: [{ t: 9, fromDb: -18, toDb: -26 }],
      cutJumps: [{ t: 3.1, deltaDb: 7.2 }],
    },
    referenceStyle: { sampleSize: 15, shotMedianS: 2.4, firstCutS: 3.2, wpm: 190, gapP90S: 0.25, hookDurationS: 2.1, backgroundUnderVoiceDb: 22 },
    notes: [],
    ...overrides,
  };
}

const frame = (t: number, reason: ViewerFrameImage["reason"] = "SAMPLE"): ViewerFrameImage => ({ t, reason, base64: "ZmFrZQ==", mediaType: "image/jpeg" });

describe("Viewer Panel output schema", () => {
  it("accepts the recorded fixture", () => {
    expect(ViewerReviewSchema.safeParse(sampleViewerReview()).success).toBe(true);
  });

  it("rejects a beat with no evidence (every judgment must cite a timestamped observation)", () => {
    const r = sampleViewerReview();
    r.beats[0]!.evidence = [];
    expect(ViewerReviewSchema.safeParse(r).success).toBe(false);
  });

  it("rejects evidence without a timestamp or with an unknown kind", () => {
    const r = sampleViewerReview() as unknown as { hook: { evidence: unknown[] } };
    r.hook.evidence = [{ kind: "SEEN", detail: "a face" }];
    expect(ViewerReviewSchema.safeParse(r).success).toBe(false);
    r.hook.evidence = [{ t: 1, kind: "VIBES", detail: "feels viral" }];
    expect(ViewerReviewSchema.safeParse(r).success).toBe(false);
  });

  it("an engagement number must be labelled an ESTIMATE, carry an uncertainty and cite moments", () => {
    const noLabel = sampleViewerReview() as unknown as { engagement: { share: Record<string, unknown> } };
    noLabel.engagement.share = { score: 90, uncertainty: "LOW", rationale: "will go viral", evidenceTimes: [1] };
    expect(ViewerReviewSchema.safeParse(noLabel).success).toBe(false);
    const noEvidence = sampleViewerReview();
    noEvidence.engagement.share.evidenceTimes = [];
    expect(ViewerReviewSchema.safeParse(noEvidence).success).toBe(false);
    const prediction = sampleViewerReview();
    (prediction.engagement.share as { kind: string }).kind = "PREDICTION";
    expect(ViewerReviewSchema.safeParse(prediction).success).toBe(false);
  });

  it("has no place for a view-count forecast (unknown fields are dropped, never stored)", () => {
    const r = { ...sampleViewerReview(), predictedViews: 1_000_000, viral: true };
    const parsed = ViewerReviewSchema.parse(r) as Record<string, unknown>;
    expect(parsed.predictedViews).toBeUndefined();
    expect(parsed.viral).toBeUndefined();
  });

  it("caps fixes at five and scores at 0–100", () => {
    const r = sampleViewerReview();
    r.fixes = Array.from({ length: 6 }, () => r.fixes[0]!);
    expect(ViewerReviewSchema.safeParse(r).success).toBe(false);
    const s = sampleViewerReview();
    s.beats[0]!.attention = 140;
    expect(ViewerReviewSchema.safeParse(s).success).toBe(false);
  });
});

describe("checkViewerReview (deterministic post-check)", () => {
  it("drops judgments whose evidence lies outside the video, clamps and sorts the rest", () => {
    const r = sampleViewerReview();
    r.beats.push({ ...r.beats[0]!, tStart: 40, tEnd: 44, evidence: [{ t: 41, kind: "SEEN", detail: "a frame that doesn't exist" }] });
    r.beats.reverse();
    r.beats[0] = { ...r.beats[0]!, tStart: 19.5, tEnd: 21 };
    const { review, warnings } = checkViewerReview(r, { durationS: 20 });
    expect(review.beats.every((b) => b.tEnd <= 20 && b.tStart <= b.tEnd)).toBe(true);
    expect(review.beats.map((b) => b.tStart)).toEqual([...review.beats.map((b) => b.tStart)].sort((a, b) => a - b));
    expect(review.beats.some((b) => b.tStart === 40)).toBe(false);
    expect(warnings.join(" ")).toContain("Dropped a beat");
  });

  it("orders fixes by priority and flags certainty language", () => {
    const r = sampleViewerReview();
    r.fixes.reverse();
    r.verdict.headline = "This will go viral for sure.";
    const { review, warnings } = checkViewerReview(r, { durationS: 20 });
    expect(review.fixes.map((f) => f.priority)).toEqual([1, 2, 3]);
    expect(warnings.some((w) => /estimate/.test(w))).toBe(true);
    expect(CERTAINTY_RE.test("will get 1M views")).toBe(true);
    expect(CERTAINTY_RE.test("likely keeps more viewers")).toBe(false);
  });

  it("notes thin coverage of the video", () => {
    const r = sampleViewerReview();
    r.beats = [r.beats[0]!];
    expect(checkViewerReview(r, { durationS: 20 }).warnings.join(" ")).toContain("covers only");
  });
});

describe("planViewerFrames (input builder)", () => {
  it("samples the hook densely, both sides of every cut, graphic changes and ~1 fps", () => {
    const plan = planViewerFrames({ durationS: 20, cutTimes: [3.1, 14.1], eventTimes: [12.3] });
    const at = (reason: string) => plan.filter((p) => p.reason === reason).map((p) => p.t);
    expect(plan[0]).toEqual({ t: 0, reason: "FIRST" });
    expect(at("HOOK")).toEqual(expect.arrayContaining([0.5, 1, 1.5, 2, 2.5]));
    // 3.0 s is also an opening frame: one frame sits there, labelled as the cut's side (more useful).
    expect(plan.filter((p) => p.t === 3)).toHaveLength(1);
    expect(at("BEFORE_CUT")).toEqual([3, 14]);
    expect(at("AFTER_CUT")).toEqual([3.2, 14.2]);
    expect(at("EVENT")).toEqual([12.6]);
    expect(plan.at(-1)).toEqual({ t: 19.95, reason: "LAST" });
    expect(at("SAMPLE").length).toBeGreaterThan(10);
    // Strictly increasing and never closer than the dedupe window.
    for (let i = 1; i < plan.length; i++) expect(plan[i]!.t - plan[i - 1]!.t).toBeGreaterThanOrEqual(0.12 - 1e-9);
  });

  it("stays under the frame cap by dropping background samples first, keeping the hook and the cuts", () => {
    const cuts = Array.from({ length: 30 }, (_, i) => 4 + i * 1.9);
    const plan = planViewerFrames({ durationS: 62, cutTimes: cuts }, { maxFrames: 80 });
    expect(plan.length).toBe(80);
    expect(plan.filter((p) => p.reason === "HOOK").length).toBeGreaterThanOrEqual(5);
    expect(plan.filter((p) => p.reason === "AFTER_CUT").length).toBe(30);
    expect(plan.some((p) => p.reason === "LAST")).toBe(true);
    // Remaining samples stay spread out (no gap over 4 s anywhere).
    for (let i = 1; i < plan.length; i++) expect(plan[i]!.t - plan[i - 1]!.t).toBeLessThan(4);
  });

  it("thins cut pairs too when there are more cuts than the cap allows", () => {
    const cuts = Array.from({ length: 120 }, (_, i) => 0.4 + i * 0.5);
    const plan = planViewerFrames({ durationS: 61, cutTimes: cuts }, { maxFrames: 60 });
    expect(plan.length).toBe(60);
    expect(plan.some((p) => p.reason === "FIRST")).toBe(true);
  });

  it("returns nothing for an empty video", () => {
    expect(planViewerFrames({ durationS: 0, cutTimes: [] })).toEqual([]);
  });
});

describe("cost estimate (shown before the call)", () => {
  it("prices frames as w×h/750 image tokens plus text and output at the HIGH model's rate", () => {
    expect(viewerFrameSize(1080, 1920)).toEqual({ width: 360, height: 640 });
    expect(viewerFrameSize(1920, 1080)).toEqual({ width: 640, height: 360 });
    expect(viewerFrameSize(300, 500)).toEqual({ width: 300, height: 500 }); // never upscaled
    expect(imageTokens(360, 640)).toBe(308);
    const e = estimateViewerReviewCost({ frames: 60, frameWidth: 360, frameHeight: 640, wordCount: 150, model: "claude-opus-5-5" });
    // image 60×308 = 18 480; text = 3 200 prompt + (1 200 + ceil(150×1.7)=255) facts + 60×12 labels = 5 375
    expect(e.imageTokens).toBe(18_480);
    expect(e.textTokens).toBe(5_375);
    expect(e.inputTokens).toBe(23_855);
    expect(e.outputTokens).toBe(VIEWER_OUTPUT_TOKENS_ESTIMATE);
    // Opus 5.5: $4 / $20 per MTok → 23 855×4/1e6 + 12 000×20/1e6 = 0.09542 + 0.24
    expect(e.costUsd).toBeCloseTo(0.33542, 5);
    expect(e.lowUsd).toBeLessThan(e.costUsd);
    expect(e.highUsd).toBeGreaterThan(e.costUsd);
    expect(formatEstimateUsd(e.costUsd)).toBe("≈ $0.34");
  });

  it("the page's estimate uses the same frame plan as the job", () => {
    const e = estimateViewerReviewForVideo({ durationS: 20, cutTimes: [3.1, 14.1], eventTimes: [12.3], width: 1080, height: 1920, wordCount: 52 });
    expect(e.frames).toBe(planViewerFrames({ durationS: 20, cutTimes: [3.1, 14.1], eventTimes: [12.3] }).length);
  });
});

describe("facts text", () => {
  it("lists the transcript in timed lines, every cut with its kind, graphics and measured sound", () => {
    const text = formatViewerFacts(facts(), planViewerFrames({ durationS: 20, cutTimes: [3.1, 14.1] }));
    expect(text).toContain("[0.3–");
    expect(text).toContain("3.10 s: jump cut (pause removed) (0.42 s removed, framing 1.00× → 1.12×)");
    expect(text).toContain("14.10 s: framing change only");
    expect(text).toContain("stat card 12.3–15.0 s");
    expect(text).toContain("9.0 dB under the voice (close to the voice");
    expect(text).toContain("Level change across a cut: 3.10 s (+7.2 dB)");
    expect(text).toContain("a cut every 2.4 s");
    expect(text).toContain("cold viewer");
  });

  it("a reference video is never presented as Chris's", () => {
    const text = formatViewerFacts(facts({ subject: "REFERENCE_VIDEO", creatorName: "Alex Hormozi", referenceStyle: null }), []);
    expect(text).toContain("A video by Alex Hormozi (a reference creator — NOT Chris)");
  });

  it("splits transcript lines at pauses and sentence ends", () => {
    const lines = transcriptLines([
      { word: "Hello.", start: 0, end: 0.3 },
      { word: "Then", start: 0.4, end: 0.6 },
      { word: "pause", start: 1.5, end: 1.8 },
    ]);
    expect(lines).toEqual(["[0.0–0.3] Hello.", "[0.4–0.6] Then", "[1.5–1.8] pause"]);
  });
});

describe("runViewerPanelAgent", () => {
  it("makes ONE HIGH-class vision call with labelled JPEG frames and returns the checked review", async () => {
    const provider = new MockModelProvider(() => sampleViewerReview());
    const frames = [frame(0, "FIRST"), frame(3, "BEFORE_CUT"), frame(3.2, "AFTER_CUT")];
    const out = await runViewerPanelAgent(provider, { facts: facts(), frames, brandContext: "## Brand\nDirect, skeptical." });
    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0]!;
    expect(call.modelClass).toBe("HIGH");
    expect(call.promptId).toBe("VIEWER_PANEL");
    expect(call.images?.map((i) => i.label)).toEqual(["t=0.00s — first frame", "t=3.00s — just before a cut", "t=3.20s — just after a cut"]);
    expect(call.images?.every((i) => i.mediaType === "image/jpeg")).toBe(true);
    expect(call.systemPrompt).toContain("Evidence or it didn't happen");
    expect(call.userPrompt).toContain("Direct, skeptical.");
    expect(out.review.verdict.tier).toBe("GOOD");
    expect(out.warnings).toEqual([]);
  });

  it("leaves brand context out for a reference video", async () => {
    const provider = new MockModelProvider(() => sampleViewerReview());
    await runViewerPanelAgent(provider, { facts: facts({ subject: "REFERENCE_VIDEO", creatorName: "Someone" }), frames: [frame(0, "FIRST")] });
    expect(provider.calls[0]!.userPrompt).not.toContain("The creator's brand");
  });

  it("refuses with no frames, and a malformed model answer fails the schema (nothing half-stored)", async () => {
    await expect(runViewerPanelAgent(new MockModelProvider(() => sampleViewerReview()), { facts: facts(), frames: [] })).rejects.toThrow(/at least one frame/);
    const bad = new MockModelProvider(() => ({ verdict: { tier: "AMAZING" } }));
    await expect(runViewerPanelAgent(bad, { facts: facts(), frames: [frame(0, "FIRST")] })).rejects.toBeInstanceOf(z.ZodError);
  });

  it("the spend cap fails CLOSED before the vision call is sent", async () => {
    let calls = 0;
    const delegate: ModelProvider = {
      completeStructured: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    };
    const brokenPrisma = {
      modelCallLog: { findMany: async () => { throw new Error("db down"); } },
      auditLog: { create: async () => ({}) },
    } as unknown as typeof prisma;
    await expect(runViewerPanelAgent(new CostTrackingModelProvider(delegate, brokenPrisma), { facts: facts(), frames: [frame(0, "FIRST")] })).rejects.toBeInstanceOf(SpendCapCheckFailedError);
    // Cap of $0: refused before sending, zero tokens.
    await expect(runViewerPanelAgent(new CostTrackingModelProvider(delegate, prisma, { dailyCapUsd: 0 }), { facts: facts(), frames: [frame(0, "FIRST")] })).rejects.toBeInstanceOf(SpendCapExceededError);
    expect(calls).toBe(0);
  });
});

describe("Anthropic provider request shape (no network)", () => {
  it("sends each frame as a base64 image block after its label, the prompt last, HIGH → Opus at effort high", async () => {
    const provider = new AnthropicModelProvider("test-key-not-used");
    let params: Record<string, unknown> | null = null;
    const fakeClient = {
      beta: {
        messages: {
          stream: (p: Record<string, unknown>) => {
            params = p;
            return {
              finalMessage: async () => ({
                model: "claude-opus-5-5",
                stop_reason: "end_turn",
                stop_details: null,
                content: [{ type: "text", text: JSON.stringify(sampleViewerReview()) }],
                usage: { input_tokens: 23_000, output_tokens: 9_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
              }),
            };
          },
        },
      },
    };
    (provider as unknown as { client: unknown }).client = fakeClient;
    const out = await runViewerPanelAgent(provider, { facts: facts(), frames: [frame(0, "FIRST"), frame(3.2, "AFTER_CUT")] });
    expect(out.review.verdict.tier).toBe("GOOD");
    expect(out.usage).toMatchObject({ inputTokens: 23_000, outputTokens: 9_000 });
    const p = params as unknown as { model: string; output_config: { effort: string; format: unknown }; messages: Array<{ content: Array<Record<string, unknown>> }> };
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.output_config.effort).toBe("high");
    expect(p.output_config.format).toBeTruthy();
    const content = p.messages[0]!.content;
    expect(content[0]).toEqual({ type: "text", text: "t=0.00s — first frame" });
    expect(content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZmFrZQ==" } });
    expect(content[2]).toEqual({ type: "text", text: "t=3.20s — just after a cut" });
    expect(content[3]).toMatchObject({ type: "image" });
    expect(content.at(-1)).toMatchObject({ type: "text" });
    expect(String((content.at(-1) as { text: string }).text)).toContain("## Task");
  });
});
