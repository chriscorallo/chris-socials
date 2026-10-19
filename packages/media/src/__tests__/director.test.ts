import { describe, it, expect } from "vitest";
import {
  applyDirectorAnswer,
  buildDirectorPack,
  contactSheetPlan,
  cutRange,
  detectEvents,
  directorOwnedVisualIds,
  directorPropsHash,
  extractDirectorJson,
  faceFromHead,
  obstaclesForWindow,
  parseDirectorAnswer,
  parseTimeString,
  relevantPresets,
  understandingForTimeline,
  type DirectorAnswer,
  type DirectorApplyContext,
  type TakeUnderstanding,
} from "../director";
import { EditTimelineSchema, timelineDuration, type EditTimeline } from "../timeline";
import { visualRect, intersectionArea } from "../visual-placement";
import { expandFaceToProtectedRegion, type SubjectTrack } from "../subject-track-core";

// ---------------------------------------------------------------------------------------
// fixtures: a 9 s selfie, face centred in the upper third; neutral → happy (~0.9 s) → neutral (~3.4 s)
// ---------------------------------------------------------------------------------------

const A = "take";
const FACE = { x: 0.335, y: 0.2, w: 0.33, h: 0.2 };
const probs = (e: "neutral" | "happy"): number[] => (e === "happy" ? [0.02, 0.96, 0.01, 0.0, 0.0, 0.0, 0.0, 0.01] : [0.95, 0.02, 0.01, 0.0, 0.01, 0.0, 0.0, 0.01]);

function understanding(): TakeUnderstanding {
  const samples = [];
  for (let i = 0; i < 36; i++) {
    const t = i * 0.25;
    const e = t >= 1 && t < 3.5 ? "happy" : "neutral";
    samples.push({ t, face: FACE, probs: probs(e), motion: i === 4 || i === 14 ? 0.4 : 0.03 });
  }
  return {
    version: 1,
    mediaAssetId: A,
    durationS: 9,
    stepS: 0.25,
    source: { width: 1080, height: 1920 },
    model: { id: "test", license: "MIT", source: "test" },
    samples,
    sprite: { key: "understanding/x/take.jpg", cols: 10, rows: 2, cellW: 180, cellH: 320, stepS: 0.5, count: 18 },
  };
}

const track: SubjectTrack = Array.from({ length: 28 }, (_, i) => ({ t: i / 3, box: expandFaceToProtectedRegion(FACE) }));

function timeline(extra: Partial<EditTimeline> = {}): EditTimeline {
  return EditTimelineSchema.parse({
    version: 2,
    clips: [{ id: "c1", mediaAssetId: A, sourceStart: 0, sourceEnd: 9 }],
    captions: { enabled: false, fontId: "inter-display-bold", fontSize: 64, color: "#FFFFFF", highlightColor: "#FFD54A" },
    ...extra,
  });
}

function ctx(over: Partial<DirectorApplyContext> = {}): DirectorApplyContext {
  return {
    placement: { subjectTracks: { [A]: track }, sourceDimensions: { [A]: { width: 1080, height: 1920 } }, wordsByAsset: { [A]: [] } },
    understanding: { [A]: understanding() },
    record: null,
    messageId: "m1",
    chrisText: "the check hits and I'm happy, then rent, car payment and utilities appear on the other side",
    ...over,
  };
}

function answer(ops: unknown[]): DirectorAnswer {
  const r = parseDirectorAnswer(JSON.stringify({ reply: "ok", operations: ops }));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.answer;
}

const PAYCHECK = {
  op: "addGraphic",
  ref: "paycheck",
  presetId: "pay-received-500",
  start: { expression: "happy" },
  end: { expression: "neutral" },
  placement: "LEFT",
  props: { title: "Paycheck", subtitle: "Direct deposit", body: "Oct 31", items: [{ text: "Amount", value: 2400 }] },
  sfx: "CASH",
};

// ---------------------------------------------------------------------------------------

