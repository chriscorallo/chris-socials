import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  prisma,
  createContentItemFromFootage,
  createMediaAsset,
  analyzeMediaAsset,
  createStarterEdit,
  getLatestEditPlan,
  recordViewerReview,
  recordModelCall,
} from "@chris/domain";
import { sampleViewerReview } from "@chris/agents";
import { aiAvailability, attentionStrip, isAiUnavailableError, type ViewerCheckData } from "./viewer-check-view";
import { getViewerCheckForVideo } from "./viewer-check";

// No network in tests: the stale-credit re-check (ai-credit-probe.ts) has its own test.
vi.mock("./ai-credit-probe", () => ({ recheckAiCreditIfStale: async () => "not-needed" }));

// The card is a client component: render it on the server with the router and the server
// action stubbed — enough to check what each state SHOWS (no browser needed).
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("../app/viewer/actions", () => ({ startViewerReview: async () => ({ jobRunId: "job-1" }) }));
const { ViewerCheck } = await import("../app/components/ViewerCheck");

const actor = { actorId: "chris" };
const html = (data: ViewerCheckData, variant: "video" | "reference" = "video") => renderToStaticMarkup(createElement(ViewerCheck, { data, variant }));

function data(over: Partial<ViewerCheckData> = {}): ViewerCheckData {
  return {
    subject: { kind: "RENDER", contentItemId: "item-1" },
    mediaUrl: "/api/media/renders/x.mp4",
    unavailable: null,
    estimate: { label: "≈ $0.34", usd: 0.335, highUsd: 0.48, frames: 46 },
    ai: { state: "ok" },
    defaultPlatform: "INSTAGRAM",
    latest: null,
    activeJobRunId: null,
    ...over,
  };
}

const latest = () => ({
  id: "vr1",
  createdAt: new Date("2026-10-17T12:00:00Z").toISOString(),
  review: sampleViewerReview(),
  warnings: [],
  platform: "INSTAGRAM",
  persona: "COLD",
  model: "claude-opus-5-5",
  costUsd: 0.31,
  estimatedCostUsd: 0.34,
  durationS: 20,
  frames: 46,
  isForCurrentVersion: true,
});

