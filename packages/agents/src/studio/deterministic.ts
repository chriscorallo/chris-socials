import { flattenShots, type FlatShot, type StudioAction, type StudioFilm, type StudioShot } from "./film-types";
import type { RenderResult, ShotFacts, Still } from "./engine-port";
import { block, PASS, type HardGate } from "./gates";
import type { CalcOp, ContinuityIssue, FilmEvidence, FilmScript, QualityIssue, ScriptCalculation } from "./schemas";

/**
 * The deterministic crew ($0, automatic, CLAUDE.md: "deterministic code when the check is
 * deterministic"): Verification (math + number tracing — a HARD GATE), Continuity (DSL state
 * diff), Quality basics (DSL + measured stills/render), Coverage (script ↔ shots).
 */

// ---------------------------------------------------------------------------------------------
// Words / numbers

export function normalizeLine(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9$%.,' ]+/g, " ")
    .replace(/[.,]+(\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface FoundNumber {
  raw: string;
  value: number;
  unit: "USD" | "PERCENT" | "PLAIN";
}

/** Digit-written numbers in a string: "$10,000", "35%", "$270/mo", "1.5k", "20". */
export function findNumbers(text: string): FoundNumber[] {
  const out: FoundNumber[] = [];
  const re = /(\$)?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?([kKmM](?![a-z]))?\s?(%)?/g;
  // Account names are not numbers: 401(k), 403b, 529 plan.
  const cleaned = text.replace(/\b40[13]\s?\(?[kb]\)?/gi, " ").replace(/\b529 plans?\b/gi, " ");
  for (const m of cleaned.matchAll(re)) {
    const digits = m[2]!;
    let value = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    if (m[3]) value *= /[kK]/.test(m[3]) ? 1_000 : 1_000_000;
    out.push({ raw: m[0].trim(), value, unit: m[1] ? "USD" : m[4] ? "PERCENT" : "PLAIN" });
  }
  return out;
}

const close = (a: number, b: number, rel = 0.005, abs = 0.5) => Math.abs(a - b) <= Math.max(abs, Math.abs(b) * rel);

// ---------------------------------------------------------------------------------------------
// Verification — math (HARD GATE)

export function computeCalc(op: CalcOp, inputs: number[]): number | null {
  const [a = NaN, b = NaN, c = NaN] = inputs;
  switch (op) {
    case "ADD":
      return inputs.reduce((s, x) => s + x, 0);
    case "SUBTRACT":
      return inputs.slice(1).reduce((s, x) => s - x, a);
    case "MULTIPLY":
      return inputs.reduce((s, x) => s * x, 1);
    case "DIVIDE":
      return b === 0 ? null : a / b;
    case "PERCENT_OF":
      return (a / 100) * b;
    case "MONTHLY_FROM_ANNUAL":
      return a / 12;
    case "ANNUAL_FROM_MONTHLY":
      return a * 12;
    case "FUTURE_VALUE_MONTHLY": {
      // a = monthly contribution, b = annual rate %, c = years; end-of-month deposits, monthly compounding.
      if (!Number.isFinite(c)) return null;
      const r = b / 100 / 12;
      const n = Math.round(c * 12);
      return r === 0 ? a * n : a * ((Math.pow(1 + r, n) - 1) / r);
    }
    case "PERCENT_CHANGE":
      return a === 0 ? null : ((b - a) / a) * 100;
  }
}

export interface MathCheck {
  id: string;
  description: string;
  op: CalcOp;
  inputs: number[];
  claimed: number;
  expected: number | null;
  ok: boolean;
  detail: string;
}

export function verifyCalculation(c: ScriptCalculation): MathCheck {
  const expected = computeCalc(c.op, c.inputs);
  if (expected === null || !Number.isFinite(expected)) {
    return { id: c.id, description: c.description, op: c.op, inputs: c.inputs, claimed: c.claimed, expected: null, ok: false, detail: `Can't compute ${c.op}(${c.inputs.join(", ")}) — missing or invalid inputs.` };
  }
  // "about $140,000" may round; an exact claim must match to the dollar (0.5% for big numbers).
  const ok = c.approximate ? close(c.claimed, expected, 0.03, 1) : close(c.claimed, expected, 0.001, 0.5);
  const fmt = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n * 100) / 100));
  return {
    id: c.id,
    description: c.description,
    op: c.op,
    inputs: c.inputs,
    claimed: c.claimed,
    expected,
    ok,
    detail: ok ? `${c.description}: ${fmt(c.claimed)} ✓ (computed ${fmt(expected)})` : `${c.description}: the film says ${fmt(c.claimed)}, the math gives ${fmt(expected)}${c.approximate ? " (more than 3% off even for 'about')" : ""}.`,
  };
}