describe("director: parsing what Chris pastes back", () => {
  it("reads a typical ChatGPT reply: prose around a fenced block, smart quotes, comments, trailing commas", () => {
    const text = `Sure! Here's your edit 👇\n\n\`\`\`json\n{\n  “reply”: “Paycheck on the left.”, // short\n  "operations": [\n    {"op": "addText", "ref": "end", "text": "well that was fun", "start": "7.3s", "end": "end",},\n  ],\n}\n\`\`\`\nWant me to tweak anything?`;
    const r = parseDirectorAnswer(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer.reply).toBe("Paycheck on the left.");
    expect(r.answer.operations[0]).toMatchObject({ op: "addText", start: 7.3, end: "end" });
    expect(r.repaired.join(" ")).toMatch(/code block/);
  });

  it("accepts a bare array, op-name spellings, aliases, sounds/sizes/placements in words", () => {
    const r = parseDirectorAnswer(`[{"type":"add_graphic","preset":"notif-banner-received","start":"0:01.5","position":"right side","sfx":"cha-ching","size":"small","label":"x"},{"action":"Delete","id":"dc-old"},{"op":"zoom","ref":"z","start":2,"zoom":"1.2x"}]`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [g, rm, z] = r.answer.operations;
    expect(g).toMatchObject({ op: "addGraphic", presetId: "notif-banner-received", start: 1.5, placement: "RIGHT", sfx: "CASH", size: "S" });
    expect((g as { ref: string }).ref).toMatch(/^item/);
    expect(rm).toMatchObject({ op: "remove", target: "dc-old" });
    expect(z).toMatchObject({ op: "addZoom", amount: 1.2 });
    expect(r.repaired.some((x) => x.includes('unknown field "label"'))).toBe(true);
  });

  it("times: seconds, m:ss, h:mm:ss", () => {
    expect(parseTimeString("3.1s")).toBe(3.1);
    expect(parseTimeString("0:03.5")).toBe(3.5);
    expect(parseTimeString("00:01:02")).toBe(62);
    expect(parseTimeString("soon")).toBeNull();
  });

  it("a misfit answer changes nothing and gets one precise fix-up message", () => {
    const r = parseDirectorAnswer(`{"reply":"x","operations":[{"op":"addGraphic","ref":"a","start":1},{"op":"teleport","target":"a"}]}`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("\n")).toMatch(/operations\[0\] \(addGraphic "a"\) presetId/);
    expect(r.errors.join("\n")).toMatch(/operations\[1\]/);
    expect(r.repairMessage).toMatch(/resend the COMPLETE JSON answer/);
    expect(parseDirectorAnswer("I can't do that, sorry.").ok).toBe(false);
    expect(extractDirectorJson("no json here")).toBeNull();
  });
});

describe("director: what the chat sees (pure)", () => {
  it("detects the smile onset and the face dropping, with confidences", () => {
    const ev = detectEvents(understanding());
    const onset = ev.find((e) => e.kind === "EXPRESSION_ONSET" && e.expression === "happy")!;
    expect(onset.t).toBeGreaterThan(0.7);
    expect(onset.t).toBeLessThan(1.05);
    expect(onset.confidence).toBeGreaterThan(0.8);
    const drop = ev.find((e) => e.kind === "EXPRESSION_CHANGE" && e.expression === "neutral")!;
    expect(drop.t).toBeGreaterThan(3.2);
    expect(drop.t).toBeLessThan(3.6);
    expect(ev.map((e) => e.id)).toEqual(ev.map((_, i) => `e${i + 1}`));
  });

  it("maps a take's understanding onto the CURRENT edit (cuts shift events)", () => {
    const tl = timeline({ clips: [{ id: "c1", mediaAssetId: A, sourceStart: 0.5, sourceEnd: 9, crop: { zoom: 1, panX: 0, panY: 0 }, volume: 1 }] });
    const ou = understandingForTimeline(tl, { [A]: understanding() });
    const onset = ou.events.find((e) => e.kind === "EXPRESSION_ONSET")!;
    expect(onset.t).toBeCloseTo(detectEvents(understanding()).find((e) => e.kind === "EXPRESSION_ONSET")!.t - 0.5, 3);
    expect(understandingForTimeline(tl, {}).missing).toEqual([A]);
  });

  it("plans the frames image for the edit: output times, sprite cells, expression labels", () => {
    const plan = contactSheetPlan(timeline(), { [A]: understanding() });
    expect(plan.cells).toHaveLength(18);
    expect(plan.cells[2]).toMatchObject({ t: 1, spriteIndex: 2, label: "1.0s" });
    expect(plan.cells[3]!.sublabel).toMatch(/^happy/);
  });

  it("ranks the money/phone presets first for Chris's paycheck story", () => {
    const ids = relevantPresets("my check hits, then rent, car payment and utilities, my money disappears").map((p) => p.id);
    expect(ids.slice(0, 10)).toEqual(expect.arrayContaining(["pay-received-500", "notif-stack-payday", "notif-banner-received"]));
  });

  it("builds one self-contained pack: his words, events, current ids, vocabulary, the strict shape", () => {
    const tl = timeline();
    const p = buildDirectorPack({
      chrisMessage: "the check hits when I smile",
      history: [],
      lastApplied: null,
      timeline: tl,
      understanding: { [A]: understanding() },
      wordsByAsset: { [A]: [] },
      placement: ctx().placement,
      record: null,
      sheet: contactSheetPlan(tl, { [A]: understanding() }),
    });
    expect(p.prompt).toContain("the check hits when I smile");
    expect(p.prompt).toMatch(/e1 @ 0\.\d+ s — starts smiling/);
    expect(p.prompt).toContain("No speech");
    expect(p.prompt).toContain("pay-received-500");
    expect(p.prompt).toContain('"op":"addGraphic"');
    expect(p.prompt).toContain("APPROXIMATE");
    expect(p.imageNote).toMatch(/18 frames/);
  });
});

describe("director: applying instructions (deterministic)", () => {
  it("Chris's example: paycheck on his smile (left), bills 2–3 s later on the right, balance drains, ending line", () => {
    const res = applyDirectorAnswer(
      timeline(),
      answer([
        PAYCHECK,
        {
          op: "addGraphic",
          ref: "bills",
          presetId: "notif-stack-payday",
          start: { expression: "happy", offset: 2.4 },
          end: 7.2,
          placement: "RIGHT",
          lines: "Rent payment — -$1,450\nCar payment — -$520\nUtilities — -$240",
        },
        { op: "addGraphic", ref: "balance", presetId: "classic-counter", start: { expression: "neutral" }, end: 7.2, placement: "BOTTOM_LEFT", props: { value: 190, from: 2400, prefix: "$", label: "Balance" } },
        { op: "addText", ref: "ending", text: "well that was a fun 11 seconds", start: 7.3, end: "end", placement: "BOTTOM" },
        { op: "addSfx", ref: "pop", at: 4.5, sound: "SOFT_POP" },
        { op: "addZoom", ref: "drop", start: { expression: "neutral" }, duration: 1, amount: 1.12 },
      ]),
      ctx(),
    );
    if (!res.ok) throw new Error(res.errors.join("; "));
    if (!res.ok) return;
    const onset = detectEvents(understanding())[0]!.t;
    const pay = res.timeline.visuals.find((v) => v.id === "dc-paycheck")!;
    expect(pay.start).toBeCloseTo(onset, 3);
    expect(pay.enterSfx).toBe("CASH");
    expect(pay.placement.mode).toBe("MANUAL");
    const bills = res.timeline.visuals.find((v) => v.id === "dc-bills")!;
    expect(bills.start).toBeCloseTo(onset + 2.4, 3);
    expect((bills.props as { items: Array<{ text: string }> }).items.map((i) => i.text)).toEqual(["Rent payment", "Car payment", "Utilities"]);
    expect(res.timeline.texts[0]).toMatchObject({ text: "well that was a fun 11 seconds", start: 7.3, end: 9 });
    expect(res.timeline.sfx).toHaveLength(1);
    expect(res.timeline.zooms[0]!.zoom).toBe(1.12);
    // change list in plain words
    expect(res.changes.map((c) => c.text).join("\n")).toMatch(/Added: Paycheck \+\$2,400 at 0\.\d s–/);
    expect(res.changes.map((c) => c.text).join("\n")).toMatch(/Rent payment -\$1,450, Car payment -\$520, Utilities -\$240/);
    // side + face avoidance: paycheck left of his face centre, nothing over his face
    const W = 1080;
    expect(pay.placement.x * W).toBeLessThan((FACE.x + FACE.w / 2) * W);
    for (const v of res.timeline.visuals) {
      const obs = obstaclesForWindow(res.timeline, v.id, v.start, v.end, [], { options: ctx().placement });
      expect(intersectionArea(visualRect(v, res.timeline.canvas), obs.face!)).toBe(0);
    }
    // provenance: every number recorded as Chris's (via Director chat), hashed
    expect(res.record.owner.map((o) => o.visualId).sort()).toEqual(["dc-balance", "dc-bills", "dc-paycheck"]);
    expect(res.record.owner.every((o) => o.by === "Chris via Director chat" && o.messageId === "m1")).toBe(true);
    expect(res.record.refs).toMatchObject({ paycheck: "dc-paycheck", bills: "dc-bills", ending: "dc-ending" });
  });

  it("snaps a numeric time next to the smile when the op says it's about the smile", () => {
    const res = applyDirectorAnswer(timeline(), answer([{ ...PAYCHECK, start: 1.3, end: 3, why: "lands when he smiles" }]), ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.timeline.visuals[0]!.start).toBeCloseTo(detectEvents(understanding())[0]!.t, 3);
    expect(res.notes.join(" ")).toMatch(/snapped/);
  });

  it("refuses times past the end, unknown presets, unknown targets and missing expressions — nothing changes", () => {
    const tl = timeline();
    const r1 = applyDirectorAnswer(tl, answer([{ ...PAYCHECK, start: 12 }]), ctx());
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors[0]).toMatch(/after the end of the video/);
    const r2 = applyDirectorAnswer(tl, answer([{ ...PAYCHECK, presetId: "bank-check-hits" }]), ctx());
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors[0]).toMatch(/isn't a graphic in the library — closest/);
    const r3 = applyDirectorAnswer(tl, answer([{ op: "remove", target: "rent" }]), ctx());
    expect(r3.ok).toBe(false);
    const r4 = applyDirectorAnswer(tl, answer([{ ...PAYCHECK, start: { expression: "angry" } }]), ctx());
    expect(r4.ok).toBe(false);
    if (!r4.ok) {
      expect(r4.errors[0]).toMatch(/no "angry" moment/);
      expect(r4.repairMessage).toMatch(/Fix exactly these problems/);
    }
  });

  it("follow-ups are deltas: move by ref re-solves the side, update swaps data, remove deletes", () => {
    const first = applyDirectorAnswer(timeline(), answer([PAYCHECK, { op: "addText", ref: "ending", text: "fun", start: 7, end: "end" }]), ctx());
    if (!first.ok) throw new Error(first.errors.join());
    const second = applyDirectorAnswer(
      first.timeline,
      answer([
        { op: "move", target: "paycheck", placement: "RIGHT", start: 1.2 },
        { op: "update", target: "paycheck", props: { items: [{ text: "Amount", value: 3100 }] }, speed: 1.5 },
        { op: "remove", target: "ending" },
        { op: "note", text: "Want a sound too?" },
      ]),
      ctx({ record: first.record, messageId: "m2" }),
    );
    if (!second.ok) throw new Error(second.errors.join());
    const v = second.timeline.visuals[0]!;
    expect(v.id).toBe("dc-paycheck");
    expect(v.start).toBe(1.2);
    expect(v.placement.x).toBeGreaterThan(0.5);
    expect((v.props as { items: Array<{ value: number }>; animation: { speed: number } }).items[0]!.value).toBe(3100);
    expect((v.props as { animation: { speed: number } }).animation.speed).toBe(1.5);
    expect(second.timeline.texts).toHaveLength(0);
    expect(second.changes.map((c) => c.kind)).toEqual(["MOVED", "CHANGED", "REMOVED", "NOTE"]);
    expect(second.record.owner.find((o) => o.visualId === "dc-paycheck")!.messageId).toBe("m2");
  });

  it("an explicit x/y over his face is moved off it (and says so)", () => {
    const res = applyDirectorAnswer(timeline(), answer([{ ...PAYCHECK, placement: { x: 0.5, y: 0.3 } }]), ctx());
    if (!res.ok) throw new Error(res.errors.join());
    expect(res.notes.join(" ")).toMatch(/covered your face/);
    const v = res.timeline.visuals[0]!;
    const obs = obstaclesForWindow(res.timeline, v.id, v.start, v.end, [], { options: ctx().placement });
    expect(intersectionArea(visualRect(v, res.timeline.canvas), obs.face!)).toBe(0);
  });

  it("cuts and trims run last (times refer to the edit Chris saw) and ripple everything after", () => {
    const res = applyDirectorAnswer(
      timeline(),
      answer([
        { op: "addText", ref: "late", text: "late", start: 6, end: 8 },
        { op: "addSfx", ref: "gone", at: 2.5, sound: "TICK" },
        { op: "cut", start: 2, end: 3 },
        { op: "trim", end: 8.5 },
        { op: "setCaptions", enabled: true, style: "CLEAN" },
      ]),
      ctx(),
    );
    if (!res.ok) throw new Error(res.errors.join());
    expect(timelineDuration(res.timeline)).toBeCloseTo(7.5, 3);
    expect(res.timeline.texts[0]).toMatchObject({ start: 5, end: 7 });
    expect(res.timeline.sfx).toHaveLength(0);
    expect(res.timeline.captions).toMatchObject({ enabled: true, preset: "CLEAN" });
    expect(res.changes.filter((c) => c.kind === "CUT")).toHaveLength(2);
  });

  it("limits: sounds too close together are skipped, zooms capped at 1.6×", () => {
    const res = applyDirectorAnswer(
      timeline(),
      answer([
        { op: "addSfx", ref: "a", at: 4, sound: "TICK" },
        { op: "addSfx", ref: "b", at: 4.1, sound: "TICK" },
        { op: "addZoom", ref: "z", start: 5, amount: 2.4 },
      ]),
      ctx(),
    );
    if (!res.ok) throw new Error(res.errors.join());
    expect(res.timeline.sfx).toHaveLength(1);
    expect(res.changes.some((c) => c.kind === "SKIPPED")).toBe(true);
    expect(res.timeline.zooms[0]!.zoom).toBe(1.6);
  });

  it("cutRange keeps both sides of a clip and drops items only in the cut", () => {
    const { doc, removed } = cutRange(timeline({ texts: [] }), 2, 4, (p) => `${p}-new`);
    expect(doc.clips.map((c) => [c.sourceStart, c.sourceEnd])).toEqual([
      [0, 2],
      [4, 9],
    ]);
    expect(removed).toEqual([]);
  });
});

