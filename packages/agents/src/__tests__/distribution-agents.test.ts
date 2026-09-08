import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { runPlatformPackagingAgent } from "../platform-packaging-agent";
import { runSchedulerAgent, SchedulerInvalidContentItemIdError } from "../scheduler-agent";

describe("Platform Packaging agent (mock provider — zero cost)", () => {
  it("returns a schema-valid package for Instagram and routes to LOW", async () => {
    const provider = new MockModelProvider(() => ({
      caption: "A real caption, not a hashtag wall.",
      title: null,
      hashtags: ["#budgeting"],
      coverFrameSeconds: 1.5,
      metadata: null,
    }));

    const result = await runPlatformPackagingAgent(provider, {
      platform: "INSTAGRAM",
      finalTranscript: "Here's the point, made clearly.",
      brandContext: "",
    });

    expect(result.caption).toContain("real caption");
    expect(provider.calls[0]?.modelClass).toBe("LOW");
    expect(provider.calls[0]?.promptId).toBe("PLATFORM_PACKAGING_INSTAGRAM");
  });

  it("composes SYSTEM_BASE + PLATFORM_PACKAGING_BASE + the platform-specific prompt", async () => {
    const provider = new MockModelProvider(() => ({
      caption: "x",
      title: "A real YouTube title",
      hashtags: [],
      coverFrameSeconds: null,
      metadata: null,
    }));

    await runPlatformPackagingAgent(provider, {
      platform: "YOUTUBE",
      finalTranscript: "transcript",
      brandContext: "",
    });

    const systemPrompt = provider.calls[0]?.systemPrompt ?? "";
    expect(systemPrompt).toContain("YouTube Shorts"); // from PLATFORM_PACKAGING_YOUTUBE.md
    expect(systemPrompt).toContain("You package a completed video"); // from PLATFORM_PACKAGING_BASE.md
  });

  it("produces a distinct title for YouTube but null is valid for Instagram/TikTok", async () => {
    const provider = new MockModelProvider(() => ({
      caption: "x",
      title: "A real title",
      hashtags: [],
      coverFrameSeconds: null,
      metadata: null,
    }));
    const result = await runPlatformPackagingAgent(provider, {
      platform: "YOUTUBE",
      finalTranscript: "t",
      brandContext: "",
    });
    expect(result.title).toBe("A real title");
  });
});

describe("Scheduler agent (mock provider — zero cost)", () => {
  const readyItems = [
    { contentItemId: "item-1", title: "Idea one", pillar: "MINDSET", format: "talking head" },
    { contentItemId: "item-2", title: "Idea two", pillar: "SKILL", format: "screen share" },
  ];

  it("returns a schema-valid proposal referencing only real item ids", async () => {
    const provider = new MockModelProvider(() => ({
      items: [
        {
          contentItemId: "item-1",
          platforms: ["INSTAGRAM", "YOUTUBE"],
          scheduledDate: "2026-09-10T14:00:00.000Z",
          reasoning: "Topic spacing from last week's mindset content.",
        },
      ],
    }));

    const result = await runSchedulerAgent(provider, {
      readyItems,
      history: [],
      quota: [{ platform: "YOUTUBE", note: "0/100 used today" }],
      brandContext: "",
    });

    expect(result.items).toHaveLength(1);
    expect(provider.calls[0]?.promptId).toBe("SCHEDULER");
    expect(provider.calls[0]?.modelClass).toBe("LOW");
  });

  it("rejects a proposal referencing a contentItemId not in the given READY list", async () => {
    const provider = new MockModelProvider(() => ({
      items: [
        {
          contentItemId: "not-a-real-item",
          platforms: ["INSTAGRAM"],
          scheduledDate: "2026-09-10T14:00:00.000Z",
          reasoning: "x",
        },
      ],
    }));

    await expect(
      runSchedulerAgent(provider, { readyItems, history: [], quota: [], brandContext: "" }),
    ).rejects.toBeInstanceOf(SchedulerInvalidContentItemIdError);
  });

  it("refuses to run with zero READY items", async () => {
    const provider = new MockModelProvider(() => ({ items: [] }));
    await expect(
      runSchedulerAgent(provider, { readyItems: [], history: [], quota: [], brandContext: "" }),
    ).rejects.toThrow();
  });
});
