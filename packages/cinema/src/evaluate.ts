import type { Action, Actor, ActorKind, CameraPose, Ease, EXIT_STYLES, ENTER_STYLES, Look, PostSpec, SetSpec, TextBeat, Transition, Vec3 } from "./dsl/schema";
import { clamp01, ease, hashString, lerp, smoothNoise } from "./ease";
import { actorCenterHeight, actorTopHeight, climbLocalPoint, DEFAULT_PARAMS, VERB_TARGETS } from "./kinds";
import { LOOK_DEFS, mixRigs, type LightRig } from "./looks";
import { anchorFrame, resolveAnchor, shotAtFrame, type ResolvedFilm, type ResolvedShot, type TimedWord } from "./timing";

/**
 * The evaluator: (resolved film, frame) → everything the renderer draws. Pure — no three.js,
 * no DOM, no clock, no Math.random. The React/three side only turns this state into pixels, so
 * "same props → same frame" is a property of this function (tested) plus a deterministic GL.
 */

type ParamValue = number | string | boolean | Array<string | number>;

interface Segment<T> {
  start: number; // seconds
  dur: number;
  to: T;
  ease: Ease;
}

interface Presence {
  kind: "ENTER" | "EXIT";
  style: string;
  start: number;
  dur: number;
}

interface Flow {
  into: string;
  start: number;
  dur: number;
  amount: number;
}

interface Pulse {
  start: number;
  dur: number;
  strength: number;
}

interface PoseSeg {
  start: number;
  dur: number;
  to: string;
}

/** A locomotion window (walk / run / climb): limbs cycle at `cadence` cycles per second. */
interface Gait {
  start: number;
  end: number;
  mode: "WALK" | "RUN" | "CLIMB";
  cadence: number;
}

interface CompiledActor {
  actor: Actor;
  poses: PoseSeg[];
  gaits: Gait[];
  base: { position: Vec3; rotation: Vec3; scale: number; params: Record<string, ParamValue>; visible: boolean };
  pos: Segment<Vec3>[];
  rot: Segment<Vec3>[];
  scale: Segment<number>[];
  params: Record<string, Segment<ParamValue>[]>;
  presence: Presence[];
  flows: Flow[];
  pulses: Pulse[];
}

export interface CompiledFilm {
  rf: ResolvedFilm;
  seed: number;
  actors: Map<string, CompiledActor>;
  /** Absolute camera end state per shot (for CONTINUE). */
  cameraEnds: CameraState[];
}

export interface ActorState {
  id: string;
  kind: ActorKind;
  visible: boolean;
  position: Vec3;
  /** Radians. */
  rotation: Vec3;
  scale: number;
  params: Record<string, ParamValue>;
  /** 0..1 entrance progress (1 = fully in) and its style. */
  enter: number;
  enterStyle: (typeof ENTER_STYLES)[number] | null;
  /** 0..1 exit progress (0 = not leaving). */
  exit: number;
  exitStyle: (typeof EXIT_STYLES)[number] | null;
  /** 0..1 emphasis envelope. */
  pulse: number;
  /** Coins in flight out of this actor (seconds since the flow began; source count at its start). */
  flows: Array<{ into: string; progress: number; amount: number; target: Vec3; seconds: number; dur: number; startCount: number }>;
  /** Rate of change of params.count (units/second, measured over the last 0.15 s). */
  countRate: number;
  /** Seconds since film start (for idle motion). */
  time: number;
  /** FIGURE/CROWD pose blend (from -> to, k 0..1). */
  pose: { from: string; to: string; k: number };
  /** Locomotion (walk/run/climb cycle, in cycles) and how much it overrides the pose (0..1). */
  gait: { mode: "WALK" | "RUN" | "CLIMB"; phase: number; weight: number } | null;
  /** Integral of params.speed over time (turns) — WHEEL rotation. */
  phase: number;
}

export interface CameraState {
  position: Vec3;
  lookAt: Vec3;
  /** Vertical field of view, degrees. */
  fov: number;
  focusDistance: number;
  fStop: number;
  /** Roll, radians. */
  roll: number;
}

export interface TextState {
  key: string;
  beat: TextBeat;
  /** 0..1 in, 0..1 out. */
  enter: number;
  exit: number;
  strike: number;
  /** Displayed text (numbers mid-count). */
  display: string;
  /** Seconds since the beat started. */
  age: number;
}

export interface CaptionState {
  words: Array<{ raw: string; active: boolean; spoken: boolean }>;
  enter: number;
  exit: number;
  key: string;
}

export interface FrameState {
  frame: number;
  time: number;
  shotIndex: number;
  shotId: string;
  shotProgress: number;
  sceneIndex: number;
  set: SetSpec;
  look: Look;
  camera: CameraState;
  actors: ActorState[];
  lights: LightRig & { focus: Vec3; intensity: number };
  post: Required<Omit<PostSpec, "grade">> & { grade: NonNullable<PostSpec["grade"]> };
  overlay: { black: number; flash: number; blur: number; whip: number };
  texts: TextState[];
  caption: CaptionState | null;
}

