import { describe, it, expect } from "vitest";
import { validateFilm } from "@chris/cinema/pure";
import {
  checkContinuity,
  checkCoverage,
  checkQualityBasics,
  claimKey,
  computeCalc,
  demoFilm,
  DEMO_SCRIPT,
  findNumbers,
  traceNumbers,
  verifyCalculation,
  verifyFilm,
  type StudioFilm,
  type FilmScript,
} from "../studio";

const clone = <T>(x: T): T => structuredClone(x);

describe("studio demo film is real engine DSL", () => {
  it("both drafts pass the REAL cinema validator (validateFilm) — the fixture can't drift from the engine", () => {
    for (const fixed of [false, true]) {
      const r = validateFilm(demoFilm(fixed));
      expect(r.ok, JSON.stringify(!r.ok ? r.errors : [])).toBe(true);
    }
  });
});

describe("Verification — math is a hard gate (deterministic)", () => {
  it("recomputes every op, incl. the proof film's future value ($270/mo, 7%, 20 y = $140,650)", () => {
    expect(computeCalc("FUTURE_VALUE_MONTHLY", [270, 7, 20])).toBeCloseTo(140650.2, 0);
    expect(computeCalc("PERCENT_OF", [35, 10000])).toBe(3500);
    expect(computeCalc("SUBTRACT", [10000, 3500])).toBe(6500);
    expect(computeCalc("MONTHLY_FROM_ANNUAL", [6500])).toBeCloseTo(541.67, 1);
    expect(computeCalc("PERCENT_CHANGE", [100, 150])).toBe(50);
    expect(computeCalc("DIVIDE", [1, 0])).toBeNull();
  });

  it("an exact claim must match; 'about' allows ≤3%; wrong math says what the math gives", () => {
    expect(verifyCalculation({ id: "c", description: "fv", op: "FUTURE_VALUE_MONTHLY", inputs: [270, 7, 20], claimed: 140650, approximate: false, resultNumberId: null }).ok).toBe(true);
    const wrong = verifyCalculation({ id: "c", description: "after tax", op: "SUBTRACT", inputs: [10000, 3500], claimed: 7500, approximate: false, resultNumberId: null });
    expect(wrong.ok).toBe(false);
    expect(wrong.detail).toContain("6,500");
    expect(verifyCalculation({ id: "c", description: "half", op: "DIVIDE", inputs: [6500, 24], claimed: 270, approximate: true, resultNumberId: null }).ok).toBe(true);
    expect(verifyCalculation({ id: "c", description: "half", op: "DIVIDE", inputs: [6500, 24], claimed: 270, approximate: false, resultNumberId: null }).ok).toBe(false);
  });

  it("finds digit numbers but not account names", () => {
    expect(findNumbers("Your $10,000 raise, 35% tax, $270/mo, 1.5k").map((n) => n.value)).toEqual([10000, 35, 270, 1500]);
    expect(findNumbers("Max your 401(k) and 401k first")).toEqual([]);
  });

  it("the demo film verifies: all calcs right, every number on screen traced", () => {
    const r = verifyFilm({ script: DEMO_SCRIPT, film: demoFilm(true), requireConfirmations: false });
    expect(r.gate).toEqual({ status: "PASS" });
    expect(r.numbers.every((n) => n.traced)).toBe(true);
    expect(r.claimsToConfirm).toHaveLength(1);
  });

  it("BLOCKs: wrong math, an untraced number on screen, a DERIVED number without a calculation, an unconfirmed fact at render", () => {
    const badMath: FilmScript = { ...DEMO_SCRIPT, calculations: DEMO_SCRIPT.calculations.map((c) => (c.id === "c2" ? { ...c, claimed: 7000 } : c)) };
    expect(verifyFilm({ script: badMath, film: demoFilm(true), requireConfirmations: false }).gate.status).toBe("BLOCK");

    const film = clone(demoFilm(true)) as StudioFilm;
    film.scenes[0]!.shots[1]!.text = [{ text: "$9,999", style: "HERO_NUMBER", at: 0 }];
    const untraced = verifyFilm({ script: DEMO_SCRIPT, film, requireConfirmations: false });
    expect(untraced.gate.status).toBe("BLOCK");
    expect(untraced.gate.status === "BLOCK" && untraced.gate.reasons.join(" ")).toContain("$9,999");

    const noCalc: FilmScript = { ...DEMO_SCRIPT, calculations: DEMO_SCRIPT.calculations.filter((c) => c.id !== "c4") };
    const r3 = verifyFilm({ script: noCalc, film: demoFilm(true), requireConfirmations: false });
    expect(r3.derivedWithoutCalc.join(" ")).toContain("$140,650");

    const atRender = verifyFilm({ script: DEMO_SCRIPT, film: demoFilm(true), requireConfirmations: true });
    expect(atRender.gate.status).toBe("BLOCK");
    const confirmed = verifyFilm({ script: DEMO_SCRIPT, film: demoFilm(true), requireConfirmations: true, confirmedClaims: [claimKey("l2", "Taxes take 35%.")] });
    expect(confirmed.gate.status).toBe("PASS");
    const factBlock = verifyFilm({ script: DEMO_SCRIPT, film: demoFilm(true), requireConfirmations: false, factCheck: { result: "BLOCK", blockReason: "35% overstated", requiredEdits: [] } });
    expect(factBlock.gate.status).toBe("BLOCK");
  });

  it("traceNumbers reads LABEL values after the | and footnotes", () => {
    const t = traceNumbers(DEMO_SCRIPT, demoFilm(true));
    expect(t.find((x) => x.where.startsWith("rent.text"))?.value).toBe(300);
    expect(t.some((x) => x.where.startsWith("total.text") && x.value === 7)).toBe(true);
  });
});