describe("Viewer check card — states", () => {
  it("ready: one tap with the price on the button", () => {
    const h = html(data());
    expect(h).toContain("What a new viewer would think");
    expect(h).toContain("Watch it like a new viewer (≈ $0.34)");
    expect(h).toContain("up to $0.48");
    expect(h).toContain("TikTok");
  });

  it("no render yet: says so, no button", () => {
    const h = html(data({ mediaUrl: null, estimate: null, unavailable: "Once the video is rendered, a new viewer can watch it here." }));
    expect(h).toContain("Once the video is rendered");
    expect(h).not.toContain("data-testid=\"viewer-start\"");
  });

  it("running: progress instead of the button", () => {
    const h = html(data({ activeJobRunId: "job-9" }));
    expect(h).toContain("data-testid=\"viewer-running\"");
    expect(h).toContain("Watching it like a new viewer…");
    expect(h).not.toContain("data-testid=\"viewer-start\"");
  });

  it("out of credit / AI off / daily limit: plain words and a link to More → AI credit, no button", () => {
    for (const ai of [
      { state: "no-credit" as const, message: "The AI is out of credit, so a viewer can't watch it right now." },
      { state: "off" as const, message: "The AI is off — no Anthropic key is set up yet." },
      { state: "cap" as const, message: "Today's AI safety limit is reached — it resets at midnight UTC." },
    ]) {
      const h = html(data({ ai }));
      expect(h).toContain(ai.message.replace(/'/g, "&#x27;"));
      expect(h).toContain('href="/settings/ai"');
      expect(h).not.toContain("data-testid=\"viewer-start\"");
    }
  });

  it("done: verdict, the attention strip (one tappable beat each), drop-offs and top fixes; details fold away", () => {
    const h = html(data({ latest: latest() }));
    expect(h).toContain("data-testid=\"viewer-tier\"");
    expect(h).toContain(">Good<");
    expect(h).toContain("Strong hook and a useful number");
    expect((h.match(/aria-label="[^"]*attention \d+"/g) ?? []).length).toBe(6);
    expect(h).toContain("Where they&#x27;d swipe away");
    expect(h).toContain("Top fixes");
    expect(h).toContain("Cut 8.4–11.8 s");
    expect(h).toContain("Everything the viewer noticed");
    expect(h).toContain("estimates from one viewing, not predictions of views");
    expect(h).toContain("Watch it again (≈ $0.34)");
    expect(h).toContain("cost $0.31");
  });

  it("reference variant: 'What a viewer thinks'", () => {
    const h = html(data({ subject: { kind: "REFERENCE_VIDEO", referenceContentId: "r1" }, latest: latest() }), "reference");
    expect(h).toContain("What a viewer thinks");
    expect(h).toContain("What could be better");
  });
});

describe("view helpers", () => {
  it("AI availability: key, credit, cap — in that order", () => {
    expect(aiAvailability({ keySet: false, creditError: true, todayUsd: 99, capUsd: 1 }).state).toBe("off");
    expect(aiAvailability({ keySet: true, creditError: true, todayUsd: 0, capUsd: 30 }).state).toBe("no-credit");
    expect(aiAvailability({ keySet: true, creditError: false, todayUsd: 30, capUsd: 30 }).state).toBe("cap");
    expect(aiAvailability({ keySet: true, creditError: false, todayUsd: 1, capUsd: 30 }).state).toBe("ok");
  });

  it("recognises a failed job that means the AI can't run", () => {
    expect(isAiUnavailableError("whatever", "SpendCapExceededError")).toBe(true);
    expect(isAiUnavailableError("400 Your credit balance is too low", null)).toBe(true);
    expect(isAiUnavailableError("There's no finished render of this video yet", null)).toBe(false);
  });

  it("strip segments sit on the video's timeline and never overflow it", () => {
    const s = attentionStrip(sampleViewerReview(), 20);
    expect(s).toHaveLength(6);
    expect(s[0]!.leftPct).toBe(0);
    expect(s.every((x) => x.leftPct + x.widthPct <= 100.0001)).toBe(true);
    expect(s.find((x) => x.label.includes("Bored"))!.tone).toBe("bad");
  });
});

describe("getViewerCheckForVideo (server loader)", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  async function item(withRender: boolean) {
    const it = await createContentItemFromFootage(prisma, { title: `Loader ${Date.now()}` }, actor);
    const asset = await createMediaAsset(prisma, { contentItemId: it.id, kind: "RAW_TAKE", storageKey: `raw/${it.id}/t.mp4`, originalFilename: "t.mp4", mimeType: "video/mp4", sizeBytes: 1 }, actor);
    await analyzeMediaAsset(prisma, asset.id, { durationSeconds: 24, width: 1080, height: 1920, frameRate: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }, actor);
    await createStarterEdit(prisma, it.id, actor);
    const plan = (await getLatestEditPlan(prisma, it.id))!;
    const render = withRender
      ? await prisma.render.create({ data: { contentItemId: it.id, editPlanId: plan.id, status: "SUCCESS", storageKey: `renders/${it.id}.mp4`, durationSeconds: 24, width: 1080, height: 1920 } })
      : null;
    return { id: it.id, render };
  }

  it("no render → unavailable, no estimate", async () => {
    const { id } = await item(false);
    const d = await getViewerCheckForVideo(id);
    expect(d.unavailable).toMatch(/rendered/);
    expect(d.estimate).toBeNull();
    expect(d.latest).toBeNull();
  });

  it("a render → the price before running, and the latest review (marked stale once a newer render exists)", async () => {
    const { id, render } = await item(true);
    const d = await getViewerCheckForVideo(id);
    expect(d.mediaUrl).toBe(`/api/media/renders/${id}.mp4`);
    expect(d.estimate!.usd).toBeGreaterThan(0.05);
    expect(d.estimate!.label).toMatch(/^≈ \$0\.\d\d$/);
    expect(d.ai.state).toBe("ok");
    await recordViewerReview(
      prisma,
      {
        subject: { kind: "RENDER", contentItemId: id, renderId: render!.id, editPlanId: render!.editPlanId },
        mediaStorageKey: render!.storageKey!,
        platform: "INSTAGRAM",
        persona: "COLD",
        promptId: "VIEWER_PANEL",
        promptVersion: "1.0.0",
        model: "mock",
        review: sampleViewerReview(),
        warnings: [],
        inputSummary: { durationS: 24, frames: [{ t: 0, reason: "FIRST" }] },
        estimatedCostUsd: 0.3,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        jobRunId: null,
      },
      actor,
    );
    const withReview = await getViewerCheckForVideo(id);
    expect(withReview.latest!.review.verdict.tier).toBe("GOOD");
    expect(withReview.latest!.isForCurrentVersion).toBe(true);
    expect(withReview.latest!.frames).toBe(1);
    await prisma.render.create({ data: { contentItemId: id, editPlanId: render!.editPlanId, status: "SUCCESS", storageKey: `renders/${id}-2.mp4`, durationSeconds: 24, attempt: 2 } });
    expect((await getViewerCheckForVideo(id)).latest!.isForCurrentVersion).toBe(false);
  });

  it("out of credit shows on the card's data (from the last failed AI call)", async () => {
    const { id } = await item(true);
    await recordModelCall(prisma, { promptId: "VIEWER_PANEL", modelClass: "HIGH", model: "claude-opus-5-5", latencyMs: 1, success: false, errorMessage: "400 Your credit balance is too low to access the Anthropic API." });
    const d = await getViewerCheckForVideo(id);
    expect(d.ai.state).toBe("no-credit");
  });
});