const VERB_DUR = 1.4;
const DEFAULT_DUR: Record<Action["do"], number> = {
  ENTER: 0.9, EXIT: 0.8, MOVE: 1.4, TURN: 1.2, SCALE: 1.0, SET: 1.2, FLOW: 1.6, PULSE: 0.5, GLOW: 0.8,
  SHIFT: 1.4, POSE: 0.6, WALK: 2, CLIMB: 3, PATH: 3,
  OPEN: VERB_DUR, CLOSE: VERB_DUR, FILL: VERB_DUR, DRAIN: VERB_DUR, GROW: 2, BREAK: 0.9, TIP: VERB_DUR, FLIP: VERB_DUR, UNROLL: 2, REVEAL: VERB_DUR, RAISE: 1.8, LOWER: 1.8, SPIN: 1,
};
const DEFAULT_EASE: Record<Action["do"], Ease> = {
  ENTER: "EASE_OUT", EXIT: "EASE_IN_OUT", MOVE: "CINEMATIC", TURN: "CINEMATIC", SCALE: "EASE_OUT", SET: "EASE_IN_OUT", FLOW: "EASE_IN_OUT", PULSE: "EASE_OUT", GLOW: "EASE_IN_OUT",
  SHIFT: "CINEMATIC", POSE: "EASE_IN_OUT", WALK: "LINEAR", CLIMB: "LINEAR", PATH: "EASE_IN_OUT",
  OPEN: "EASE_IN_OUT", CLOSE: "EASE_IN_OUT", FILL: "EASE_IN_OUT", DRAIN: "EASE_IN_OUT", GROW: "EASE_OUT", BREAK: "EASE_OUT", TIP: "SPRING", FLIP: "EASE_IN_OUT", UNROLL: "EASE_OUT", REVEAL: "EASE_IN_OUT", RAISE: "CINEMATIC", LOWER: "CINEMATIC", SPIN: "EASE_IN_OUT",
};
/** Walk / run stride (one full left-right cycle), meters, for a 1.8 m figure. */
export const STRIDE = { WALK: 1.45, RUN: 2.6 } as const;
/** Seconds a coin takes to fly from source to target in a FLOW. */
export const FLOW_FLIGHT = 0.7;

const deg = (d: number) => (d * Math.PI) / 180;

function lastFinal<T>(segs: Segment<T>[], base: T): T {
  return segs.length ? segs[segs.length - 1]!.to : base;
}

function evalNum(segs: Segment<number>[], base: number, t: number): number {
  let v = base;
  for (const s of segs) {
    if (t < s.start) break;
    const k = s.dur <= 0 ? 1 : ease(s.ease, (t - s.start) / s.dur);
    // value at segment start = v (previous segments fully applied or partially if overlapping)
    v = lerp(v, s.to, k);
  }
  return v;
}

function evalVec(segs: Segment<Vec3>[], base: Vec3, t: number): Vec3 {
  let v: Vec3 = [...base];
  for (const s of segs) {
    if (t < s.start) break;
    const k = s.dur <= 0 ? 1 : ease(s.ease, (t - s.start) / s.dur);
    v = [lerp(v[0], s.to[0], k), lerp(v[1], s.to[1], k), lerp(v[2], s.to[2], k)];
  }
  return v;
}

function evalParam(segs: Segment<ParamValue>[], base: ParamValue, t: number): ParamValue {
  let v = base;
  for (const s of segs) {
    if (t < s.start) break;
    if (typeof s.to === "number" && typeof v === "number") {
      const k = s.dur <= 0 ? 1 : ease(s.ease, (t - s.start) / s.dur);
      v = lerp(v, s.to, k);
    } else v = s.to;
  }
  return v;
}

