import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import {
  buildMotionTasteProfile,
  classifyMotionTopic,
  diffMotionEdits,
  forgetMotionPreference,
  getMotionTasteContext,
  getMotionTasteProfile,
  motionTasteForDesign,
  recordMotionEditSignals,
  STRONG_MIN_SIGNALS,
  type MotionTasteRow,
  type MotionTimelineLike,
  type MotionVisualLike,
} from "../motion-taste";

const vis = (id: string, template: string, start: number, end: number, extra: Partial<MotionVisualLike> = {}): MotionVisualLike => ({
  id,
  template,
  start,
  end,
  props: { value: 1 },
  placement: { mode: "AUTO", x: 0.5, y: 0.3, scale: 1 },
  palette: "BRAND",
  enter: "AUTO",
  exit: "AUTO",
  enterSfx: "WHOOSH",
  depth: "FRONT",
  ...extra,
});

const DAY = 86400000;
const NOW = new Date("2026-10-17T12:00:00Z");
const row = (tag: string, item: string, ctx: Record<string, unknown>, daysAgo = 1): MotionTasteRow => ({
  normalizedTag: tag,
  contentItemId: item,
  context: ctx,
  createdAt: new Date(NOW.getTime() - daysAgo * DAY),
});

describe("classifyMotionTopic", () => {
  it("maps titles to topics deterministically", () => {
    expect(classifyMotionTopic({ title: "How I paid off $18k of credit card debt" }).topic).toBe("DEBT");
    expect(classifyMotionTopic({ title: "Your credit score explained", pillar: "SKILL" }).topic).toBe("CREDIT");
    expect(classifyMotionTopic({ title: "Why index funds beat stock picking" }).topic).toBe("INVESTING");
    expect(classifyMotionTopic({ title: "Compound interest is unfair (in your favor)" }).topic).toBe("INVESTING");
    expect(classifyMotionTopic({ title: "Negotiating my first raise" }).topic).toBe("CAREER");
    expect(classifyMotionTopic({ title: "A Sunday in LA", pillar: "LIFESTYLE" }).topic).toBe("LIFESTYLE");
    expect(classifyMotionTopic({ title: "Stop pretending you understand", pillar: "MINDSET" }).topic).toBe("MINDSET");
    expect(classifyMotionTopic({ title: "Untitled" }).topic).toBe("GENERAL");
  });
  it("does not match 'la' inside other words", () => {
    expect(classifyMotionTopic({ title: "Last salary lesson" }).topic).toBe("CAREER");
  });
});

describe("diffMotionEdits (pure)", () => {
  const before: MotionTimelineLike = {
    visuals: [vis("mv-1", "BAR_CHART", 5.4, 9), vis("mv-2", "NUMBER_COUNTER", 12, 15), vis("mv-3", "ICON_3D", 20, 23), vis("vis-a", "KINETIC_TEXT", 25, 28)],
    sfx: [{ id: "s1", sound: "WHOOSH", at: 2 }],
    motionTheme: { name: "Debt pressure", motionLanguage: "PUNCHY", iconStyle: "GOLD_METAL" },
  };

  it("deleted AI visual -> REJECTED_TEMPLATE with readable raw feedback", () => {
    const after = { ...before, visuals: before.visuals!.filter((v) => v.id !== "mv-1") };
    const s = diffMotionEdits(before, after, { topic: "DEBT" });
    expect(s.map((x) => x.tag)).toEqual(["REJECTED_TEMPLATE"]);
    expect(s[0]!.rawFeedback).toBe("Deleted AI bar chart at 5.4s on a debt video");
    expect(s[0]!.context).toMatchObject({ template: "BAR_CHART", topic: "DEBT", at: 5.4 });
  });

  it("untouched AI visuals count as ACCEPTED only right after an AI design", () => {
    expect(diffMotionEdits(before, before, { topic: "DEBT" })).toEqual([]);
    const s = diffMotionEdits(before, before, { topic: "DEBT", beforeWasAiDesign: true });
    expect(s.map((x) => x.tag)).toEqual(["ACCEPTED_TEMPLATE", "ACCEPTED_TEMPLATE", "ACCEPTED_TEMPLATE"]);
  });

  it("edits: props/placement -> ADJUSTED; trims -> SHORTER; depth -> MORE_BEHIND_HEAD; silenced sfx -> LESS_SOUND", () => {
    const after: MotionTimelineLike = {
      ...before,
      visuals: [
        vis("mv-1", "BAR_CHART", 5.4, 7, { props: { value: 2 }, placement: { mode: "MANUAL", x: 0.3, y: 0.3, scale: 1 } }),
        vis("mv-2", "NUMBER_COUNTER", 12, 15, { depth: "BEHIND_SUBJECT" }),
        vis("mv-3", "ICON_3D", 20, 23, { enterSfx: null }),
        before.visuals![3]!,
      ],
    };
    const tags = diffMotionEdits(before, after, { topic: "DEBT" }).map((x) => x.tag);
    expect(tags).toContain("ADJUSTED_TEMPLATE");
    expect(tags).toContain("SHORTER_ANIMATIONS");
    expect(tags).toContain("MORE_BEHIND_HEAD");
    expect(tags).toContain("LESS_SOUND");
    const adj = diffMotionEdits(before, after, { topic: "DEBT" }).find((x) => x.tag === "ADJUSTED_TEMPLATE" && x.context.visualId === "mv-1")!;
    expect(adj.context.changes).toEqual(["props", "placement", "timing"]);
  });

  it("small timing nudges are not 'shorter animations'", () => {
    const after = { ...before, visuals: before.visuals!.map((v) => (v.id === "mv-1" ? { ...v, end: v.end - 0.2 } : v)) };
    expect(diffMotionEdits(before, after, { topic: "DEBT" }).map((x) => x.tag)).not.toContain("SHORTER_ANIMATIONS");
  });

  it("template swap, manual add, removed sfx, theme override, too busy", () => {
    const after: MotionTimelineLike = {
      visuals: [vis("mv-3", "STAT_CARD", 20, 23), vis("vis-new", "MONEY_STACK_3D", 30, 33)],
      sfx: [],
      motionTheme: { name: "Calm", motionLanguage: "CALM", iconStyle: "GOLD_METAL" },
    };
    const s = diffMotionEdits(before, after, { topic: "DEBT" });
    const tags = s.map((x) => x.tag);
    expect(tags.filter((t) => t === "REJECTED_TEMPLATE")).toHaveLength(2);
    expect(tags).toContain("SWAPPED_TEMPLATE");
    expect(tags).toContain("ADDED_TEMPLATE");
    expect(tags).toContain("TOO_BUSY");
    expect(tags).toContain("PREFERS_THEME");
    expect(s.find((x) => x.tag === "ADDED_TEMPLATE")!.context.threeD).toBe(true);
    expect(s.filter((x) => x.tag === "LESS_SOUND").length).toBeGreaterThanOrEqual(1);
    expect(s.find((x) => x.tag === "PREFERS_THEME")!.rawFeedback).toContain("calm motion");
  });

  it("manual (non-AI) visual deletions are not template rejections", () => {
    const after = { ...before, visuals: before.visuals!.filter((v) => v.id !== "vis-a") };
    expect(diffMotionEdits(before, after, { topic: "DEBT" })).toEqual([]);
  });
});

