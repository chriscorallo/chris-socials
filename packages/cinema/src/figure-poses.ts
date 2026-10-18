import type { ActorState } from "./evaluate";

/**
 * The FIGURE's skeleton angles — pure data + math (no three.js), so poses are testable and the
 * renderer only turns angles into transforms. Degrees. The figure faces +Z, its left is +X.
 *
 * Conventions (limbs hang along −Y): rotation about X swings a limb BACK for positive values
 * (so a thigh/arm forward is negative); knees bend with positive X, elbows with negative X;
 * a shoulder's Z raises the arm sideways (+Z for the left arm, −Z for the right).
 */

export interface Skeleton {
  /** Pelvis height offset (m at 1.8 m height; scaled with the figure). Negative = lower (sitting). */
  rootY: number;
  /** Forward lean of the whole body (deg, + forward) — used by run/push. */
  lean: number;
  spine: [number, number, number];
  head: [number, number, number];
  lShoulder: [number, number, number];
  rShoulder: [number, number, number];
  lElbow: number;
  rElbow: number;
  lHip: [number, number, number];
  rHip: [number, number, number];
  lKnee: number;
  rKnee: number;
  lAnkle: number;
  rAnkle: number;
}

const S = (p: Partial<Skeleton>): Skeleton => ({
  rootY: 0,
  lean: 0,
  spine: [0, 0, 0],
  head: [0, 0, 0],
  lShoulder: [0, 0, 6],
  rShoulder: [0, 0, -6],
  lElbow: -8,
  rElbow: -8,
  lHip: [0, 0, 2],
  rHip: [0, 0, -2],
  lKnee: 2,
  rKnee: 2,
  lAnkle: 0,
  rAnkle: 0,
  ...p,
});

export const POSES: Record<string, Skeleton> = {
  STAND: S({}),
  WALK: S({ lShoulder: [-12, 0, 6], rShoulder: [12, 0, -6], lHip: [-14, 0, 2], rHip: [12, 0, -2], rKnee: 14 }),
  RUN: S({ lean: 12, lShoulder: [-35, 0, 8], rShoulder: [35, 0, -8], lElbow: -85, rElbow: -85, lHip: [-40, 0, 2], lKnee: 55, rHip: [25, 0, -2], rKnee: 70 }),
  SIT: S({ rootY: -0.44, spine: [-6, 0, 0], lShoulder: [-28, 0, 8], rShoulder: [-28, 0, -8], lElbow: -48, rElbow: -48, lHip: [-88, 0, 6], rHip: [-88, 0, -6], lKnee: 88, rKnee: 88, lAnkle: 0, rAnkle: 0 }),
  CLIMB: S({ lShoulder: [-155, 0, 10], rShoulder: [-130, 0, -10], lElbow: -25, rElbow: -45, lHip: [-50, 0, 4], lKnee: 70, rHip: [-10, 0, -4], rKnee: 20, head: [-18, 0, 0] }),
  CHEER: S({ spine: [-6, 0, 0], head: [-18, 0, 0], lShoulder: [-10, 0, 155], rShoulder: [-10, 0, -155], lElbow: -12, rElbow: -12 }),
  SLUMP: S({ spine: [26, 0, 0], head: [32, 0, 0], lShoulder: [6, 0, 3], rShoulder: [6, 0, -3], lElbow: -4, rElbow: -4, lKnee: 12, rKnee: 12, lHip: [-8, 0, 2], rHip: [-8, 0, -2], rootY: -0.03 }),
  THINK: S({ head: [10, -8, 0], rShoulder: [-38, 0, -12], rElbow: -142, lShoulder: [-22, 0, 14], lElbow: -96 }),
  REACH: S({ spine: [-8, 0, 0], head: [-20, 0, 0], rShoulder: [-150, 0, -8], rElbow: -6, lShoulder: [18, 0, 10], lHip: [12, 0, 2], lKnee: 18, lAnkle: 25 }),
  PUSH: S({ lean: 22, lShoulder: [-84, 0, 8], rShoulder: [-84, 0, -8], lElbow: -22, rElbow: -22, lHip: [-24, 0, 2], lKnee: 28, rHip: [34, 0, -2], rKnee: 8, rAnkle: 20 }),
  CARRY: S({ spine: [-5, 0, 0], lShoulder: [-48, 0, 10], rShoulder: [-48, 0, -10], lElbow: -72, rElbow: -72 }),
  POINT: S({ head: [0, -30, 0], rShoulder: [-12, 0, -86], rElbow: -2, lShoulder: [0, 0, 6] }),
  BALANCE: S({ spine: [0, 0, 5], lShoulder: [0, 0, 82], rShoulder: [0, 0, -78], lElbow: -6, rElbow: -6, lHip: [-6, 0, 8], lKnee: 18, rKnee: 6 }),
};

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lv = (a: [number, number, number], b: [number, number, number], k: number): [number, number, number] => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];