export function compileFilm(rf: ResolvedFilm): CompiledFilm {
  const film = rf.film;
  const seed = film.seed ?? hashString(film.id);
  const actors = new Map<string, CompiledActor>();
  for (const a of film.cast) {
    actors.set(a.id, {
      actor: a,
      base: {
        position: a.position ?? [0, 0, 0],
        rotation: a.rotation ?? [0, 0, 0],
        scale: a.scale ?? 1,
        params: { ...DEFAULT_PARAMS[a.kind], ...(a.params ?? {}) },
        visible: a.visible ?? false,
      },
      pos: [],
      rot: [],
      scale: [],
      params: {},
      presence: [],
      flows: [],
      pulses: [],
      poses: [],
      gaits: [],
    });
  }
  // All actions in absolute time order (stable by authoring order).
  const timed: Array<{ a: Action; start: number; order: number }> = [];
  let order = 0;
  for (const rs of rf.shots) {
    for (const a of rs.shot.actions ?? []) timed.push({ a, start: resolveAnchor(rs, a.at), order: order++ });
  }
  timed.sort((x, y) => x.start - y.start || x.order - y.order);
  const paramSegs = (ca: CompiledActor, key: string) => (ca.params[key] ??= []);
  for (const { a, start } of timed) {
    const ca = actors.get(a.actor);
    if (!ca) continue;
    const dur = a.duration ?? DEFAULT_DUR[a.do];
    const e = a.ease ?? DEFAULT_EASE[a.do];
    switch (a.do) {
      case "ENTER":
        ca.presence.push({ kind: "ENTER", style: a.style ?? "RISE", start, dur });
        break;
      case "EXIT":
        ca.presence.push({ kind: "EXIT", style: a.style ?? "DISSOLVE", start, dur });
        break;
      case "MOVE":
        ca.pos.push({ start, dur, to: a.to, ease: e });
        break;
      case "TURN":
        ca.rot.push({ start, dur, to: a.to, ease: e });
        break;
      case "SCALE":
        ca.scale.push({ start, dur, to: a.to, ease: e });
        break;
      case "SET":
        paramSegs(ca, a.param).push({ start, dur, to: a.to, ease: e });
        break;
      case "GLOW":
        paramSegs(ca, "glow").push({ start, dur, to: a.to, ease: e });
        break;
      case "PULSE":
        ca.pulses.push({ start, dur, strength: a.strength ?? 1 });
        break;
      case "SHIFT": {
        const from = lastFinal(ca.pos, ca.base.position);
        ca.pos.push({ start, dur, to: [from[0] + a.by[0], from[1] + a.by[1], from[2] + a.by[2]], ease: e });
        break;
      }
      case "POSE":
        ca.poses.push({ start, dur, to: a.pose });
        break;
      case "WALK": {
        const from = lastFinal(ca.pos, ca.base.position);
        const dist = Math.hypot(a.to[0] - from[0], a.to[2] - from[2]);
        const run = a.run === true;
        const pace = a.pace ?? (run ? 3.2 : 1.25);
        const d = a.duration ?? Math.max(0.4, dist / pace);
        ca.pos.push({ start, dur: d, to: a.to, ease: a.ease ?? "LINEAR" });
        face(ca, start, a.to[0] - from[0], a.to[2] - from[2]);
        const h = Number(ca.base.params.height ?? 1.8) / 1.8;
        ca.gaits.push({ start, end: start + d, mode: run ? "RUN" : "WALK", cadence: dist / d / ((run ? STRIDE.RUN : STRIDE.WALK) * h) });
        break;
      }
      case "CLIMB": {
        const host = actors.get(a.on);
        if (!host || (host.actor.kind !== "STAIRS" && host.actor.kind !== "LADDER")) break;
        const kind = host.actor.kind;
        const u0 = a.from ?? 0;
        const u1 = a.to ?? 1;
        const hp = host.base.params;
        const yaw = deg(host.base.rotation[1]);
        const sc = host.base.scale;
        const toWorld = (u: number): Vec3 => {
          const l = climbLocalPoint(kind, hp, u);
          const x = l[0] * sc;
          const z = l[2] * sc;
          return [host.base.position[0] + x * Math.cos(yaw) + z * Math.sin(yaw), host.base.position[1] + l[1] * sc, host.base.position[2] - x * Math.sin(yaw) + z * Math.cos(yaw)];
        };
        const N = 24;
        ca.pos.push({ start, dur: 0.001, to: toWorld(u0), ease: "LINEAR" });
        for (let i = 1; i <= N; i++) ca.pos.push({ start: start + (dur * (i - 1)) / N, dur: dur / N, to: toWorld(u0 + ((u1 - u0) * i) / N), ease: "LINEAR" });
        if (kind === "STAIRS") {
          const dir = u1 >= u0 ? 1 : -1;
          face(ca, start, Math.cos(yaw) * dir, -Math.sin(yaw) * dir, 0.001);
          const steps = Number(hp.steps ?? 8);
          ca.gaits.push({ start, end: start + dur, mode: "WALK", cadence: (Math.abs(u1 - u0) * steps) / 2 / dur });
        } else {
          // we stand on the ladder's +z side and look toward -z
          face(ca, start, -Math.sin(yaw), -Math.cos(yaw), 0.001);
          const rungs = Number(hp.rungs ?? 12);
          ca.gaits.push({ start, end: start + dur, mode: "CLIMB", cadence: (Math.abs(u1 - u0) * rungs) / 2 / dur });
        }
        break;
      }
      case "PATH": {
        const from = lastFinal(ca.pos, ca.base.position);
        const samples = catmullSamples([from, ...a.points], 32);
        const segLen = samples.slice(1).map((p, i) => Math.hypot(p[0] - samples[i]![0], p[1] - samples[i]![1], p[2] - samples[i]![2]));
        const total = segLen.reduce((x, y) => x + y, 0) || 1;
        // eased arc-length parameterization: constant speed along the curve, eased in time
        let acc = 0;
        let prevT = start;
        for (let i = 1; i < samples.length; i++) {
          acc += segLen[i - 1]!;
          const tt = start + dur * invEase(e, acc / total);
          ca.pos.push({ start: prevT, dur: Math.max(1e-4, tt - prevT), to: samples[i]!, ease: "LINEAR" });
          if (a.orient) face(ca, prevT, samples[i]![0] - samples[i - 1]![0], samples[i]![2] - samples[i - 1]![2], Math.max(0.05, tt - prevT));
          prevT = tt;
        }
        break;
      }
      case "OPEN":
      case "CLOSE":
      case "FILL":
      case "DRAIN":
      case "GROW":
      case "BREAK":
      case "TIP":
      case "FLIP":
      case "UNROLL":
      case "REVEAL":
      case "RAISE":
      case "LOWER":
      case "SPIN": {
        const tgt = VERB_TARGETS[a.do][ca.actor.kind];
        if (!tgt) break;
        const to = a.to ?? tgt.default;
        if (to === null) break;
        paramSegs(ca, tgt.param).push({ start, dur, to, ease: e });
        break;
      }
      case "FLOW": {
        const target = actors.get(a.into);
        ca.flows.push({ into: a.into, start, dur, amount: a.amount });
        const srcCount = Number(lastFinal(paramSegs(ca, "count"), ca.base.params.count ?? 0));
        paramSegs(ca, "count").push({ start, dur, to: Math.max(0, srcCount - a.amount), ease: "LINEAR" });
        if (target && typeof target.base.params.count === "number") {
          const tc = Number(lastFinal(paramSegs(target, "count"), target.base.params.count));
          paramSegs(target, "count").push({ start: start + FLOW_FLIGHT, dur, to: tc + a.amount, ease: "LINEAR" });
        }
        break;
      }
    }
  }
  const compiled: CompiledFilm = { rf, seed, actors, cameraEnds: [] };
  for (const rs of rf.shots) {
    compiled.cameraEnds.push(evalCamera(compiled, rs, rs.endSec - 1e-6, false));
  }
  return compiled;
}

