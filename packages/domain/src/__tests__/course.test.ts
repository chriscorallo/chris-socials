import { describe, it, expect } from "vitest";
import type { ContentState } from "@prisma/client";
import { computeCourse, findStuck, dueLabel, type CourseItem } from "../course";
import { buildTodoList, type SetupSignals } from "../todo";
import { defaultPostingPlanData, type PostingPlanData } from "../posting-plan-core";
import { zonedTimeToUtc } from "../tz";

const LA = "America/Los_Angeles";
// Saturday Oct 17 2026, 10:00 PDT.
const NOW = zonedTimeToUtc(2026, 10, 17, 10, 0, LA);
const DAY = 86_400_000;

function plan(overrides: Partial<PostingPlanData> = {}): PostingPlanData {
  return { ...defaultPostingPlanData("2026-01-01", LA), ...overrides };
}

let n = 0;
function item(state: ContentState, extra: Partial<CourseItem> = {}): CourseItem {
  n += 1;
  return {
    id: `i${n}`,
    title: `Video ${n}`,
    state,
    stateSince: new Date(NOW.getTime() - DAY / 2),
    scheduledAt: null,
    targetPlatforms: [],
    publishedAt: null,
    publishedPlatforms: [],
    ...extra,
  };
}

const ALL = ["TIKTOK", "INSTAGRAM", "YOUTUBE"];
const at = (m: number, d: number, h = 18) => zonedTimeToUtc(2026, m, d, h, 0, LA);

