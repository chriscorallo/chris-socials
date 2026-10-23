import { describe, it, expect } from "vitest";
import { EditTimelineSchema, type EditTimeline } from "../timeline";
import { applyScreenPlan, auditScreen, captionWindowFor, chooseCoverFrame, planScreen, planZooms, resolveScreenAnchors, sampleSubject, type ScreenBeat } from "../screen";
import { timelineCaptionChunks } from "../timeline-captions";
import type { SubjectTrack } from "../subject-track-core";

const measure = (t: string, _f: string, px: number) => t.length * px * 0.56;

const tl = (extra: Partial<EditTimeline> = {}): EditTimeline =>
  EditTimelineSchema.parse({
    version: 2,
    clips: [{ id: "c1", mediaAssetId: "take", sourceStart: 0, sourceEnd: 40 }],
    captions: { fontId: "inter-display-extrabold", fontSize: 64, color: "#FFFFFF", highlightColor: "#FFD84D", y: 0.72 },
    ...extra,
  });

/** A steady protected-head box (source fractions): wide framing, head in the upper middle. */
const wideTrack = (y = 0.28, h = 0.3, w = 0.4): SubjectTrack => Array.from({ length: 41 }, (_, i) => ({ t: i, box: { x: 0.5 - w / 2, y, w, h } }));

const words = (text: string, from: number, step = 0.3) => text.split(" ").map((w, i) => ({ word: w, start: +(from + i * step).toFixed(3), end: +(from + i * step + step * 0.8).toFixed(3) }));

function beats(): ScreenBeat[] {
  const b = (index: number, role: string, headline: string | null, viewerNeeds: string | null, text: string, from: number, emphasis: string[] = [], hasAmount = false, step = 0.3): ScreenBeat => {
    const ws = words(text, from, step);
    return { index, role, headline, viewerNeeds, sentenceIds: [index], start: ws[0]!.start, end: ws[ws.length - 1]!.end, words: ws, emphasis, hasAmount };
  };
  return [
    b(0, "HOOK", "SAME SALARY", null, "Two people both make a hundred grand a year.", 0.2),
    b(1, "SETUP", "THE SPENDER", "a receipt building line by line", "One rents a five thousand dollar apartment and leases a car and travels a lot every month.", 3.5, [], true),
    b(2, "TENSION", "NEVER AHEAD", null, "He is never ahead and it never changes.", 9.5, ["never"]),
    b(3, "PAYOFF", "$733 vs $4,133", null, "One keeps seven hundred the other keeps four thousand one hundred.", 13),
    // the ask is said slowly, as he does
    b(4, "ENDING", "WHICH ONE ARE YOU?", null, "Which one are you?", 18.5, [], false, 0.5),
  ];
}

describe("screen — anchors from the subject track", () => {
  it("a wide framing gives a top zone above the head, captions at the chest, one anchor for title and headlines", () => {
    const a = resolveScreenAnchors({ timeline: tl(), mediaAssetId: "take", subjectTrack: wideTrack(), sourceSize: { width: 1080, height: 1920 }, measure, headlines: ["WHICH ONE ARE YOU?"], title: "Both making $100K", hookEnd: 3 });
    expect(a.headline?.zone).toBe("TOP");
    expect(a.title?.zone).toBe("TOP");
    expect(a.headline!.y).toBeLessThan(0.28); // above the head's top
    expect(a.caption.zone).toBe("CHEST");
    expect(a.caption.y).toBeGreaterThanOrEqual(0.72);
    expect(a.notes).toEqual([]);
  });
  it("a tight framing (the head fills the top zone) still finds the band over the hair, never the face, and says so", () => {
    const a = resolveScreenAnchors({ timeline: tl(), mediaAssetId: "take", subjectTrack: wideTrack(0.14, 0.5, 0.55), sourceSize: { width: 1080, height: 1920 }, measure, headlines: ["WHICH ONE ARE YOU?"], title: "Both making $100K" });
    expect(a.headline?.zone).toBe("TOP");
    expect(a.notes.some((n) => /over the hair/.test(n))).toBe(true);
    // The headline block's bottom stays above the face box.
    const band = sampleSubject(tl(), "take", wideTrack(0.14, 0.5, 0.55), { width: 1080, height: 1920 });
    expect(a.headline!.y * 1920 + 60).toBeLessThan(band.limits!.faceTop);
  });
  it("without a subject track the anchors assume a centred framing and say so", () => {
    const a = resolveScreenAnchors({ timeline: tl(), mediaAssetId: "take", subjectTrack: null, measure, headlines: ["X"], title: null });
    expect(a.tracked).toBe(false);
    expect(a.notes[0]).toMatch(/no subject track/);
  });
});