describe("buildMotionTasteProfile (pure)", () => {
  it("one deletion is WEAK and scoped to its topic — never a universal rule", () => {
    const p = buildMotionTasteProfile([row("REJECTED_TEMPLATE", "a", { template: "BAR_CHART", topic: "DEBT" })], NOW);
    const avoid = p.preferences.find((x) => x.key === "AVOID_TEMPLATE:BAR_CHART")!;
    expect(avoid.strength).toBe("WEAK");
    expect(avoid.scope).toBe("DEBT");
    expect(motionTasteForDesign(p, "DEBT").avoidTemplates).toEqual([]);
    expect(motionTasteForDesign(p, "INVESTING").context).toBeNull();
  });

  it(`STRONG needs >= ${STRONG_MIN_SIGNALS} consistent signals across >= 2 videos`, () => {
    const sameVideo = [1, 2, 3].map((d) => row("REJECTED_TEMPLATE", "a", { template: "BAR_CHART", topic: "DEBT" }, d));
    expect(buildMotionTasteProfile(sameVideo, NOW).preferences[0]!.strength).toBe("WEAK");
    const spread = [row("REJECTED_TEMPLATE", "a", { template: "BAR_CHART", topic: "DEBT" }), row("REJECTED_TEMPLATE", "b", { template: "BAR_CHART", topic: "INVESTING" }), row("REJECTED_TEMPLATE", "c", { template: "BAR_CHART", topic: "CAREER" })];
    const p = buildMotionTasteProfile(spread, NOW);
    const avoid = p.preferences.find((x) => x.key === "AVOID_TEMPLATE:BAR_CHART")!;
    expect(avoid).toMatchObject({ strength: "STRONG", scope: "ALL", evidenceCount: 3, videoCount: 3 });
    expect(motionTasteForDesign(p, "LIFESTYLE").avoidTemplates).toEqual(["BAR_CHART"]);
  });

  it("contradicting evidence (he also adds bar charts) cancels the preference", () => {
    const rows = [
      ...["a", "b", "c"].map((v) => row("REJECTED_TEMPLATE", v, { template: "BAR_CHART", topic: "DEBT" })),
      ...["d", "e"].map((v) => row("ADDED_TEMPLATE", v, { template: "BAR_CHART", topic: "DEBT" })),
    ];
    expect(buildMotionTasteProfile(rows, NOW).preferences.find((x) => x.key === "AVOID_TEMPLATE:BAR_CHART")).toBeUndefined();
  });

  it("recency decay: old evidence loses to recent contradiction", () => {
    const rows = [
      ...["a", "b", "c"].map((v) => row("REJECTED_TEMPLATE", v, { template: "ICON_3D", topic: "DEBT" }, 200)),
      ...["d", "e"].map((v) => row("ACCEPTED_TEMPLATE", v, { template: "ICON_3D", topic: "DEBT" }, 1)),
    ];
    const p = buildMotionTasteProfile(rows, NOW);
    expect(p.preferences.find((x) => x.key === "AVOID_TEMPLATE:ICON_3D")).toBeUndefined();
    expect(p.preferences.find((x) => x.key === "FAVOR_TEMPLATE:ICON_3D")).toBeDefined();
  });

  it("theme preferences are always topic-scoped and FEWER_VISUALS lowers the cap only when strong", () => {
    const rows = [
      row("PREFERS_THEME", "a", { topic: "INVESTING", from: { motionLanguage: "CRISP" }, to: { motionLanguage: "CINEMATIC" } }),
      row("PREFERS_THEME", "b", { topic: "INVESTING", from: { motionLanguage: "CRISP" }, to: { motionLanguage: "CINEMATIC" } }),
      row("PREFERS_THEME", "c", { topic: "INVESTING", from: { motionLanguage: "CALM" }, to: { motionLanguage: "CINEMATIC" } }),
      ...["a", "b", "c"].map((v) => row("TOO_BUSY", v, { topic: "DEBT" })),
    ];
    const p = buildMotionTasteProfile(rows, NOW);
    const theme = p.preferences.find((x) => x.key === "THEME:INVESTING:CINEMATIC")!;
    expect(theme).toMatchObject({ strength: "STRONG", scope: "INVESTING" });
    expect(motionTasteForDesign(p, "INVESTING").context).toContain("Cinematic motion for investing videos");
    expect(motionTasteForDesign(p, "DEBT").context).not.toContain("Cinematic");
    // TOO_BUSY seen only on debt videos -> scoped to debt.
    expect(motionTasteForDesign(p, "DEBT").capDelta).toBe(-1);
    expect(motionTasteForDesign(p, "LIFESTYLE").capDelta).toBe(0);
  });

  it("FORGET discards a key's evidence up to that moment, later evidence counts again", () => {
    const rows = [
      ...["a", "b", "c"].map((v) => row("REJECTED_TEMPLATE", v, { template: "BAR_CHART", topic: "DEBT" }, 5)),
      { ...row("FORGET", "x", { key: "AVOID_TEMPLATE:BAR_CHART" }, 3), contentItemId: null },
    ];
    expect(buildMotionTasteProfile(rows, NOW).preferences.find((x) => x.key === "AVOID_TEMPLATE:BAR_CHART")).toBeUndefined();
    const later = [...rows, row("REJECTED_TEMPLATE", "d", { template: "BAR_CHART", topic: "DEBT" }, 1)];
    expect(buildMotionTasteProfile(later, NOW).preferences.find((x) => x.key === "AVOID_TEMPLATE:BAR_CHART")).toMatchObject({ strength: "WEAK", evidenceCount: 1 });
  });
});