export interface NumberTrace {
  where: string;
  shotId: string;
  raw: string;
  value: number;
  traced: boolean;
  to: string | null;
}

/** Every digit-written number said or shown must be declared in the script (numbers / calculation
 * inputs / results) — an untraced number on screen is an unverified claim. */
export function traceNumbers(script: FilmScript, film: StudioFilm): NumberTrace[] {
  const known: Array<{ value: number; id: string }> = [];
  for (const n of script.numbers) known.push({ value: n.value, id: n.id });
  for (const c of script.calculations) {
    c.inputs.forEach((v, i) => known.push({ value: v, id: `${c.id}.input${i + 1}` }));
    known.push({ value: c.claimed, id: `${c.id}.result` });
  }
  const out: NumberTrace[] = [];
  const visit = (text: string, where: string, shotId: string) => {
    for (const f of findNumbers(text)) {
      const hit = known.find((k) => close(k.value, f.value, 0.00001, 0.005) || (f.unit === "PERCENT" && close(k.value, f.value / 100, 0.00001, 0.00005)));
      out.push({ where, shotId, raw: f.raw, value: f.value, traced: !!hit, to: hit?.id ?? null });
    }
  };
  for (const { shot } of flattenShots(film)) {
    if (shot.line) visit(shot.line, `${shot.id}.line`, shot.id);
    (shot.text ?? []).forEach((t, i) => visit(t.text.replace("|", " "), `${shot.id}.text[${i}]`, shot.id));
  }
  return out;
}

export interface VerificationReport {
  math: MathCheck[];
  numbers: NumberTrace[];
  derivedWithoutCalc: string[];
  /** FACT claims Chris must confirm (or that the review pack's fact check must support). */
  claimsToConfirm: Array<{ lineId: string; text: string; sourceNote: string | null; confirmed: boolean }>;
  gate: HardGate;
  summary: string;
}

/** VERIFICATION hard gate. Math wrong or a number on screen nobody can trace → BLOCK. Factual
 * claims (FACT kind) must each be confirmed by Chris (authority 1) before render, and a review-pack
 * fact check that BLOCKs also blocks. Opinion / hypothetical / Chris's experience pass. */