describe("screen — the plan", () => {
  const input = { timeline: tl(), mediaAssetId: "take", subjectTrack: wideTrack(), sourceSize: { width: 1080, height: 1920 }, measure, beats: beats(), title: "Both making $100K", hookEnd: 3.3, pacing: "LONG_SHOTS_ZOOMS" as const, style: { headlines: "ALL" as const, captionLook: "QUIET" as const, titleMaxS: 10 } };

  it("by default the screen is Chris's old one: the hook title for ~2 s, his captions untouched, no beat headlines (2026-10-23)", () => {
    const p = planScreen({ ...input, style: {} });
    expect(p.headlines).toEqual([]);
    expect(p.title!.end).toBeLessThanOrEqual(2.4);
    const t = applyScreenPlan(tl(), p);
    expect(t.texts.map((x) => x.id)).toEqual(["fe-hook-title"]);
    expect(t.texts[0]!.uppercase).toBe(false);
    expect(t.captions).toEqual(tl().captions);
  });

  it("headlines arrive on the first word of their idea and leave after the last; exits never overlap entrances", () => {
    const p = planScreen(input);
    expect(p.title).toMatchObject({ id: "fe-hook-title", start: 0 });
    expect(p.headlines.map((h) => h.text)).toEqual(["THE SPENDER", "NEVER AHEAD", "$733 vs $4,133", "WHICH ONE ARE YOU?"]);
    const b = beats();
    expect(p.headlines[0]!.start).toBeCloseTo(b[1]!.words[0]!.start - 0.05, 3);
    expect(p.headlines[0]!.end).toBeLessThanOrEqual(p.headlines[1]!.start - 0.1 + 1e-6);
    expect(p.title!.end).toBeLessThanOrEqual(p.headlines[0]!.start - 0.1 + 1e-6);
  });

  it("one new thing per beat: a graphic slot only where the Editor named a need, after the headline settled; the ending is the face alone", () => {
    const p = planScreen(input);
    expect(p.slots).toHaveLength(1);
    expect(p.slots[0]!.beatIndex).toBe(1);
    expect(p.slots[0]!.start).toBeGreaterThanOrEqual(p.headlines[0]!.start + 0.6 - 1e-6);
    expect(p.faceBeats).toEqual([4]);
    const leadsOf = (i: number) => p.leads.filter((l) => l.beatIndex === i).map((l) => l.lead);
    expect(leadsOf(1)).toEqual(["HEADLINE", "GRAPHIC"]);
    expect(leadsOf(4)).toEqual(["HEADLINE"]);
    // strict mode: the headline is the lead, the graphic waits for another beat
    const strict = planScreen({ ...input, style: { ...input.style, stacking: "NONE" } });
    expect(strict.slots).toHaveLength(0);
  });

  it("captions adapt per beat: phrases where amounts are spoken, one word for a short emotional line, two otherwise", () => {
    const b = beats();
    expect(captionWindowFor(b[1]!)).toBe(3);
    expect(captionWindowFor(b[4]!)).toBe(1);
    expect(captionWindowFor(b[2]!)).toBe(2);
    const p = planScreen(input);
    expect(p.captions.preset).toBe("QUIET");
    expect(p.captions.fontSize).toBeLessThan(p.anchors.headline!.fontSize);
    const t = applyScreenPlan(tl(), p);
    const chunks = timelineCaptionChunks(t, { take: b.flatMap((x) => x.words) });
    const ending = chunks.filter((c) => c.start >= 18.4);
    expect(ending.every((c) => c.words.length === 1)).toBe(true);
    const spender = chunks.filter((c) => c.start >= 3.4 && c.start < 9);
    expect(Math.max(...spender.map((c) => c.words.length))).toBe(3);
  });

  it("zooms: in-hold-out on the emphasis word, never on a graphic's beat, a boundary punch shares the headline's instant; nothing changes for > 5 s → a push-in", () => {
    const p0 = planScreen(input);
    const t0 = applyScreenPlan(tl(), p0);
    // a graphic sits in beat 1's slot
    const withGraphic = EditTimelineSchema.parse({ ...t0, visuals: [{ id: "g1", template: "KINETIC_TEXT", start: p0.slots[0]!.start, end: p0.slots[0]!.end, props: { text: "x" }, placement: { mode: "AUTO", x: 0.5, y: 0.3, scale: 1 } }] });
    const p = planZooms(p0, withGraphic, input);
    const emphasis = p.zooms.find((z) => z.reason === "EMPHASIS");
    expect(emphasis?.word?.toLowerCase()).toBe("never");
    expect(p.zooms.every((z) => !(z.start < p0.slots[0]!.end && p0.slots[0]!.start < z.end))).toBe(true);
    const t = EditTimelineSchema.parse({ ...withGraphic, zooms: applyScreenPlan(withGraphic, p).zooms });
    for (const z of t.zooms) {
      expect(z.mode).toBe("EASE");
      expect(z.easeOutSeconds).toBeGreaterThan(0);
    }
    const audit = auditScreen(t, { mediaAssetId: "take", subjectTrack: wideTrack(), sourceSize: { width: 1080, height: 1920 }, measure, hookExpected: true });
    expect(audit.filter((f) => f.kind === "TWO_LEADS" || f.kind === "ZOOM_DURING_GRAPHIC" || f.kind === "FACE_OVERLAP" || f.kind === "HOOK_TEXT_LATE")).toEqual([]);
    // a long silent stretch on a continuous take gets the cheapest lead
    const long = { ...input, beats: [input.beats[0]!, { ...input.beats[2]!, index: 1, start: 4, end: 16, words: words("he is never ahead and it never changes and nothing moves for a long long time here at all now", 4, 0.55), emphasis: [] }], hookEnd: 3.3 };
    const lp = planZooms(planScreen(long), applyScreenPlan(tl(), planScreen(long)), long);
    expect(lp.zooms.some((z) => z.reason === "STATIC" || z.reason === "BOUNDARY")).toBe(true);
  });

  it("picks a cover frame once the title has settled, in the calmest gap of the hook", () => {
    const b = beats()[0]!;
    const c = chooseCoverFrame(b, 0, 3.3)!;
    expect(c).toBeGreaterThanOrEqual(0.3);
    expect(c).toBeLessThanOrEqual(3.3);
    expect(chooseCoverFrame(null, 0, 3)).toBeNull();
  });
});