describe("recordMotionEditSignals (persistence)", () => {
  it("writes MOTION_GRAPHIC TasteFeedback with context, idempotent per plan, and feeds the context text", async () => {
    const item = await createContentItem(prisma, { title: "Paying off credit card debt fast" }, { actorId: "test-user" });
    const before: MotionTimelineLike = { visuals: [vis("mv-1", "BAR_CHART", 5.4, 9), vis("mv-2", "NUMBER_COUNTER", 12, 15)] };
    const after: MotionTimelineLike = { visuals: [vis("mv-2", "NUMBER_COUNTER", 12, 15)] };
    const r1 = await recordMotionEditSignals(prisma, { contentItemId: item.id, before, after, actorId: "chris", planId: "plan-1" });
    expect(r1).toMatchObject({ recorded: 1, topic: "DEBT" });
    const again = await recordMotionEditSignals(prisma, { contentItemId: item.id, before, after, actorId: "chris", planId: "plan-1" });
    expect(again.recorded).toBe(0);
    const rows = await prisma.tasteFeedback.findMany({ where: { contentItemId: item.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ artifactType: "MOTION_GRAPHIC", normalizedTag: "REJECTED_TEMPLATE", rawFeedback: "Deleted AI bar chart at 5.4s on a debt video" });
    expect(rows[0]!.context).toMatchObject({ template: "BAR_CHART", planId: "plan-1" });

    const profile = await getMotionTasteProfile(prisma);
    expect(profile.preferences.some((p) => p.key === "AVOID_TEMPLATE:BAR_CHART")).toBe(true);
    expect(await getMotionTasteContext(prisma, { topic: "DEBT" })).toContain("WEAK: Avoid bar charts");

    await forgetMotionPreference(prisma, { key: "AVOID_TEMPLATE:BAR_CHART", actorId: "chris" });
    const after2 = await getMotionTasteProfile(prisma, new Date(Date.now() + 1000));
    expect(after2.preferences.some((p) => p.key === "AVOID_TEMPLATE:BAR_CHART")).toBe(false);
    // Evidence is never deleted.
    expect(await prisma.tasteFeedback.count({ where: { contentItemId: item.id } })).toBe(1);
  });
});