describe("director: number provenance for the FACTUAL gate", () => {
  it("owns a graphic only while its data is exactly what Chris applied", () => {
    const res = applyDirectorAnswer(timeline(), answer([PAYCHECK]), ctx());
    if (!res.ok) throw new Error(res.errors.join());
    const plan = { director: res.record };
    expect([...directorOwnedVisualIds(plan, res.timeline.visuals)]).toEqual(["dc-paycheck"]);
    const edited = res.timeline.visuals.map((v) => ({ ...v, props: { ...v.props, title: "Paycheck!!" } }));
    expect(directorOwnedVisualIds(plan, edited).size).toBe(0);
    expect(directorPropsHash("GRAPHIC", { a: 1, b: 2 })).toBe(directorPropsHash("GRAPHIC", { b: 2, a: 1 }));
    expect(directorOwnedVisualIds({}, res.timeline.visuals).size).toBe(0);
  });

  it("the face sits inside its protected head region (bottom-anchored inverse)", () => {
    const head = { x: 100, y: 0, width: 850, height: 1150 };
    const f = faceFromHead(head);
    expect(f.x).toBeGreaterThan(head.x);
    expect(f.y + f.height).toBeLessThan(head.y + head.height);
    expect(f.width).toBeCloseTo(850 / 1.7, 3);
  });
});