function evalActor(ca: CompiledActor, t: number): ActorState {
  const params: Record<string, ParamValue> = { ...ca.base.params };
  for (const [k, segs] of Object.entries(ca.params)) params[k] = evalParam(segs, ca.base.params[k] ?? (typeof segs[0]?.to === "number" ? 0 : ""), t);
  let visible = ca.base.visible;
  let enter = visible ? 1 : 0;
  let enterStyle: ActorState["enterStyle"] = null;
  let exit = 0;
  let exitStyle: ActorState["exitStyle"] = null;
  for (const p of ca.presence) {
    if (t < p.start) break;
    const k = p.dur <= 0 ? 1 : clamp01((t - p.start) / p.dur);
    if (p.kind === "ENTER") {
      visible = true;
      enter = k;
      enterStyle = p.style as ActorState["enterStyle"];
      exit = 0;
      exitStyle = null;
    } else {
      exit = k;
      exitStyle = p.style as ActorState["exitStyle"];
      if (k >= 1) visible = false;
    }
  }
  let pulse = 0;
  for (const p of ca.pulses) {
    const u = (t - p.start) / Math.max(0.05, p.dur);
    if (u >= 0 && u <= 1) pulse = Math.max(pulse, Math.sin(Math.PI * Math.pow(u, 0.6)) * p.strength);
  }
  const r = evalVec(ca.rot, ca.base.rotation, t);
  // pose blend
  const basePose = String(ca.base.params.pose ?? "STAND");
  let pose = { from: basePose, to: basePose, k: 1 };
  for (const p of ca.poses) {
    if (t < p.start) break;
    const k = p.dur <= 0 ? 1 : ease("EASE_IN_OUT", (t - p.start) / p.dur);
    const cur = pose.k >= 0.5 ? pose.to : pose.from;
    pose = { from: cur, to: p.to, k };
  }
  // locomotion (fades in/out over 0.25 s)
  let gait: ActorState["gait"] = null;
  for (const g of ca.gaits) {
    if (t < g.start - 0.25 || t > g.end + 0.25) continue;
    const w = Math.min(clamp01((t - g.start + 0.25) / 0.25), clamp01((g.end + 0.25 - t) / 0.25));
    gait = { mode: g.mode, phase: (Math.max(g.start, Math.min(t, g.end)) - g.start) * g.cadence, weight: w };
  }
  // running/walking in place (treadmill, hamster wheel): params.cycle = "RUN" | "WALK" | "CLIMB"
  const cyc = params.cycle;
  if (!gait && (cyc === "RUN" || cyc === "WALK" || cyc === "CLIMB")) {
    gait = { mode: cyc, phase: t * (typeof params.cadence === "number" ? params.cadence : cyc === "RUN" ? 1.4 : 0.9), weight: 1 };
  }
  return {
    id: ca.actor.id,
    kind: ca.actor.kind,
    visible,
    position: evalVec(ca.pos, ca.base.position, t),
    rotation: [deg(r[0]), deg(r[1]), deg(r[2])],
    scale: evalNum(ca.scale, ca.base.scale, t),
    params,
    enter,
    enterStyle,
    exit,
    exitStyle,
    pulse,
    flows: [],
    countRate: ca.params.count ? (Number(params.count) - Number(evalParam(ca.params.count, ca.base.params.count ?? 0, t - 0.15))) / 0.15 : 0,
    time: t,
    pose,
    gait,
    phase: integrateSpeed(ca, t),
  };
}

/** Integral of speed over 0..t (turns): exact for a constant speed, 1/60 s steps while it changes. */
function integrateSpeed(ca: CompiledActor, t: number): number {
  const base = typeof ca.base.params.speed === "number" ? ca.base.params.speed : 0;
  const segs = ca.params.speed;
  if (!segs?.length) return base * t;
  const dt = 1 / 60;
  let acc = 0;
  for (let x = 0; x < t; x += dt) acc += Number(evalParam(segs, base, Math.min(t, x + dt / 2))) * Math.min(dt, t - x);
  return acc;
}

/** Turn an actor to face a direction (x, z) — the shortest way round. */
function face(ca: CompiledActor, start: number, dx: number, dz: number, dur = 0.35) {
  if (Math.hypot(dx, dz) < 1e-6) return;
  const cur = lastFinal(ca.rot, ca.base.rotation);
  let yaw = (Math.atan2(dx, dz) * 180) / Math.PI;
  while (yaw - cur[1] > 180) yaw -= 360;
  while (yaw - cur[1] < -180) yaw += 360;
  ca.rot.push({ start, dur, to: [cur[0], yaw, cur[2]], ease: "EASE_IN_OUT" });
}