describe("computeCourse", () => {
  it("NO_PLAN without a plan, with a setup nudge to create one", () => {
    const r = computeCourse({ plan: null, items: [], failures: [], now: NOW, tz: LA });
    expect(r.status).toBe("NO_PLAN");
    expect(r.nudges.map((x) => x.key)).toContain("setup:posting-plan");
  });

  it("counts planned / filled / published / missed per week and platform", () => {
    // This week (Mon Oct 12 – Sun Oct 18): Mon & Tue published everywhere planned, the rest missed.
    const items = [
      item("PUBLISHED", { publishedAt: at(10, 12), publishedPlatforms: ALL }),
      item("MEASURING", { publishedAt: at(10, 13, 17), publishedPlatforms: ["TIKTOK", "INSTAGRAM"] }),
      // Next week Monday scheduled to all three.
      item("SCHEDULED", { scheduledAt: at(10, 19), targetPlatforms: ALL }),
    ];
    const r = computeCourse({ plan: plan(), items, failures: [], now: NOW, tz: LA });
    const tw = r.weeks[0]!;
    expect(tw.planned).toBe(12);
    expect(tw.published).toBe(5); // Mon TT/IG/YT + Tue TT/IG
    expect(tw.missed).toBe(7);
    expect(tw.open).toBe(0);
    const nw = r.weeks[1]!;
    expect(nw.filled).toBe(3);
    expect(nw.open).toBe(9);
    // 7 missed + next week's open slots have nothing in the pipeline and their pick-an-idea
    // deadline has already passed → at risk, not merely behind.
    expect(r.status).toBe("AT_RISK");
  });

  it("is BEHIND (not at risk) when slots were missed but the pipeline covers what's open", () => {
    const yt1 = plan({ cadences: [{ platform: "YOUTUBE", enabled: true, postsPerWeek: 1, preferredDays: [3], preferredTimes: ["12:00"] }] });
    // This week's Wed slot was missed; next Wed is covered by a READY video.
    const r = computeCourse({ plan: yt1, items: [item("READY")], failures: [], now: NOW, tz: LA });
    expect(r.weeks[0]!.missed).toBe(1);
    expect(r.status).toBe("BEHIND");
  });

  it("is ON_TRACK when every slot is filled", () => {
    const yt1 = plan({ cadences: [{ platform: "YOUTUBE", enabled: true, postsPerWeek: 1, preferredDays: [3], preferredTimes: ["12:00"] }] });
    const items = [
      item("PUBLISHED", { publishedAt: zonedTimeToUtc(2026, 10, 14, 12, 0, LA), publishedPlatforms: ["YOUTUBE"] }),
      item("SCHEDULED", { scheduledAt: zonedTimeToUtc(2026, 10, 21, 12, 0, LA), targetPlatforms: ["YOUTUBE"] }),
    ];
    const r = computeCourse({ plan: yt1, items, failures: [], now: NOW, tz: LA });
    expect(r.status).toBe("ON_TRACK");
    expect(r.headline).toMatch(/^On track/);
  });

  it("suggests READY videos for the soonest open slots as one-tap schedule actions", () => {
    const ready = [item("READY", { title: "Ready A" }), item("READY", { title: "Ready B" })];
    const r = computeCourse({ plan: plan(), items: ready, failures: [], now: NOW, tz: LA });
    expect(r.openSlots[0]!.ymd).toBe("2026-10-19");
    expect(r.openSlots[0]!.suggestion?.title).toBe("Ready A");
    expect(r.openSlots[1]!.suggestion?.title).toBe("Ready B");
    expect(r.openSlots[2]!.suggestion).toBeNull();
    const sched = r.nudges.filter((x) => x.action?.kind === "schedule");
    expect(sched).toHaveLength(2);
    const a = sched[0]!.action!;
    expect(a.kind === "schedule" && a.platforms.sort()).toEqual(["INSTAGRAM", "TIKTOK", "YOUTUBE"]);
  });

  it("works the pipeline backwards from lead times: ready → editing → film → write → ideas", () => {
    const items = [
      item("READY"),
      item("EDITING"),
      item("READY_TO_FILM"),
      item("READY_TO_FILM"),
      item("SCRIPTED"),
    ];
    // 5 open groups next week (Mon–Fri) + 0 left this week (it's Saturday, no Sat/Sun slots).
    const r = computeCourse({ plan: plan(), items, failures: [], now: NOW, tz: LA });
    const p = r.pipeline!;
    expect(p.needed).toBe(5);
    expect(p.supply).toMatchObject({ ready: 1, editing: 1, toFilm: 2, writing: 1, filmed: 0 });
    const byStage = Object.fromEntries(p.steps.map((s) => [s.stage, s]));
    expect(byStage.ready!.count).toBe(1);
    expect(byStage.editing!.count).toBe(1);
    // Editing feeds Tue Oct 20 6pm → ready by Mon Oct 19 6pm (1 day lead).
    expect(byStage.editing!.deadline.toISOString()).toBe(at(10, 19).toISOString());
    // Film feeds Wed Oct 21 → film by Sun Oct 18 (3 days lead).
    expect(byStage.toFilm!.count).toBe(2);
    expect(byStage.toFilm!.deadline.toISOString()).toBe(at(10, 18).toISOString());
    expect(byStage.toFilm!.label).toMatch(/^Film 2 by Sun, Oct 18/);
    expect(byStage.writing!.count).toBe(1);
    expect(byStage.uncovered).toBeUndefined();
    expect(p.summary).toContain("you need 5 videos ready");
  });

  it("flags slots with nothing in the pipeline and marks past deadlines at risk", () => {
    // A Sunday 9am slot tomorrow with a 3-day film lead → film-by already passed.
    const tight = plan({
      cadences: [{ platform: "TIKTOK", enabled: true, postsPerWeek: 1, preferredDays: [0], preferredTimes: ["09:00"] }],
    });
    const r = computeCourse({ plan: tight, items: [item("READY_TO_FILM")], failures: [], now: NOW, tz: LA });
    const film = r.pipeline!.steps.find((s) => s.stage === "toFilm")!;
    expect(film.atRisk).toBe(true);
    expect(r.status).toBe("AT_RISK");
    const uncovered = r.pipeline!.steps.find((s) => s.stage === "uncovered")!;
    expect(uncovered.count).toBe(1); // next Sunday has nothing
  });

  it("doesn't let a missed SCHEDULED post fill its slot", () => {
    const missed = item("SCHEDULED", { scheduledAt: at(10, 16), targetPlatforms: ALL });
    const r = computeCourse({ plan: plan(), items: [missed], failures: [], now: NOW, tz: LA });
    expect(r.weeks[0]!.filled).toBe(0);
    expect(r.stuck.find((s) => s.kind === "MISSED")?.contentItemId).toBe(missed.id);
    expect(r.nudges[0]!.key).toBe(`stuck:MISSED:${missed.id}`);
    expect(r.status).toBe("AT_RISK");
  });

  it("counts a streak of fully-published weeks", () => {
    const yt1 = plan({ cadences: [{ platform: "YOUTUBE", enabled: true, postsPerWeek: 1, preferredDays: [3], preferredTimes: ["12:00"] }] });
    const items = [
      item("PUBLISHED", { publishedAt: zonedTimeToUtc(2026, 10, 7, 12, 30, LA), publishedPlatforms: ["YOUTUBE"] }),
      item("PUBLISHED", { publishedAt: zonedTimeToUtc(2026, 9, 30, 11, 0, LA), publishedPlatforms: ["YOUTUBE"] }),
      // Sep 23 missing → streak stops at 2.
    ];
    const r = computeCourse({ plan: yt1, items, failures: [], now: NOW, tz: LA });
    expect(r.streakWeeks).toBe(2);
  });
});