export function verifyFilm(input: {
  script: FilmScript;
  film: StudioFilm;
  confirmedClaims?: string[];
  factCheck?: { result: "PASS" | "PASS_WITH_REQUIRED_EDIT" | "BLOCK"; blockReason: string | null; requiredEdits: string[] } | null;
  /** At storyboard time unconfirmed claims don't block yet (Chris confirms at storyboard review). */
  requireConfirmations: boolean;
}): VerificationReport {
  const math = input.script.calculations.map(verifyCalculation);
  const numbers = traceNumbers(input.script, input.film);
  const produced = new Set(input.script.calculations.map((c) => c.resultNumberId).filter(Boolean));
  const derivedWithoutCalc = input.script.numbers.filter((n) => n.source === "DERIVED" && !produced.has(n.id)).map((n) => `${n.display} (${n.label})`);
  const confirmed = new Set(input.confirmedClaims ?? []);
  const claimsToConfirm = input.script.claims
    .filter((c) => c.kind === "FACT")
    .map((c) => ({ lineId: c.lineId, text: c.text, sourceNote: c.sourceNote, confirmed: confirmed.has(claimKey(c.lineId, c.text)) }));

  const reasons: string[] = [];
  for (const m of math) if (!m.ok) reasons.push(`Math: ${m.detail}`);
  for (const n of numbers) if (!n.traced) reasons.push(`Number "${n.raw}" in ${n.where} isn't in the script's numbers or calculations — it can't be checked.`);
  for (const d of derivedWithoutCalc) reasons.push(`${d} is a calculated number with no calculation behind it.`);
  if (input.factCheck?.result === "BLOCK") reasons.push(`Fact check: ${input.factCheck.blockReason ?? "a claim isn't supported"}`);
  if (input.requireConfirmations) for (const c of claimsToConfirm) if (!c.confirmed) reasons.push(`Chris hasn't confirmed the claim "${c.text}".`);
  const gate = reasons.length ? block(...reasons) : PASS;
  const okMath = math.filter((m) => m.ok).length;
  const summary = reasons.length
    ? `${reasons.length} problem${reasons.length === 1 ? "" : "s"}: ${reasons[0]}`
    : `All ${math.length} calculation${math.length === 1 ? "" : "s"} check out (${okMath}/${math.length}); ${numbers.length} number${numbers.length === 1 ? "" : "s"} on screen all traced${claimsToConfirm.length ? `; ${claimsToConfirm.length} fact${claimsToConfirm.length === 1 ? "" : "s"} for Chris to confirm` : ""}.`;
  return { math, numbers, derivedWithoutCalc, claimsToConfirm, gate, summary };
}

export const claimKey = (lineId: string, text: string) => `${lineId}::${normalizeLine(text)}`;

// ---------------------------------------------------------------------------------------------
// Coverage — script lines ↔ shot lines (the script is the single source of the words)

export function checkCoverage(script: FilmScript, film: StudioFilm): Array<{ path: string; message: string }> {
  const shotLines = flattenShots(film).filter((f) => f.shot.line).map((f) => ({ id: f.shot.id, norm: normalizeLine(f.shot.line!) }));
  const scriptLines = script.lines.map((l) => ({ id: l.id, norm: normalizeLine(l.text) }));
  const issues: Array<{ path: string; message: string }> = [];
  for (const l of scriptLines) if (!shotLines.some((s) => s.norm === l.norm)) issues.push({ path: `script.${l.id}`, message: `Script line ${l.id} ("${l.norm}") isn't spoken in any shot — every script line needs exactly one shot with that exact line.` });
  for (const s of shotLines) if (!scriptLines.some((l) => l.norm === s.norm)) issues.push({ path: `shots.${s.id}.line`, message: `Shot "${s.id}" says a line that isn't in the script ("${s.norm}") — change the shot line or add it to the script.` });
  let last = -1;
  for (const s of shotLines) {
    const idx = scriptLines.findIndex((l) => l.norm === s.norm);
    if (idx >= 0 && idx < last) issues.push({ path: `shots.${s.id}.line`, message: `Shot "${s.id}" is out of script order.` });
    if (idx >= 0) last = idx;
  }
  return issues;
}