/** Points along a Catmull-Rom curve through pts (`perSpan` per span). */
function catmullSamples(pts: Vec3[], perSpan: number): Vec3[] {
  if (pts.length < 2) return [...pts];
  const out: Vec3[] = [pts[0]!];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    for (let k = 1; k <= perSpan; k++) {
      const u = k / perSpan;
      const u2 = u * u;
      const u3 = u2 * u;
      const c = (a: number, b: number, cc: number, d: number) => 0.5 * (2 * b + (-a + cc) * u + (2 * a - 5 * b + 4 * cc - d) * u2 + (-a + 3 * b - 3 * cc + d) * u3);
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1]), c(p0[2], p1[2], p2[2], p3[2])]);
    }
  }
  return out;
}

/** Inverse of an ease curve on 0..1 (bisection): the time at which eased progress reaches y. */
function invEase(kind: Ease, y: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (ease(kind, mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** An actor's state in WORLD space: its own state plus the chain of parents it rides on. */
function worldActor(cf: CompiledFilm, ca: CompiledActor, t: number, depth = 0): ActorState {
  const s = evalActor(ca, t);
  const pid = ca.actor.parent;
  if (!pid || depth > 8) return s;
  const parent = cf.actors.get(pid);
  if (!parent) return s;
  const ps = worldActor(cf, parent, t, depth + 1);
  const top = actorTopHeight(ps.kind, ps.params) * ps.scale;
  s.position = [ps.position[0] + s.position[0], ps.position[1] + top + s.position[1], ps.position[2] + s.position[2]];
  return s;
}

/** World point of an actor's visual center at time t. */
export function actorPoint(cf: CompiledFilm, idOrPoint: string | Vec3, t: number): Vec3 {
  if (Array.isArray(idOrPoint)) return idOrPoint;
  const ca = cf.actors.get(idOrPoint);
  if (!ca) return [0, 0, 0];
  const s = worldActor(cf, ca, t);
  return [s.position[0], s.position[1] + actorCenterHeight(s.kind, s.params) * s.scale, s.position[2]];
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const lerpV = (a: Vec3, b: Vec3, k: number): Vec3 => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];

interface Sph {
  d: number;
  az: number;
  el: number;
}
function toSph(offset: Vec3): Sph {
  const d = Math.max(1e-4, len(offset));
  return { d, az: (Math.atan2(offset[0], offset[2]) * 180) / Math.PI, el: (Math.asin(Math.max(-1, Math.min(1, offset[1] / d))) * 180) / Math.PI };
}
function fromSph(s: Sph): Vec3 {
  const az = deg(s.az);
  const el = deg(s.el);
  return [s.d * Math.cos(el) * Math.sin(az), s.d * Math.sin(el), s.d * Math.cos(el) * Math.cos(az)];
}

export const focalToFov = (mm: number) => (2 * Math.atan(36 / (2 * mm)) * 180) / Math.PI;

function transitionAt(rf: ResolvedFilm, boundaryIndex: number): (Transition & { duration: number }) | null {
  const rs = rf.shots[boundaryIndex];
  if (!rs || boundaryIndex >= rf.shots.length - 1) return null;
  const tr = rs.shot.transitionOut;
  if (!tr || tr.type === "CUT" || tr.type === "MATCH_CUT") return null;
  const defaults: Record<string, number> = { DIP_TO_BLACK: 0.7, FLASH: 0.35, WHIP: 0.36, PASS_THROUGH: 0.6, FOCUS_PULL: 0.8, SMASH: 0.25 };
  return { ...tr, duration: tr.duration ?? defaults[tr.type] ?? 0.5 };
}

const WHIP_DEG = 38;

function evalCamera(cf: CompiledFilm, rs: ResolvedShot, t: number, withEffects = true): CameraState {
  const rf = cf.rf;
  const cam = rs.shot.camera;
  const len01 = clamp01((t - rs.startSec) / Math.max(1e-3, rs.endSec - rs.startSec));
  const e = ease(cam.ease ?? (cam.rig === "HOLD" ? "LINEAR" : "CINEMATIC"), len01);
  const targetPt = actorPoint(cf, cam.target, t);
  const poseLook = (pose: CameraPose | undefined): Vec3 => {
    const base = pose?.lookAt !== undefined ? actorPoint(cf, pose.lookAt, t) : targetPt;
    return add(base, [0, pose?.lift ?? 0, 0]);
  };
  // start
  let fromPos: Vec3;
  let fromLook: Vec3;
  if (cam.from === "CONTINUE") {
    const prev = cf.cameraEnds[rs.index - 1];
    fromPos = prev ? prev.position : add(targetPt, [0, 1, 6]);
    fromLook = prev ? prev.lookAt : targetPt;
  } else {
    const p = cam.from;
    fromLook = poseLook(p);
    fromPos = p.position ?? add(targetPt, fromSph({ d: p.distance ?? 6, az: p.azimuth ?? 0, el: p.elevation ?? 8 }));
  }
  // end (fields default to the start pose)
  const toPose = cam.to;
  let pos: Vec3;
  let look: Vec3;
  if (!toPose) {
    pos = fromPos;
    look = fromLook;
  } else {
    const toLook = poseLook({ ...(cam.from !== "CONTINUE" ? cam.from : {}), ...toPose });
    const linear = (cam.rig === "DOLLY" || cam.rig === "TRUCK" || cam.rig === "PASS_THROUGH") && toPose.position !== undefined;
    if (linear) {
      pos = lerpV(fromPos, toPose.position!, e);
    } else {
      const s0 = toSph(sub(fromPos, targetPt));
      const s1: Sph = toPose.position
        ? toSph(sub(toPose.position, targetPt))
        : { d: toPose.distance ?? s0.d, az: toPose.azimuth ?? s0.az, el: toPose.elevation ?? s0.el };
      // distance in log space: a push-in decelerates naturally as it nears the subject
      const d = Math.exp(lerp(Math.log(s0.d), Math.log(s1.d), e));
      pos = add(targetPt, fromSph({ d, az: lerp(s0.az, s1.az, e), el: lerp(s0.el, s1.el, e) }));
    }
    look = lerpV(fromLook, toLook, e);
  }
  // lens
  const f0 = cam.lens.focalLength;
  const f1 = cam.lensTo?.focalLength ?? f0;
  const focal = lerp(f0, f1, e);
  const fStop = lerp(cam.lens.fStop ?? 2.8, cam.lensTo?.fStop ?? cam.lens.fStop ?? 2.8, e);
  // breathing drift (seeded) — amplitude scales with distance so it reads the same at any framing
  const dist = len(sub(pos, look));
  const drift = cam.drift ?? 0.12;
  if (drift > 0) {
    const a = drift * 0.03 * dist;
    pos = add(pos, [smoothNoise(cf.seed, 1, t) * a, smoothNoise(cf.seed, 2, t) * a * 0.6, smoothNoise(cf.seed, 3, t) * a * 0.5]);
    look = add(look, [smoothNoise(cf.seed, 4, t) * a * 0.35, smoothNoise(cf.seed, 5, t) * a * 0.25, 0]);
  }
  let roll = deg(cam.roll ?? 0) + (drift > 0 ? smoothNoise(cf.seed, 6, t) * drift * 0.012 : 0);
  if (cam.shake) {
    const ts = resolveAnchor(rs, cam.shake.at);
    const u = t - ts;
    if (u >= 0 && u < 0.8) {
      const amp = cam.shake.strength * 0.06 * Math.exp(-u * 6) * dist * 0.15;
      pos = add(pos, [Math.sin(u * 61) * amp, Math.sin(u * 47 + 1) * amp, 0]);
      roll += Math.sin(u * 53) * cam.shake.strength * 0.01 * Math.exp(-u * 6);
    }
  }
  // whip pans: the move carries into the cut and out of it
  if (withEffects) {
    const yaw = whipYaw(rf, rs, t);
    if (yaw !== 0) {
      const dir = sub(look, pos);
      const c = Math.cos(deg(yaw));
      const s = Math.sin(deg(yaw));
      look = add(pos, [dir[0] * c - dir[2] * s, dir[1], dir[0] * s + dir[2] * c]);
    }
  }
  // focus
  const focusRef = cam.lens.focus === undefined || cam.lens.focus === "target" ? cam.target : cam.lens.focus;
  let focusDistance = len(sub(actorPoint(cf, focusRef, t), pos));
  if (cam.rackFocus) {
    const ta = resolveAnchor(rs, cam.rackFocus.at);
    const k = ease("EASE_IN_OUT", (t - ta) / (cam.rackFocus.duration ?? 0.8));
    const d2 = len(sub(actorPoint(cf, cam.rackFocus.to, t), pos));
    focusDistance = lerp(focusDistance, d2, k);
  }
  return { position: pos, lookAt: look, fov: focalToFov(focal), focusDistance, fStop, roll };
}

function whipYaw(rf: ResolvedFilm, rs: ResolvedShot, t: number): number {
  const out = transitionAt(rf, rs.index);
  let yaw = 0;
  if (out?.type === "WHIP") {
    const u = (t - (rs.endSec - out.duration / 2)) / (out.duration / 2);
    if (u > 0) yaw += ease("EASE_IN", u) * WHIP_DEG;
  }
  const inn = rs.index > 0 ? transitionAt(rf, rs.index - 1) : null;
  if (inn?.type === "WHIP") {
    const u = (t - rs.startSec) / (inn.duration / 2);
    if (u < 1) yaw -= (1 - ease("EASE_OUT", u)) * WHIP_DEG * 0.55; // land with the subject already entering frame
  }
  return yaw;
}

/** Seconds of fade to black at the very end of the film (never at the start: the hook is frame 0). */
export const END_FADE = 0.6;

function overlayAt(rf: ResolvedFilm, t: number): FrameState["overlay"] {
  const o = { black: 0, flash: 0, blur: 0, whip: 0 };
  const endIn = t - (rf.durationSeconds - END_FADE);
  if (endIn > 0) o.black = ease("EASE_IN_OUT", endIn / END_FADE);
  for (let i = 0; i < rf.shots.length - 1; i++) {
    const tr = transitionAt(rf, i);
    if (!tr) continue;
    const cut = rf.shots[i]!.endSec;
    const h = tr.duration / 2;
    const u = (t - cut) / Math.max(1e-3, h); // -1..1 across the transition
    if (u < -1 || u > 1) continue;
    const tri = 1 - Math.abs(u);
    switch (tr.type) {
      case "DIP_TO_BLACK":
        o.black = Math.max(o.black, ease("EASE_IN_OUT", tri));
        break;
      case "FLASH":
        o.flash = Math.max(o.flash, u < 0 ? Math.pow(1 + u, 3) : Math.exp(-u * 3.2) * (1 - u));
        break;
      case "WHIP":
        o.whip = Math.max(o.whip, Math.pow(tri, 1.4));
        o.blur = Math.max(o.blur, Math.pow(tri, 2) * 0.4);
        break;
      case "PASS_THROUGH":
        o.blur = Math.max(o.blur, Math.pow(tri, 1.5));
        o.flash = Math.max(o.flash, Math.pow(tri, 3) * 0.35);
        break;
      case "FOCUS_PULL":
        o.blur = Math.max(o.blur, ease("EASE_IN_OUT", tri));
        break;
      case "SMASH":
        o.flash = Math.max(o.flash, u >= 0 ? Math.exp(-u * 5) * 0.5 : 0);
        break;
    }
  }
  return o;
}

function lightsAt(cf: CompiledFilm, rs: ResolvedShot, t: number): FrameState["lights"] {
  const def = LOOK_DEFS[cf.rf.film.look];
  const presetOf = (r: ResolvedShot | undefined) => r?.shot.lighting?.preset ?? "KEY_RIM";
  const prev = cf.rf.shots[rs.index - 1];
  const cur = def.lights[presetOf(rs)]!;
  const blend = rs.shot.lighting?.blendSeconds ?? 0.6;
  const k = blend <= 0 ? 1 : ease("EASE_IN_OUT", (t - rs.startSec) / blend);
  const rig = prev ? mixRigs(def.lights[presetOf(prev)]!, cur, k) : cur;
  const intensity = lerp(prev?.shot.lighting?.intensity ?? 1, rs.shot.lighting?.intensity ?? 1, prev ? k : 1);
  const focusRef = rs.shot.lighting?.focusOn ?? rs.shot.camera.target;
  return { ...rig, focus: actorPoint(cf, focusRef, t), intensity };
}

function postAt(cf: CompiledFilm, rs: ResolvedShot, t: number): FrameState["post"] {
  const def = LOOK_DEFS[cf.rf.film.look].post;
  const merged = (r: ResolvedShot) => ({ ...def, ...(r.shot.post ?? {}) });
  const cur = merged(rs);
  const prevShot = cf.rf.shots[rs.index - 1];
  if (!prevShot) return cur;
  const prev = merged(prevShot);
  const k = ease("EASE_IN_OUT", (t - rs.startSec) / 0.5);
  return {
    bloom: lerp(prev.bloom, cur.bloom, k),
    dof: cur.dof,
    vignette: lerp(prev.vignette, cur.vignette, k),
    grain: lerp(prev.grain, cur.grain, k),
    grade: cur.grade,
    exposure: lerp(prev.exposure, cur.exposure, k),
    aberration: lerp(prev.aberration, cur.aberration, k),
    letterbox: lerp(prev.letterbox, cur.letterbox, k),
  };
}

function formatLike(template: string, value: number): string {
  // keep the template's prefix/suffix and thousands separators: "$6,500" with 4321.7 -> "$4,322"
  const m = template.match(/^(.*?)(-?[\d,]+(?:\.\d+)?)(.*)$/);
  if (!m) return template;
  const decimals = (m[2]!.split(".")[1] ?? "").length;
  const abs = Math.abs(value);
  const fixed = abs.toFixed(decimals);
  const [i, d] = fixed.split(".");
  const withSep = m[2]!.includes(",") ? i!.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : i!;
  return `${m[1]}${value < 0 ? "-" : ""}${withSep}${d ? `.${d}` : ""}${m[3]}`;
}

const TEXT_IN = 0.45;
const TEXT_OUT = 0.35;

function textsAt(rf: ResolvedFilm, t: number): TextState[] {
  const out: TextState[] = [];
  for (const rs of rf.shots) {
    if (t < rs.startSec - 1 || t > rs.endSec + 1) continue;
    (rs.shot.text ?? []).forEach((beat, i) => {
      const tin = resolveAnchor(rs, beat.at);
      const tout = beat.until !== undefined ? resolveAnchor(rs, beat.until, "end") : rs.endSec - TEXT_OUT; // gone by the cut
      if (t < tin || t >= tout + TEXT_OUT - 1e-6) return;
      const enter = clamp01((t - tin) / TEXT_IN);
      const exit = clamp01((t - tout) / TEXT_OUT);
      const strike = beat.strikeAt !== undefined ? ease("EASE_IN_OUT", (t - resolveAnchor(rs, beat.strikeAt)) / 0.35) : 0;
      let display = beat.text;
      if (beat.countFrom !== undefined) {
        const target = Number((beat.text.match(/-?[\d,]+(?:\.\d+)?/)?.[0] ?? "0").replace(/,/g, ""));
        const k = ease("EASE_OUT", (t - tin) / 1.1);
        display = formatLike(beat.text, lerp(beat.countFrom, target, k));
      }
      out.push({ key: `${rs.shot.id}:${i}`, beat, enter, exit, strike, display, age: t - tin });
    });
  }
  return out;
}

/** Phrase captions: 1–4 words, broken at punctuation, shown while spoken. */
export function captionPhrases(words: TimedWord[]): TimedWord[][] {
  const phrases: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  for (const w of words) {
    cur.push(w);
    const punct = /[.,!?;:—]$/.test(w.raw);
    if (punct || cur.length >= 4) {
      phrases.push(cur);
      cur = [];
    }
  }
  if (cur.length) phrases.push(cur);
  return phrases;
}

function captionAt(rf: ResolvedFilm, rs: ResolvedShot, t: number, texts: TextState[]): CaptionState | null {
  if ((rf.film.captions ?? "OFF") === "OFF" || !rs.words.length) return null;
  // the line is already on screen as typography -> no duplicate caption
  if (texts.some((x) => (x.beat.style === "STATEMENT" || x.beat.style === "TITLE") && x.exit < 1)) return null;
  const phrases = captionPhrases(rs.words);
  for (let i = 0; i < phrases.length; i++) {
    const p = phrases[i]!;
    const start = p[0]!.start - 0.08;
    const next = phrases[i + 1];
    const end = next ? next[0]!.start - 0.08 : p[p.length - 1]!.end + 0.35;
    if (t >= start && t < end) {
      return {
        key: `${rs.shot.id}:${i}`,
        words: p.map((w) => ({ raw: w.raw, active: t >= w.start && t < w.end + 0.05, spoken: t >= w.start })),
        enter: clamp01((t - start) / 0.12),
        exit: next ? 0 : clamp01((t - (end - 0.2)) / 0.2),
      };
    }
  }
  return null;
}

/** Where flowing coins land: the top of a stack, the middle of anything else. */
function flowTarget(cf: CompiledFilm, id: string, t: number): Vec3 {
  const ca = cf.actors.get(id);
  if (!ca) return [0, 0, 0];
  const s = worldActor(cf, ca, t);
  const h = ca.actor.kind === "COIN_STACK" ? actorCenterHeight(s.kind, s.params) * 2 : actorCenterHeight(s.kind, s.params);
  return [s.position[0], s.position[1] + h * s.scale, s.position[2]];
}

export function evaluateFrame(cf: CompiledFilm, frame: number): FrameState {
  const rf = cf.rf;
  const f = Math.max(0, Math.min(rf.totalFrames - 1, frame));
  const t = f / rf.fps;
  const rs = shotAtFrame(rf, f);
  const scene = rf.film.scenes[rs.sceneIndex]!;
  const texts = textsAt(rf, t);
  const actors: ActorState[] = [];
  for (const ca of cf.actors.values()) {
    const s = worldActor(cf, ca, t);
    for (const fl of ca.flows) {
      const total = fl.dur + FLOW_FLIGHT;
      if (t >= fl.start && t <= fl.start + total) {
        const startCount = Number(evalParam(ca.params.count ?? [], ca.base.params.count ?? 0, fl.start - 1e-4));
        s.flows.push({ into: fl.into, progress: (t - fl.start) / total, amount: fl.amount, target: flowTarget(cf, fl.into, t), seconds: t - fl.start, dur: fl.dur, startCount });
      }
    }
    actors.push(s);
  }
  return {
    frame: f,
    time: t,
    shotIndex: rs.index,
    shotId: rs.shot.id,
    shotProgress: clamp01((f - rs.startFrame) / Math.max(1, rs.endFrame - rs.startFrame)),
    sceneIndex: rs.sceneIndex,
    set: scene.set,
    look: rf.film.look,
    camera: evalCamera(cf, rs, t),
    actors,
    lights: lightsAt(cf, rs, t),
    post: postAt(cf, rs, t),
    overlay: overlayAt(rf, t),
    texts,
    caption: captionAt(rf, rs, t, texts),
  };
}

/** Every SFX hit in film seconds (explicit cues + auto cues for transitions/enters). */
export function sfxTimeline(rf: ResolvedFilm): Array<{ sound: string; time: number; gainDb: number; source: string }> {
  const out: Array<{ sound: string; time: number; gainDb: number; source: string }> = [];
  for (const rs of rf.shots) {
    for (const cue of rs.shot.sfx ?? []) out.push({ sound: cue.sound, time: resolveAnchor(rs, cue.at), gainDb: cue.gainDb ?? 0, source: `${rs.shot.id}:cue` });
    if (rf.film.autoSfx) {
      const tr = transitionAt(rf, rs.index);
      if (tr) {
        const map: Record<string, { sound: string; lead: number; gain: number } | undefined> = {
          WHIP: { sound: "WHOOSH", lead: 0.22, gain: -2 },
          PASS_THROUGH: { sound: "WHOOSH", lead: 0.35, gain: -4 },
          FLASH: { sound: "SHIMMER", lead: 0.1, gain: -6 },
          SMASH: { sound: "IMPACT", lead: 0, gain: -2 },
          DIP_TO_BLACK: { sound: "SUB_DROP", lead: 0, gain: -8 },
        };
        const m = map[tr.type];
        if (m) out.push({ sound: m.sound, time: Math.max(0, rs.endSec - m.lead), gainDb: m.gain, source: `${rs.shot.id}:transition` });
      }
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

export { anchorFrame };