export function blendSkeleton(a: Skeleton, b: Skeleton, k: number): Skeleton {
  return {
    rootY: lerp(a.rootY, b.rootY, k),
    lean: lerp(a.lean, b.lean, k),
    spine: lv(a.spine, b.spine, k),
    head: lv(a.head, b.head, k),
    lShoulder: lv(a.lShoulder, b.lShoulder, k),
    rShoulder: lv(a.rShoulder, b.rShoulder, k),
    lElbow: lerp(a.lElbow, b.lElbow, k),
    rElbow: lerp(a.rElbow, b.rElbow, k),
    lHip: lv(a.lHip, b.lHip, k),
    rHip: lv(a.rHip, b.rHip, k),
    lKnee: lerp(a.lKnee, b.lKnee, k),
    rKnee: lerp(a.rKnee, b.rKnee, k),
    lAnkle: lerp(a.lAnkle, b.lAnkle, k),
    rAnkle: lerp(a.rAnkle, b.rAnkle, k),
  };
}

/** One locomotion cycle at `phase` (cycles): legs swing opposite to arms, knees fold in the swing. */
export function gaitSkeleton(mode: "WALK" | "RUN" | "CLIMB", phase: number): Skeleton {
  const a = phase * Math.PI * 2;
  const s = Math.sin(a);
  const c = Math.cos(a);
  if (mode === "CLIMB") {
    return S({
      head: [-15, 0, 0],
      lShoulder: [-150 + s * 22, 0, 10],
      rShoulder: [-150 - s * 22, 0, -10],
      lElbow: -35 - Math.max(0, s) * 35,
      rElbow: -35 - Math.max(0, -s) * 35,
      lHip: [-40 - s * 28, 0, 4],
      rHip: [-40 + s * 28, 0, -4],
      lKnee: 60 + s * 30,
      rKnee: 60 - s * 30,
    });
  }
  const run = mode === "RUN";
  const thigh = run ? 42 : 24;
  const arm = run ? 40 : 18;
  // knee folds while that leg swings forward (sin rising)
  const kneeL = Math.max(0, c) * (run ? 95 : 45) + 4;
  const kneeR = Math.max(0, -c) * (run ? 95 : 45) + 4;
  return S({
    rootY: (run ? 0.05 : 0.025) * Math.abs(Math.sin(a)) - (run ? 0.06 : 0.02),
    lean: run ? 14 : 3,
    spine: [0, s * (run ? 9 : 5), 0],
    head: [run ? -8 : 0, -s * (run ? 6 : 3), 0],
    lHip: [-s * thigh, 0, 2],
    rHip: [s * thigh, 0, -2],
    lKnee: kneeL,
    rKnee: kneeR,
    lAnkle: Math.max(0, -s) * (run ? 25 : 12),
    rAnkle: Math.max(0, s) * (run ? 25 : 12),
    lShoulder: [s * arm, 0, 7],
    rShoulder: [-s * arm, 0, -7],
    lElbow: run ? -88 : -14 - Math.max(0, -s) * 18,
    rElbow: run ? -88 : -14 - Math.max(0, s) * 18,
  });
}

/** The skeleton a FIGURE state asks for: pose blend, then locomotion layered on top, then idle breathing. */
export function skeletonFor(s: Pick<ActorState, "pose" | "gait" | "time">): Skeleton {
  const from = POSES[s.pose.from] ?? POSES.STAND!;
  const to = POSES[s.pose.to] ?? POSES.STAND!;
  let sk = blendSkeleton(from, to, s.pose.k);
  if (s.gait && s.gait.weight > 0) sk = blendSkeleton(sk, gaitSkeleton(s.gait.mode, s.gait.phase), s.gait.weight);
  // idle: a slow breath in the chest and a slight head drift (never perfectly still)
  const b = Math.sin(s.time * 1.7) * 1.2;
  sk.spine = [sk.spine[0] + b * 0.6, sk.spine[1], sk.spine[2]];
  sk.head = [sk.head[0] - b * 0.4, sk.head[1] + Math.sin(s.time * 0.6) * 2, sk.head[2]];
  return sk;
}