export function lineIdForShot(script: FilmScript, shot: StudioShot): string | null {
  if (!shot.line) return null;
  const n = normalizeLine(shot.line);
  return script.lines.find((l) => normalizeLine(l.text) === n)?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Timing estimate (same reading pace as the engine's storyboard estimate: 2.6 words/s)

export const EST_WORDS_PER_SECOND = 2.6;

export function estimateShotSeconds(shot: StudioShot): number {
  if (shot.duration !== undefined) return shot.duration;
  const words = shot.line ? shot.line.trim().split(/\s+/).length : 0;
  return Math.max(0.6, words / EST_WORDS_PER_SECOND) + (shot.hold ?? 0) + (shot.leadIn ?? 0);
}

export function estimateFilmSeconds(film: StudioFilm): number {
  return flattenShots(film).reduce((s, f) => s + estimateShotSeconds(f.shot), 0);
}

// ---------------------------------------------------------------------------------------------
// Continuity — DSL state diff across shots

const ev = (kind: FilmEvidence["kind"], ref: string, detail: string): FilmEvidence => ({ kind, ref, detail });

function refActor(target: unknown): string | null {
  return typeof target === "string" && target !== "target" ? target : null;
}

function numParam(params: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const v = params?.[key];
  return typeof v === "number" ? v : fallback;
}

/** Actor state after every shot — shared by Continuity and the Meaning-Match rules. */
export interface ActorWorldState {
  visible: boolean;
  count: number | null;
  level: number | null;
  everEntered: boolean;
  exited: boolean;
}

export type WorldState = Map<string, ActorWorldState>;

export function initialWorld(film: StudioFilm): WorldState {
  const w: WorldState = new Map();
  for (const a of film.cast) {
    w.set(a.id, {
      visible: a.visible === true,
      count: a.kind === "COIN_STACK" ? numParam(a.params, "count", 40) : null,
      level: a.kind === "BASELINE" ? numParam(a.params, "level", 0.05) : null,
      everEntered: a.visible === true,
      exited: false,
    });
  }
  return w;
}

function cloneWorld(w: WorldState): WorldState {
  return new Map([...w].map(([k, v]) => [k, { ...v }]));
}

/** Applies one shot's actions (in anchor order as written) to a world copy. */
export function applyShot(world: WorldState, shot: StudioShot): WorldState {
  const w = cloneWorld(world);
  for (const a of shot.actions ?? []) {
    const s = w.get(a.actor);
    if (!s) continue;
    if (a.do === "ENTER") {
      s.visible = true;
      s.everEntered = true;
      s.exited = false;
    } else if (a.do === "EXIT") {
      s.visible = false;
      s.exited = true;
    } else if (a.do === "SET" && a.param === "count" && typeof a.to === "number") s.count = a.to;
    else if (a.do === "SET" && a.param === "level" && typeof a.to === "number") s.level = a.to;
    else if (a.do === "FLOW") {
      if (s.count !== null) s.count = Math.max(0, s.count - a.amount);
      const into = w.get(a.into);
      if (into && into.count !== null) into.count += a.amount;
    }
  }
  return w;
}

export function worldBeforeEachShot(film: StudioFilm): Map<string, WorldState> {
  const out = new Map<string, WorldState>();
  let w = initialWorld(film);
  for (const { shot } of flattenShots(film)) {
    out.set(shot.id, w);
    w = applyShot(w, shot);
  }
  return out;
}

function azimuthOf(shot: StudioShot): number | null {
  const f = shot.camera.from;
  return f !== "CONTINUE" && typeof f.azimuth === "number" ? f.azimuth : null;
}

const sameTarget = (a: StudioShot, b: StudioShot) => JSON.stringify(a.camera.target) === JSON.stringify(b.camera.target);

export function checkContinuity(film: StudioFilm): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const flat = flattenShots(film);
  let world = initialWorld(film);
  let prev: FlatShot | null = null;
  for (const f of flat) {
    const shot = f.shot;
    const enteringHere = new Set((shot.actions ?? []).filter((a) => a.do === "ENTER").map((a) => a.actor));
    const visibleAtStart = (id: string) => world.get(id)?.visible === true;
    // Camera / focus / lighting aimed at something that isn't there.
    for (const [label, id] of [
      ["camera target", refActor(shot.camera.target)],
      ["lens focus", refActor(shot.camera.lens.focus)],
    ] as const) {
      if (id && world.has(id) && !visibleAtStart(id) && !enteringHere.has(id)) {
        issues.push({ kind: world.get(id)!.exited ? "OBJECT_AFTER_EXIT" : "OBJECT_POPS_IN", fromShot: prev?.shot.id ?? null, toShot: shot.id, severity: "MAJOR", detail: `The ${label} is "${id}", which isn't on screen in this shot.`, fix: `ENTER "${id}" at the start of "${shot.id}", or aim the camera at something visible.`, evidence: [ev("DSL", `${shot.id}.camera`, `${label} = ${id}; ${id} ${world.get(id)!.exited ? "exited earlier" : "never entered"}`)] });
      }
    }
    // Actions on actors that aren't visible (and aren't entering first).
    let w = cloneWorld(world);
    for (const a of shot.actions ?? []) {
      const s = w.get(a.actor);
      if (!s) continue;
      if (a.do === "ENTER" && s.visible) issues.push({ kind: "OBJECT_POPS_IN", fromShot: prev?.shot.id ?? null, toShot: shot.id, severity: "MINOR", detail: `"${a.actor}" enters again but is already on screen.`, fix: `Drop the ENTER for "${a.actor}" in "${shot.id}" or EXIT it earlier.`, evidence: [ev("DSL", `${shot.id}.actions`, `ENTER ${a.actor} while visible`)] });
      else if (a.do !== "ENTER" && a.do !== "EXIT" && !s.visible) issues.push({ kind: s.exited ? "OBJECT_AFTER_EXIT" : "OBJECT_POPS_IN", fromShot: prev?.shot.id ?? null, toShot: shot.id, severity: "MAJOR", detail: `"${a.actor}" does ${a.do} while it isn't on screen.`, fix: `ENTER "${a.actor}" before its ${a.do} in "${shot.id}".`, evidence: [ev("DSL", `${shot.id}.actions`, `${a.do} on hidden actor ${a.actor}`)] });
      else if (a.do === "EXIT" && !s.visible) issues.push({ kind: "OBJECT_AFTER_EXIT", fromShot: prev?.shot.id ?? null, toShot: shot.id, severity: "MINOR", detail: `"${a.actor}" exits but isn't on screen.`, fix: `Remove the EXIT of "${a.actor}" in "${shot.id}".`, evidence: [ev("DSL", `${shot.id}.actions`, `EXIT hidden ${a.actor}`)] });
      if (a.do === "FLOW" && s.count !== null && a.amount > s.count) issues.push({ kind: "COUNT_MISMATCH", fromShot: prev?.shot.id ?? null, toShot: shot.id, severity: "MAJOR", detail: `"${a.actor}" sends ${a.amount} coins but only has ${s.count} left.`, fix: `Lower the FLOW amount to ≤ ${s.count} or give "${a.actor}" more coins earlier.`, evidence: [ev("DSL", `${shot.id}.actions`, `FLOW ${a.amount} from ${a.actor} (has ${s.count})`)] });
      w = applyShot(w, { ...shot, actions: [a] as StudioAction[] });
    }
    // Screen direction (180° rule) and one-take lighting jumps.
    if (prev && prev.sceneId === f.sceneId && sameTarget(prev.shot, shot) && (prev.shot.transitionOut?.type ?? "CUT") === "CUT") {
      const a0 = azimuthOf(prev.shot);
      const a1 = azimuthOf(shot);
      if (a0 !== null && a1 !== null) {
        const d = Math.abs((((a1 - a0) % 360) + 540) % 360 - 180);
        if (d > 150) issues.push({ kind: "SCREEN_DIRECTION", fromShot: prev.shot.id, toShot: shot.id, severity: "MINOR", detail: `The camera jumps ${Math.round(d)}° around the same subject on a plain cut — left/right flip (180° rule).`, fix: `Keep "${shot.id}" on the same side (azimuth within ±90° of ${a0}°) or use a WHIP/transition.`, evidence: [ev("DSL", `${shot.id}.camera.from.azimuth`, `${a0}° → ${a1}°`)] });
      }
    }
    if (prev && shot.camera.from === "CONTINUE" && shot.lighting && prev.shot.lighting && shot.lighting.preset !== prev.shot.lighting.preset && (shot.lighting.blendSeconds ?? 0.6) === 0) {
      issues.push({ kind: "LIGHTING_JUMP", fromShot: prev.shot.id, toShot: shot.id, severity: "MINOR", detail: `Lighting snaps ${prev.shot.lighting.preset} → ${shot.lighting.preset} inside a one-take move.`, fix: `Give "${shot.id}" lighting.blendSeconds ≥ 0.4.`, evidence: [ev("DSL", `${shot.id}.lighting`, `blendSeconds 0 with camera CONTINUE`)] });
    }
    world = applyShot(world, shot);
    prev = f;
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Quality basics — DSL + measured stills / render

const TEXT_LIMITS: Record<string, number> = { HERO_NUMBER: 12, KICKER: 32, STATEMENT: 48, LABEL: 36, TITLE: 28, STAMP: 16, FOOTNOTE: 120 };

export interface QualityBasicsInput {
  film: StudioFilm;
  stills?: Still[];
  render?: RenderResult | null;
  targetSeconds?: number;
  /** Median shot length of Chris's reference style, if measured (pacing reference, not a rule). */
  referenceMedianShotSeconds?: number | null;
}

export function checkQualityBasics(input: QualityBasicsInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const flat = flattenShots(input.film);
  const q = (shotId: string, kind: QualityIssue["kind"], severity: QualityIssue["severity"], detail: string, fix: string, evidence: FilmEvidence[]) => issues.push({ shotId, kind, severity, detail, fix, evidence });
  for (const { shot } of flat) {
    const texts = shot.text ?? [];
    texts.forEach((t, i) => {
      const limit = TEXT_LIMITS[t.style] ?? 60;
      if (t.text.replace("|", "").length > limit) q(shot.id, "LEGIBILITY", t.style === "HERO_NUMBER" ? "MAJOR" : "MINOR", `${t.style} text is ${t.text.length} characters (≤ ${limit} reads on a phone).`, `Shorten text[${i}] in "${shot.id}" — say the rest in the line.`, [ev("DSL", `${shot.id}.text[${i}]`, t.text)]);
    });
    const bands = new Map<string, number>();
    for (const t of texts) if (t.style !== "FOOTNOTE" && t.until === undefined) bands.set(`${t.position ?? "CENTER"}:${t.style}`, (bands.get(`${t.position ?? "CENTER"}:${t.style}`) ?? 0) + 1);
    for (const [k, n] of bands) if (n > 1) q(shot.id, "TEXT_COLLISION", "MAJOR", `${n} ${k.split(":")[1]} texts share the ${k.split(":")[0]} band with no end time — they'd stack on each other.`, `Give the first one an "until" anchor or move one to another band.`, [ev("DSL", `${shot.id}.text`, k)]);
    const secs = estimateShotSeconds(shot);
    const textWords = texts.filter((t) => t.style !== "FOOTNOTE").reduce((s, t) => s + t.text.split(/\s+/).length, 0);
    if (textWords > 0 && textWords / 3.5 > secs) q(shot.id, "LEGIBILITY", "MINOR", `${textWords} words of on-screen text in a ~${secs.toFixed(1)} s shot — too fast to read.`, `Cut the on-screen words to the number or 2–5 key words.`, [ev("DSL", `${shot.id}.text`, `${textWords} words / ${secs.toFixed(1)} s`)]);
    if (shot.line && secs < 0.8) q(shot.id, "COMPOSITION", "MINOR", `Shot is ~${secs.toFixed(1)} s — barely registers.`, `Merge it with a neighbour or add hold.`, [ev("DSL", shot.id, `${secs.toFixed(1)} s`)]);
    if (secs > 7.5) q(shot.id, "COMPOSITION", "MINOR", `Shot is ~${secs.toFixed(1)} s with one picture — attention sags.`, `Split it into two shots or add a camera move/action mid-way.`, [ev("DSL", shot.id, `${secs.toFixed(1)} s`)]);
  }
  const total = estimateFilmSeconds(input.film);
  const target = input.targetSeconds ?? 45;
  if (total > 75) q("film", "OTHER", "MAJOR", `Film runs ~${Math.round(total)} s — mini-movies land at 30–60 s.`, "Cut lines (the Director decides which).", [ev("CALC", "film", `${Math.round(total)} s at 2.6 words/s`)]);
  else if (Math.abs(total - target) > target * 0.35) q("film", "OTHER", "MINOR", `Film runs ~${Math.round(total)} s vs the ${target} s target.`, total > target ? "Tighten lines." : "Let key beats breathe (hold) or add a beat.", [ev("CALC", "film", `${Math.round(total)} s`)]);
  if (input.referenceMedianShotSeconds && flat.length) {
    const lens = flat.map((f) => estimateShotSeconds(f.shot)).sort((a, b) => a - b);
    const median = lens[Math.floor(lens.length / 2)]!;
    if (median > input.referenceMedianShotSeconds * 1.8) q("film", "OTHER", "MINOR", `Median shot ~${median.toFixed(1)} s vs ${input.referenceMedianShotSeconds.toFixed(1)} s in your reference style — slower pacing.`, "Split long shots.", [ev("MEASURED", "reference-style", `median ${input.referenceMedianShotSeconds.toFixed(1)} s`)]);
  }
  const renderStage = !!input.render;
  for (const s of [...(input.stills ?? []), ...(input.render?.frames ?? [])]) {
    const m = s.metrics;
    if (!m) continue;
    const at = ev("MEASURED", s.id, "");
    for (const [band, c] of Object.entries(m.textContrast ?? {})) if (c !== undefined && c < 4.5) q(s.shotId, "LEGIBILITY", c < 3 ? "MAJOR" : "MINOR", `Text in the ${band} band has contrast ${c.toFixed(1)}:1 (needs ≥ 4.5:1 on a phone).`, "Add a scrim / darker background behind the text or change its color.", [{ ...at, detail: `contrast ${c.toFixed(2)} in ${band}` }]);
    if (m.textInsideSafeZone !== undefined && m.textInsideSafeZone < 1) q(s.shotId, "SAFE_ZONE", renderStage ? "BLOCKING" : "MAJOR", `${Math.round((1 - m.textInsideSafeZone) * 100)}% of the text sits under the platform buttons/caption area.`, "Move the text to the UPPER/CENTER band.", [{ ...at, detail: `inside safe zone ${m.textInsideSafeZone}` }]);
    if (m.emptyRatio !== undefined && m.emptyRatio > 0.85) q(s.shotId, "EMPTY_FRAME", "MAJOR", `${Math.round(m.emptyRatio * 100)}% of the frame is empty black.`, "Reframe closer or bring the subject into frame.", [{ ...at, detail: `emptyRatio ${m.emptyRatio}` }]);
    if (m.minTextHeightPx !== undefined && m.minTextHeightPx < 28) q(s.shotId, "LEGIBILITY", "MINOR", `Smallest text is ${m.minTextHeightPx}px tall — hard to read on a phone.`, "Bigger style or fewer words.", [{ ...at, detail: `${m.minTextHeightPx}px` }]);
    if (m.meanLuma !== undefined && m.meanLuma < 0.035) q(s.shotId, "LIGHTING", "MAJOR", `Frame is nearly black (mean luminance ${(m.meanLuma * 100).toFixed(1)}%).`, "Raise lighting intensity or exposure.", [{ ...at, detail: `meanLuma ${m.meanLuma}` }]);
  }
  if (input.render) {
    const r = input.render;
    const first = "film";
    if (r.loudnessLufs !== null && Math.abs(r.loudnessLufs + 14) > 1) q(first, "OTHER", "MAJOR", `Mix is ${r.loudnessLufs.toFixed(1)} LUFS (target −14 ±1).`, "Re-run the mix.", [ev("MEASURED", "render.loudness", `${r.loudnessLufs} LUFS`)]);
    if (r.truePeakDbtp !== null && r.truePeakDbtp > -1) q(first, "ARTIFACT", "MAJOR", `True peak ${r.truePeakDbtp.toFixed(1)} dBTP (≤ −1 avoids clipping on phones).`, "Re-run the limiter.", [ev("MEASURED", "render.truePeak", `${r.truePeakDbtp} dBTP`)]);
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Shot description (what the PICTURE shows, in words) — used by the Meaning-Match first pass.

export function describeShotPicture(film: StudioFilm, shot: StudioShot, world: WorldState, describe: (catalogId: string) => string | null, facts?: ShotFacts | null): string {
  const actorKind = new Map(film.cast.map((a) => [a.id, a]));
  const parts: string[] = [];
  const kindName = (id: string) => {
    const a = actorKind.get(id);
    if (!a) return id;
    const label = typeof a.params?.label === "string" && a.params.label ? ` "${a.params.label}"` : "";
    return `${describe(`actor:${a.kind}`) ?? a.kind.toLowerCase()}${label}`;
  };
  const visible = [...world].filter(([, s]) => s.visible).map(([id]) => id);
  const entering = (shot.actions ?? []).filter((a) => a.do === "ENTER").map((a) => a.actor);
  const onScreen = [...new Set([...visible, ...entering])].filter((id) => !(facts && facts.actors.find((x) => x.id === id)?.inFrame === false));
  if (onScreen.length) parts.push(`On screen: ${onScreen.map(kindName).join("; ")}.`);
  for (const a of shot.actions ?? []) {
    const s = world.get(a.actor);
    if (a.do === "SET" && a.param === "level" && typeof a.to === "number") parts.push(`${kindName(a.actor)} ${a.to > (s?.level ?? 0) ? "rises up" : "sinks down"} (level ${s?.level ?? "?"} → ${a.to}).`);
    else if (a.do === "SET" && a.param === "count" && typeof a.to === "number") parts.push(`${kindName(a.actor)} ${a.to > (s?.count ?? 0) ? "gains coins, piling up" : "loses coins, draining"} (${s?.count ?? "?"} → ${a.to}).`);
    else if (a.do === "SET" && a.param === "progress") parts.push(`${kindName(a.actor)} grows over time.`);
    else if (a.do === "FLOW") parts.push(`Coins flow out of ${kindName(a.actor)} into ${kindName(a.into)} (${a.amount} coins taken).`);
    else if (a.do === "EXIT") parts.push(`${kindName(a.actor)} disappears (${a.style ?? "fade"}).`);
    else if (a.do === "ENTER") parts.push(`${kindName(a.actor)} appears (${a.style ?? "fade"}).`);
    else if (a.do === "SCALE") parts.push(`${kindName(a.actor)} changes size.`);
    else if (a.do === "GLOW" || a.do === "PULSE") parts.push(`${kindName(a.actor)} lights up for emphasis.`);
    else if (a.do === "MOVE") parts.push(`${kindName(a.actor)} moves.`);
  }
  const cam = describe(`camera:${shot.camera.rig}`);
  const tgt = refActor(shot.camera.target);
  parts.push(`Camera: ${cam ?? shot.camera.rig.toLowerCase()}${tgt ? ` on ${kindName(tgt)}` : ""}.`);
  if (shot.lighting) parts.push(`Light: ${describe(`lighting:${shot.lighting.preset}`) ?? shot.lighting.preset.toLowerCase()}.`);
  const lineNorm = shot.line ? normalizeLine(shot.line) : "";
  // Text that merely repeats the line is NOT picture — it would make any shot "match" its line.
  const extraText = (shot.text ?? []).filter((t) => normalizeLine(t.text.replace("|", " ")) !== lineNorm && t.style !== "FOOTNOTE");
  if (extraText.length) parts.push(`Text: ${extraText.map((t) => `"${t.text.replace("|", " ")}"`).join(", ")}.`);
  return parts.join(" ");
}