describe("screen — the free audit", () => {
  it("the references' headline band is a threshold: too few or too many headlines per 10 s is a finding, inside the band is not", () => {
    const base = tl();
    const text = (id: string, start: number, end: number) => ({ id, text: "X", start, end, preset: "HEADLINE", fontId: "inter-display-extrabold", fontSize: 60, color: "#FFFFFF", backgroundColor: null, strokeColor: null, x: 0.5, y: 0.15, maxWidth: 0.8 });
    const opts = { mediaAssetId: "take", subjectTrack: wideTrack(), sourceSize: { width: 1080, height: 1920 }, measure, hookExpected: false, bands: { headlinesPer10s: { p25: 1, p75: 2 } } };
    // 40 s, one headline → 0.25 per 10 s, under half the p25
    const few = EditTimelineSchema.parse({ ...base, texts: [text("h1", 1, 5)] });
    expect(auditScreen(few, opts).some((f) => f.kind === "HEADLINE_DENSITY")).toBe(true);
    // six headlines → 1.5 per 10 s, inside
    const ok = EditTimelineSchema.parse({ ...base, texts: [0, 1, 2, 3, 4, 5].map((i) => text(`h${i}`, 1 + i * 6, 4 + i * 6)) });
    expect(auditScreen(ok, opts).some((f) => f.kind === "HEADLINE_DENSITY")).toBe(false);
    expect(auditScreen(few, { ...opts, bands: null }).some((f) => f.kind === "HEADLINE_DENSITY")).toBe(false);
  });

  it("catches a text on the face, two leads in a beat, a late hook text, a dead stretch and loud captions", () => {
    const t = EditTimelineSchema.parse({
      ...tl(),
      texts: [
        { id: "late", text: "HELLO", start: 2.5, end: 6, preset: "HEADLINE", fontId: "inter-display-extrabold", fontSize: 60, color: "#FFFFFF", backgroundColor: null, strokeColor: null, x: 0.5, y: 0.4, maxWidth: 0.8 },
      ],
      zooms: [{ id: "z", start: 2.8, end: 5, zoom: 1.1, x: 0.5, y: 0.4, mode: "EASE", easeSeconds: 0.4 }],
      visuals: [{ id: "g", template: "KINETIC_TEXT", start: 3, end: 4, props: { text: "x" }, placement: { mode: "AUTO", x: 0.5, y: 0.3, scale: 1 } }],
      captions: { fontId: "inter-display-extrabold", fontSize: 72, color: "#FFFFFF", highlightColor: "#FFD84D", y: 0.72 },
    });
    const kinds = auditScreen(t, { mediaAssetId: "take", subjectTrack: wideTrack(), sourceSize: { width: 1080, height: 1920 }, measure, hookExpected: true }).map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(["FACE_OVERLAP", "TWO_LEADS", "HOOK_TEXT_LATE", "STATIC_STRETCH", "CAPTION_LOUDER", "ZOOM_DURING_GRAPHIC"]));
  });
});