describe("findStuck", () => {
  it("detects idle filmed footage, stalled edits, blocked gates, stalled publishing, failures", () => {
    const old = new Date(NOW.getTime() - 3 * DAY);
    const items = [
      item("FILMED", { stateSince: old }),
      item("FILMED"), // fresh — not stuck
      item("EDIT_PLANNED", { stateSince: old }),
      item("QC_BLOCKED"),
      item("RESEARCH_BLOCKED"),
      item("PUBLISHING", { stateSince: new Date(NOW.getTime() - 2 * 3_600_000) }),
      item("EDITING", { scheduledAt: new Date(NOW.getTime() + 20 * 3_600_000), targetPlatforms: ["TIKTOK"] }),
    ];
    const s = findStuck(items, [{ contentItemId: "x", title: "X", platform: "TIKTOK", at: NOW, message: "boom" }], NOW, LA);
    expect(s.map((x) => x.kind).sort()).toEqual(
      ["EDIT_STALLED", "FILMED_IDLE", "PUBLISH_FAILED", "PUBLISH_STALLED", "QC_BLOCKED", "RESEARCH_BLOCKED", "RESERVED_NOT_READY"].sort(),
    );
  });
});

describe("dueLabel", () => {
  it("speaks in days relative to the local today", () => {
    expect(dueLabel(at(10, 18), NOW, LA)).toBe("Tomorrow");
    expect(dueLabel(at(10, 17, 19), NOW, LA)).toBe("Today 7pm");
    expect(dueLabel(at(10, 14), NOW, LA)).toBe("3 days overdue");
    expect(dueLabel(null, NOW, LA)).toBeNull();
  });
});

describe("buildTodoList", () => {
  const baseSetup: SetupSignals = {
    connections: [
      { platform: "TIKTOK", connected: false, accountId: null, accountName: null, expiresAt: null, expired: false, hasRefreshToken: false, scopes: [], updatedAt: null },
      { platform: "INSTAGRAM", connected: true, accountId: "a", accountName: null, expiresAt: new Date(NOW.getTime() + 2 * DAY), expired: false, hasRefreshToken: false, scopes: [], updatedAt: null },
      { platform: "YOUTUBE", connected: true, accountId: "b", accountName: null, expiresAt: null, expired: false, hasRefreshToken: true, scopes: [], updatedAt: null },
    ],
    autoPublishEnabled: true,
    lastScheduledPublishRunAt: null,
    anthropicKeyConfigured: false,
    anthropicCreditError: null,
    voiceSamplesEmpty: true,
    upcomingByPlatform: { TIKTOK: 2 },
  };

  it("combines course, needs-you, connections and setup — blocking first — and honors dismissals", () => {
    const course = computeCourse({ plan: plan(), items: [], failures: [], now: NOW, tz: LA });
    const needsYou = [
      { category: "STRATEGY_DECISION" as const, title: "Pick the hero topic", description: "d", href: "/strategy", createdAt: NOW },
      { category: "UNRESOLVED_QC" as const, title: "dup of course", description: "d", href: "/content/x", createdAt: NOW },
    ];
    const t = buildTodoList({ course, plan: plan(), needsYou, setup: baseSetup, dismissed: new Set(), now: NOW });
    const keys = t.nudges.map((x) => x.key);
    expect(keys[0]).toBe("setup:connect:TIKTOK"); // posts due + not connected = blocking
    expect(keys).toContain("setup:cron");
    expect(keys).toContain("setup:expiring:INSTAGRAM");
    expect(keys).toContain("setup:anthropic-key");
    expect(keys).toContain("setup:voice-samples");
    expect(keys.some((k) => k.startsWith("needs:STRATEGY_DECISION"))).toBe(true);
    expect(keys.some((k) => k.startsWith("needs:UNRESOLVED_QC"))).toBe(false);

    const d = buildTodoList({ course, plan: plan(), needsYou, setup: baseSetup, dismissed: new Set(["setup:cron"]), now: NOW });
    expect(d.nudges.map((x) => x.key)).not.toContain("setup:cron");
    expect(d.dismissedCount).toBe(1);
  });

  it("prefers the credit-exhausted message over the missing-key one, and skips cron when recent", () => {
    const course = computeCourse({ plan: plan(), items: [], failures: [], now: NOW, tz: LA });
    const t = buildTodoList({
      course,
      plan: plan(),
      needsYou: [],
      setup: { ...baseSetup, anthropicCreditError: { at: NOW, message: "Your credit balance is too low" }, lastScheduledPublishRunAt: new Date(NOW.getTime() - 3_600_000) },
      dismissed: new Set(),
      now: NOW,
    });
    const keys = t.nudges.map((x) => x.key);
    expect(keys).toContain("setup:anthropic-credit");
    expect(keys).not.toContain("setup:anthropic-key");
    expect(keys).not.toContain("setup:cron");
  });
});