describe("Coverage — the script is the single source of the words", () => {
  it("flags a missing, an extra and an out-of-order line", () => {
    expect(checkCoverage(DEMO_SCRIPT, demoFilm(true))).toEqual([]);
    const film = clone(demoFilm(true));
    film.scenes[0]!.shots[0]!.line = "Something else entirely.";
    const issues = checkCoverage(DEMO_SCRIPT, film);
    expect(issues.some((i) => i.path === "script.l1")).toBe(true);
    expect(issues.some((i) => i.path === "shots.hook.line")).toBe(true);
    const swapped = clone(demoFilm(true));
    const s = swapped.scenes[0]!.shots;
    [s[1], s[2]] = [s[2]!, s[1]!];
    expect(checkCoverage(DEMO_SCRIPT, swapped).some((i) => i.message.includes("out of script order"))).toBe(true);
  });
});

describe("Continuity — DSL state diff", () => {
  it("the demo film is clean", () => {
    expect(checkContinuity(demoFilm(true)).filter((i) => i.severity === "MAJOR")).toEqual([]);
  });
  it("catches acting while hidden, aiming at nothing, overdrawn coins, a 180° flip and a one-take lighting snap", () => {
    const f = clone(demoFilm(true));
    const shots = f.scenes[0]!.shots;
    shots[1]!.actions = [{ do: "PULSE", actor: "car", at: 0 }];
    shots[2]!.camera.target = "chart";
    shots[3]!.actions = [{ do: "ENTER", actor: "car", at: 0 }, { do: "FLOW", actor: "raise", into: "car", amount: 500, at: 0.5 }];
    shots[4]!.camera = { ...shots[4]!.camera, target: "raise", from: { distance: 10, azimuth: 0, elevation: 10 } };
    shots[3]!.camera = { ...shots[3]!.camera, target: "raise", from: { distance: 10, azimuth: 175, elevation: 10 } };
    shots[3]!.transitionOut = undefined;
    shots[5]!.camera = { ...shots[5]!.camera, from: "CONTINUE" };
    shots[5]!.lighting = { preset: "LOW_DRAMA", blendSeconds: 0 };
    shots[4]!.lighting = { preset: "KEY_RIM" };
    const kinds = checkContinuity(f).map((i) => `${i.kind}@${i.toShot}`);
    expect(kinds).toContain("OBJECT_POPS_IN@taxes");
    expect(kinds).toContain("OBJECT_POPS_IN@rent");
    expect(kinds).toContain("COUNT_MISMATCH@car");
    expect(kinds).toContain("SCREEN_DIRECTION@subs");
    expect(kinds).toContain("LIGHTING_JUMP@didnt");
    expect(checkContinuity(f).every((i) => i.evidence.length > 0 && i.fix.length > 0)).toBe(true);
  });
  it("an actor used after its EXIT is OBJECT_AFTER_EXIT", () => {
    const f = clone(demoFilm(true));
    f.scenes[0]!.shots[3]!.actions!.push({ do: "EXIT", actor: "building", at: 1 });
    f.scenes[0]!.shots[4]!.actions = [{ do: "GLOW", actor: "building", to: 1, at: 0 }];
    expect(checkContinuity(f).some((i) => i.kind === "OBJECT_AFTER_EXIT" && i.toShot === "subs")).toBe(true);
  });
});

describe("Quality basics — deterministic", () => {
  it("text length, collisions, reading time, measured contrast/safe zone/empty frame, loudness", () => {
    const f = clone(demoFilm(true));
    f.scenes[0]!.shots[0]!.text = [
      { text: "$10,000,000,000", style: "HERO_NUMBER", at: 0 },
      { text: "one", style: "KICKER", at: 0, position: "UPPER" },
      { text: "two", style: "KICKER", at: 0.5, position: "UPPER" },
    ];
    const dsl = checkQualityBasics({ film: f, targetSeconds: 40 });
    expect(dsl.some((i) => i.shotId === "hook" && i.kind === "LEGIBILITY" && i.severity === "MAJOR")).toBe(true);
    expect(dsl.some((i) => i.shotId === "hook" && i.kind === "TEXT_COLLISION")).toBe(true);

    const stills = [{ id: "taxes@0.6", shotId: "taxes", point: 0.6, url: "x", metrics: { textContrast: { UPPER: 2.1 }, textInsideSafeZone: 0.7, emptyRatio: 0.9, meanLuma: 0.02 } }];
    const sb = checkQualityBasics({ film: demoFilm(true), stills });
    expect(sb.filter((i) => i.shotId === "taxes").map((i) => `${i.kind}:${i.severity}`).sort()).toEqual(["EMPTY_FRAME:MAJOR", "LEGIBILITY:MAJOR", "LIGHTING:MAJOR", "SAFE_ZONE:MAJOR"]);
    const atRender = checkQualityBasics({ film: demoFilm(true), render: { tier: "FINAL", videoUrl: null, posterUrl: null, durationSeconds: 40, loudnessLufs: -9, truePeakDbtp: 0.2, frames: stills, contactSheetUrl: null } });
    expect(atRender.some((i) => i.kind === "SAFE_ZONE" && i.severity === "BLOCKING")).toBe(true);
    expect(atRender.filter((i) => i.evidence.some((e) => e.ref.startsWith("render."))).length).toBe(2);
  });
});
