import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { clamp01, ease, rng, smoothNoise } from "../../ease";
import type { ActorState } from "../../evaluate";
import { FLOW_FLIGHT } from "../../evaluate";
import { COIN, COIN_PITCH, stackColumnOffsets, stackSlot } from "../../kinds";
import type { LookDef } from "../../looks";
import { goldMaterials, radialTexture, textTexture, windowTexture } from "./materials";
import type { ActorKind } from "../../dsl/schema";
import { Crowd, Figure } from "./figure";
import { Arrow, BankCard, BarChart, Balance, Blocks, Bucket, Calendar, Chain, Divider, DocumentPage, Door, ForkPath, Gauge, Hourglass, House, Ladder, LineChart, Magnifier, Meter, Phone, PieChart, Platform, Receipt, Snowball, Stairs, Text3D, Tree, Walls, Wheel } from "./props";

/**
 * Procedural actors. Each one is a pure function of its ActorState (from the evaluator) —
 * instance matrices are rewritten every frame in a layout effect, nothing accumulates.
 */

export interface ActorProps {
  s: ActorState;
  look: LookDef;
  seed: number;
  /** Rendering the floor reflection copy (no shadows, no labels). */
  mirror?: boolean;
  quality: number; // 0.5 draft .. 1 final
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const numArr = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((x) => Number.isFinite(x)) : []);

/** Group-level entrance/exit transform shared by all actors. */
export function presence(s: ActorState): { scale: number; y: number; hidden: boolean } {
  if (!s.visible) return { scale: 0, y: 0, hidden: true };
  let scale = 1;
  let y = 0;
  if (s.enter < 1 && s.enterStyle) {
    const k = s.enter;
    switch (s.enterStyle) {
      case "RISE":
        y = -(1 - ease("EASE_OUT", k)) * 1.6;
        scale = 0.7 + 0.3 * ease("EASE_OUT", k);
        break;
      case "DROP":
        y = (1 - ease("EASE_IN", Math.min(1, k * 1.25))) * 4 + (k > 0.8 ? Math.sin(((k - 0.8) / 0.2) * Math.PI) * 0.08 : 0);
        break;
      case "GROW":
      case "FADE":
        scale = ease("SPRING", k);
        break;
      case "BUILD":
        break; // kind-specific
    }
  }
  if (s.exit > 0 && s.exitStyle) {
    const k = s.exit;
    switch (s.exitStyle) {
      case "SINK":
        y -= ease("EASE_IN", k) * 2;
        break;
      case "SHRINK":
      case "FADE":
      case "DISSOLVE":
        scale *= 1 - ease("EASE_IN_OUT", k);
        break;
      case "SHATTER":
        break;
    }
  }
  scale *= 1 + s.pulse * 0.06;
  return { scale, y, hidden: scale <= 0.001 };
}

// ---------------------------------------------------------------------------------------------
// Coins

const MAX_COINS = 420;
const MAX_FLYING = 90;
const coinGeo = new THREE.CylinderGeometry(COIN.radius, COIN.radius, COIN.thickness, 72, 1);

function coinJitter(seed: number) {
  const r = rng(seed);
  return Array.from({ length: MAX_COINS }, () => ({ dx: (r() - 0.5) * 0.06, dz: (r() - 0.5) * 0.06, ry: r() * Math.PI * 2, tx: (r() - 0.5) * 0.02, tz: (r() - 0.5) * 0.02, sp: r() }));
}

const dummy = new THREE.Object3D();

export function CoinStack({ s, look, seed, mirror }: ActorProps) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const flyRef = useRef<THREE.InstancedMesh>(null);
  const dustRef = useRef<THREE.Points>(null);
  const mats = goldMaterials(look.gold);
  const matArr = useMemo(() => [mats.edge, mats.face, mats.face], [mats]);
  const columns = Math.max(1, Math.round(num(s.params.columns, 1)));
  const offsets = useMemo(() => stackColumnOffsets(columns), [columns]);
  const jit = useMemo(() => coinJitter(seed), [seed]);
  const jitterAmt = num(s.params.jitter, 0.5);
  const dustGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(600 * 3), 3));
    return g;
  }, []);

  const slotPos = (i: number): [number, number, number] => {
    const { column, level } = stackSlot(i, columns);
    const o = offsets[column]!;
    const j = jit[i % MAX_COINS]!;
    return [o[0] + j.dx * jitterAmt, level * COIN_PITCH + COIN.thickness / 2, o[1] + j.dz * jitterAmt];
  };

  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const count = Math.max(0, num(s.params.count, 0));
    const rate = s.countRate;
    const win = Math.min(10, Math.max(1.5, Math.abs(rate) * 0.3));
    const building = s.enterStyle === "BUILD" && s.enter < 1;
    const shatter = s.exitStyle === "SHATTER" && s.exit > 0 ? s.exit : 0;
    const total = Math.min(MAX_COINS, Math.ceil(count + (rate < -0.01 ? win : 0)));
    const dust = dustGeo.getAttribute("position") as THREE.BufferAttribute;
    let d = 0;
    let k = 0;
    for (let i = 0; i < total; i++) {
      const j = jit[i]!;
      let [x, y, z] = slotPos(i);
      let sc = 1;
      let rx = j.tx;
      let rz = j.tz;
      const ry = j.ry;
      if (i >= count) {
        // evaporating: lifts, spins, shrinks into gold dust
        const e = (i - count) / win;
        if (e >= 1) continue;
        y += ease("EASE_OUT", e) * 1.6;
        sc = 1 - ease("EASE_IN", e);
        rx += e * 2.4;
        rz += e * 1.3 * (j.sp - 0.5);
        if (!mirror && d < 590) {
          for (let q = 0; q < 6 && d < 600; q++) {
            const a = j.sp * 40 + q * 1.7;
            const r = 0.25 + e * 1.2 * (0.4 + ((q * 37) % 10) / 10);
            dust.setXYZ(d++, x + Math.cos(a) * r, y + e * 0.8 + q * 0.06, z + Math.sin(a) * r);
          }
        }
      } else if (rate > 0.01 && count - i < win) {
        // dropping in: newest coins fall from above and settle
        const p = (count - i) / win;
        y += Math.pow(1 - p, 2) * 2.4;
        rx += (1 - p) * 1.1 * (j.sp - 0.5);
      }
      if (building) {
        const p = clamp01((s.enter - (i / Math.max(1, count)) * 0.72) / 0.28);
        if (p <= 0) continue;
        const fall = 1 - ease("EASE_IN", p);
        y += fall * 3.2;
        rx += fall * 2 * (j.sp - 0.5);
        rz += fall * 1.5;
      }
      if (shatter > 0) {
        const a = j.sp * Math.PI * 2;
        const v = 1.2 + j.sp * 2;
        x += Math.cos(a) * v * shatter;
        z += Math.sin(a) * v * shatter;
        y += v * shatter * 1.4 - 4.9 * shatter * shatter;
        rx += shatter * 6 * j.sp;
        if (y < COIN.thickness / 2) y = COIN.thickness / 2;
      }
      dummy.position.set(x, y, z);
      dummy.rotation.set(rx, ry, rz);
      dummy.scale.setScalar(Math.max(0.0001, sc));
      dummy.updateMatrix();
      m.setMatrixAt(k++, dummy.matrix);
    }
    m.count = k;
    m.instanceMatrix.needsUpdate = true;
    for (let i = d; i < 600; i++) dust.setXYZ(i, 0, -1000, 0);
    dust.needsUpdate = true;
    if (dustRef.current) dustRef.current.visible = d > 0;

    // coins in flight (FLOW)
    const f = flyRef.current;
    if (f) {
      let n = 0;
      for (const fl of s.flows) {
        const amount = Math.max(1, Math.round(fl.amount));
        for (let c = 0; c < amount && n < MAX_FLYING; c++) {
          const depart = (c / amount) * fl.dur;
          const u = (fl.seconds - depart) / FLOW_FLIGHT;
          if (u < 0 || u > 1) continue;
          const src = slotPos(Math.max(0, Math.round(fl.startCount) - 1 - c));
          // target in this actor's local space
          const inv = 1 / Math.max(1e-3, s.scale);
          const tgt: [number, number, number] = [(fl.target[0] - s.position[0]) * inv, (fl.target[1] - s.position[1]) * inv, (fl.target[2] - s.position[2]) * inv];
          const jj = jit[(c * 7) % MAX_COINS]!;
          const tt = ease("EASE_IN_OUT", u);
          const mid: [number, number, number] = [(src[0] + tgt[0]) / 2 + (jj.dx * 8), Math.max(src[1], tgt[1]) + 1.2 + Math.hypot(tgt[0] - src[0], tgt[2] - src[2]) * 0.22, (src[2] + tgt[2]) / 2 + jj.dz * 8];
          const b = (a: number, m2: number, c2: number) => (1 - tt) * (1 - tt) * a + 2 * (1 - tt) * tt * m2 + tt * tt * c2;
          dummy.position.set(b(src[0], mid[0], tgt[0]), b(src[1], mid[1], tgt[1]), b(src[2], mid[2], tgt[2]));
          dummy.rotation.set(u * 9 * (0.5 + jj.sp), jj.ry, u * 4);
          dummy.scale.setScalar(u > 0.85 ? 1 - (u - 0.85) / 0.15 * 0.7 : 1);
          dummy.updateMatrix();
          f.setMatrixAt(n++, dummy.matrix);
        }
      }
      f.count = n;
      f.instanceMatrix.needsUpdate = true;
    }
  });

  const dustMat = useMemo(() => new THREE.PointsMaterial({ map: radialTexture("rgba(255,214,140,1)", "rgba(255,180,80,0)", 64), color: new THREE.Color(look.goldLight).multiplyScalar(2.2), size: 0.07, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }), [look.goldLight]);

  return (
    <group>
      <instancedMesh ref={ref} args={[coinGeo, matArr, MAX_COINS]} castShadow={!mirror} receiveShadow frustumCulled={false} />
      <instancedMesh ref={flyRef} args={[coinGeo, matArr, MAX_FLYING]} castShadow={!mirror} frustumCulled={false} />
      {!mirror && <points ref={dustRef} geometry={dustGeo} material={dustMat} frustumCulled={false} />}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// Coin chart — data as a sculpture

export function CoinChart({ s, look, seed, mirror }: ActorProps) {
  const pRef = useRef<THREE.InstancedMesh>(null);
  const gRef = useRef<THREE.InstancedMesh>(null);
  const mats = goldMaterials(look.gold);
  const growthMats = useMemo(() => {
    const m = mats.face.clone();
    m.color = new THREE.Color("#FFF0C4");
    m.roughness = 0.16;
    m.emissive = new THREE.Color(look.goldLight);
    m.emissiveIntensity = 0.0;
    const e = mats.edge.clone();
    e.color = m.color;
    e.emissive = m.emissive;
    return { face: m, edge: e };
  }, [mats, look.goldLight]);
  const jit = useMemo(() => coinJitter(seed + 17), [seed]);
  const values = numArr(s.params.values);
  const split = numArr(s.params.split);
  const spacing = num(s.params.spacing, 1.25);
  const progress = clamp01(num(s.params.progress, 0));
  const glow = num(s.params.glow, 0);
  growthMats.face.emissiveIntensity = glow * 0.05;
  growthMats.edge.emissiveIntensity = glow * 0.05;
  growthMats.face.envMapIntensity = 2 + glow * 1.2;

  useLayoutEffect(() => {
    const pm = pRef.current;
    const gm = gRef.current;
    if (!pm || !gm) return;
    const n = values.length;
    let pk = 0;
    let gk = 0;
    const wave = 5;
    for (let c = 0; c < n; c++) {
      const colP = clamp01((progress * (n + wave) - c) / wave);
      const v = values[c]! * ease("EASE_OUT", colP);
      const principal = split[c] ?? values[c]!;
      const x = (c - (n - 1) / 2) * spacing;
      const shown = Math.ceil(v);
      for (let i = 0; i < shown && pk + gk < MAX_COINS * 4; i++) {
        const j = jit[(c * 31 + i) % MAX_COINS]!;
        let y = i * COIN_PITCH + COIN.thickness / 2;
        const frac = v - i; // < 1 for the coin currently landing
        if (frac < 1 && colP < 1) y += Math.pow(1 - frac, 2) * 1.6;
        dummy.position.set(x + j.dx * 0.4, y, j.dz * 0.4);
        dummy.rotation.set(j.tx, j.ry, j.tz);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        if (i < principal) pm.setMatrixAt(pk++, dummy.matrix);
        else gm.setMatrixAt(gk++, dummy.matrix);
      }
    }
    pm.count = pk;
    gm.count = gk;
    pm.instanceMatrix.needsUpdate = true;
    gm.instanceMatrix.needsUpdate = true;
  });

  const pArr = useMemo(() => [mats.edge, mats.face, mats.face], [mats]);
  const gArr = useMemo(() => [growthMats.edge, growthMats.face, growthMats.face], [growthMats]);
  return (
    <group>
      <instancedMesh ref={pRef} args={[coinGeo, pArr, MAX_COINS * 4]} castShadow={!mirror} receiveShadow frustumCulled={false} />
      <instancedMesh ref={gRef} args={[coinGeo, gArr, MAX_COINS * 4]} castShadow={!mirror} receiveShadow frustumCulled={false} />
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// Pedestal

export function Pedestal({ s, look }: ActorProps) {
  const r = num(s.params.radius, 1.1);
  const h = num(s.params.height, 0.9);
  const geo = useMemo(() => {
    // no bottom cap: the floor reflection would show it lit, coplanar with the floor
    const pts = [
      new THREE.Vector2(r * 1.12, 0),
      new THREE.Vector2(r * 1.12, 0.06),
      new THREE.Vector2(r * 1.04, 0.1),
      new THREE.Vector2(r, 0.16),
      new THREE.Vector2(r, h - 0.1),
      new THREE.Vector2(r * 1.05, h - 0.06),
      new THREE.Vector2(r * 1.05, h - 0.015),
      new THREE.Vector2(r * 1.035, h),
      new THREE.Vector2(0, h),
    ];
    return new THREE.LatheGeometry(pts, 96);
  }, [r, h]);
  const mat = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#0f0d0f"), roughness: 0.45, metalness: 0.1, clearcoat: 0.5, clearcoatRoughness: 0.35 }), []);
  const ring = useMemo(() => new THREE.TorusGeometry(r * 1.05, 0.012, 8, 128), [r]);
  const ringMat = useMemo(() => new THREE.MeshStandardMaterial({ color: new THREE.Color(look.gold), emissive: new THREE.Color(look.goldLight), emissiveIntensity: 0.9, metalness: 1, roughness: 0.3 }), [look]);
  return (
    <group>
      <mesh geometry={geo} material={mat} castShadow receiveShadow />
      <mesh geometry={ring} material={ringMat} position={[0, h - 0.035, 0]} rotation={[Math.PI / 2, 0, 0]} />
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// Building (miniature apartment block)

export function Building({ s, look, seed }: ActorProps) {
  const floors = Math.max(2, Math.round(num(s.params.floors, 6)));
  const w = num(s.params.width, 1.4);
  const glow = num(s.params.glow, 0.8);
  const floorH = 0.42;
  const H = floors * floorH;
  const building = s.enterStyle === "BUILD" && s.enter < 1;
  const shown = building ? Math.max(0.0001, Math.ceil(ease("EASE_IN_OUT", s.enter) * floors * 4) / (floors * 4)) : 1;
  const win = windowTexture(floors * 2, 8, seed);
  const winSide = windowTexture(floors * 2, 6, seed + 1);
  const mats = useMemo(() => {
    const side = (map: THREE.Texture) => new THREE.MeshStandardMaterial({ color: new THREE.Color("#2a2622"), roughness: 0.5, metalness: 0.35, emissive: new THREE.Color("#FFD8A0"), emissiveMap: map, emissiveIntensity: 1.6 });
    const top = new THREE.MeshStandardMaterial({ color: new THREE.Color("#232026"), roughness: 0.7 });
    return [side(winSide), side(winSide), top, top, side(win), side(win)];
  }, [win, winSide]);
  for (const m of mats) if ((m as THREE.MeshStandardMaterial).emissiveMap) (m as THREE.MeshStandardMaterial).emissiveIntensity = 0.9 * glow * (building ? s.enter : 1);
  const trim = useMemo(() => new THREE.MeshStandardMaterial({ color: new THREE.Color(look.gold), metalness: 1, roughness: 0.3, emissive: new THREE.Color(look.goldDeep), emissiveIntensity: 0.25 }), [look]);
  return (
    <group scale={[1, shown, 1]}>
      <mesh position={[0, H / 2, 0]} castShadow receiveShadow material={mats}>
        <boxGeometry args={[w, H, w * 0.8]} />
      </mesh>
      {/* cornice + gold trim line */}
      <mesh position={[0, H + 0.03, 0]} castShadow material={trim}>
        <boxGeometry args={[w * 1.04, 0.05, w * 0.84]} />
      </mesh>
      <mesh position={[w * 0.18, H + 0.2, -w * 0.1]} castShadow>
        <cylinderGeometry args={[0.13, 0.13, 0.3, 24]} />
        <meshStandardMaterial color="#2a2629" roughness={0.6} />
      </mesh>
      <mesh position={[-w * 0.22, H + 0.12, w * 0.12]} castShadow>
        <boxGeometry args={[0.36, 0.18, 0.3]} />
        <meshStandardMaterial color="#2a2629" roughness={0.6} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// Car (stylized coupe, extruded profile)

function carProfile(): THREE.Shape {
  const sh = new THREE.Shape();
  sh.moveTo(-1.12, 0.2);
  sh.lineTo(-1.12, 0.46);
  sh.bezierCurveTo(-1.1, 0.53, -0.95, 0.56, -0.72, 0.57);
  sh.bezierCurveTo(-0.55, 0.78, -0.35, 0.86, -0.05, 0.86);
  sh.bezierCurveTo(0.22, 0.86, 0.38, 0.8, 0.6, 0.6);
  sh.bezierCurveTo(0.9, 0.57, 1.1, 0.52, 1.13, 0.4);
  sh.lineTo(1.13, 0.2);
  // rear wheel arch & front wheel arch (cut upward)
  sh.lineTo(0.92, 0.2);
  sh.absarc(0.68, 0.2, 0.25, 0, Math.PI, false);
  sh.lineTo(-0.44, 0.2);
  sh.absarc(-0.68, 0.2, 0.25, 0, Math.PI, false);
  sh.lineTo(-1.12, 0.2);
  return sh;
}

function windowProfile(): THREE.Shape {
  const sh = new THREE.Shape();
  sh.moveTo(-0.62, 0.59);
  sh.bezierCurveTo(-0.48, 0.74, -0.32, 0.8, -0.06, 0.8);
  sh.bezierCurveTo(0.18, 0.8, 0.32, 0.75, 0.5, 0.6);
  sh.lineTo(-0.62, 0.59);
  return sh;
}

export function Car({ s, look }: ActorProps) {
  const color = typeof s.params.color === "string" ? s.params.color : look.gold;
  const body = useMemo(() => {
    const g = new THREE.ExtrudeGeometry(carProfile(), { depth: 0.86, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 5, curveSegments: 24 });
    g.translate(0, 0, -0.43);
    return g;
  }, []);
  const glass = useMemo(() => {
    const g = new THREE.ExtrudeGeometry(windowProfile(), { depth: 1.0, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2, curveSegments: 16 });
    g.translate(0, 0.0, -0.5);
    return g;
  }, []);
  const paint = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), metalness: 0.85, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06 }), [color]);
  const glassMat = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#0b0b10"), metalness: 0.2, roughness: 0.05, clearcoat: 1 }), []);
  const tire = useMemo(() => new THREE.MeshStandardMaterial({ color: new THREE.Color("#0d0d0f"), roughness: 0.85 }), []);
  const rim = useMemo(() => new THREE.MeshStandardMaterial({ color: new THREE.Color("#d9d4cc"), metalness: 1, roughness: 0.25 }), []);
  const lamp = useMemo(() => new THREE.MeshStandardMaterial({ color: "#fff", emissive: new THREE.Color("#FFF2D6"), emissiveIntensity: 4 }), []);
  const tail = useMemo(() => new THREE.MeshStandardMaterial({ color: "#300", emissive: new THREE.Color("#FF3B2F"), emissiveIntensity: 3 }), []);
  const wheels: Array<[number, number]> = [
    [0.68, 0.47],
    [0.68, -0.47],
    [-0.68, 0.47],
    [-0.68, -0.47],
  ];
  const spin = s.time * 6;
  return (
    <group>
      <mesh geometry={body} material={paint} castShadow receiveShadow />
      <mesh geometry={glass} material={glassMat} />
      {wheels.map(([x, z], i) => (
        <group key={i} position={[x, 0.2, z]} rotation={[Math.PI / 2, spin, 0]}>
          <mesh material={tire} castShadow>
            <cylinderGeometry args={[0.21, 0.21, 0.16, 32]} />
          </mesh>
          <mesh material={rim} position={[0, z > 0 ? 0.081 : -0.081, 0]}>
            <cylinderGeometry args={[0.13, 0.13, 0.01, 24]} />
          </mesh>
        </group>
      ))}
      <mesh material={lamp} position={[1.17, 0.4, 0.3]}>
        <boxGeometry args={[0.03, 0.05, 0.16]} />
      </mesh>
      <mesh material={lamp} position={[1.17, 0.4, -0.3]}>
        <boxGeometry args={[0.03, 0.05, 0.16]} />
      </mesh>
      <mesh material={tail} position={[-1.17, 0.42, 0]}>
        <boxGeometry args={[0.03, 0.04, 0.7]} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// Cards (subscriptions)

function cardShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r);
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  return s;
}

const CARD_W = 0.95;
const CARD_H = 0.6;
const cardGeo = (() => {
  const g = new THREE.ExtrudeGeometry(cardShape(CARD_W, CARD_H, 0.07), { depth: 0.018, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2 });
  g.translate(0, 0, -0.009);
  return g;
})();
const cardFaceGeo = new THREE.PlaneGeometry(CARD_W * 0.96, CARD_H * 0.94);

function Card({ label, price, look, glow, mirror }: { label: string; price: string; look: LookDef; glow: number; mirror?: boolean }) {
  const tex = textTexture(
    [
      { text: label, font: "600 64px Inter, sans-serif", color: "#F5F1EA", y: 150 },
      { text: price, font: "800 108px 'Inter Display', Inter, sans-serif", color: look.goldLight, y: 270 },
    ],
    640,
    400,
  );
  const body = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#17141c"), roughness: 0.18, metalness: 0.3, clearcoat: 1, emissive: new THREE.Color(look.gold), emissiveIntensity: 0.02 }), [look]);
  const face = useMemo(() => new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }), [tex]);
  face.color.setScalar(0.85 + glow * 0.5);
  return (
    <group>
      <mesh geometry={cardGeo} material={body} castShadow={!mirror} />
      <mesh geometry={cardFaceGeo} material={face} position={[0, 0, 0.0161]} />
    </group>
  );
}

export function CardFan({ s, look, mirror }: ActorProps) {
  const labels = strArr(s.params.labels);
  const n = Math.max(1, Math.round(num(s.params.count, labels.length || 6)));
  const radius = num(s.params.radius, 1.4);
  const glow = num(s.params.glow, 0.6);
  const cardScale = num(s.params.cardScale, 1);
  const t = s.time;
  return (
    <group>
      {Array.from({ length: n }, (_, i) => {
        const [label, price] = (labels[i] ?? "Subscription|$9.99").split("|");
        const a = (i / n) * Math.PI * 2 + t * 0.35;
        const y = 0.9 + Math.sin(t * 1.3 + i) * 0.08 + (i % 2) * 0.35;
        // staggered entrance
        const k = clamp01((s.enter - (i / n) * 0.6) / 0.4);
        const sc = (s.enterStyle === "BUILD" || s.enterStyle === "GROW" ? ease("SPRING", k) : 1) * cardScale;
        if (sc <= 0.001) return null;
        return (
          <group key={i} position={[Math.sin(a) * radius, y, Math.cos(a) * radius]} rotation={[0, a + Math.PI * 0.1, Math.sin(t + i) * 0.06]} scale={sc}>
            <Card label={label ?? ""} price={price ?? ""} look={look} glow={glow} mirror={mirror} />
          </group>
        );
      })}
    </group>
  );
}

export function SingleCard({ s, look, mirror }: ActorProps) {
  return <Card label={String(s.params.label ?? "")} price={String(s.params.price ?? "")} look={look} glow={num(s.params.glow, 0.6)} mirror={mirror} />;
}

// ---------------------------------------------------------------------------------------------
// Baseline — a glowing plane: "your new normal"

export function Baseline({ s, look, mirror }: ActorProps) {
  const level = num(s.params.level, 0.05);
  const size = num(s.params.size, 6);
  const label = String(s.params.label ?? "");
  const grid = useMemo(() => {
    const S = 512;
    const c = document.createElement("canvas");
    c.width = S;
    c.height = S;
    const g = c.getContext("2d")!;
    const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    rg.addColorStop(0, "rgba(255,200,110,0.55)");
    rg.addColorStop(0.6, "rgba(255,190,90,0.22)");
    rg.addColorStop(1, "rgba(255,180,80,0)");
    g.fillStyle = rg;
    g.fillRect(0, 0, S, S);
    g.strokeStyle = "rgba(255,225,170,0.55)";
    g.lineWidth = 1.5;
    for (let i = 0; i <= 16; i++) {
      const p = (i / 16) * S;
      g.beginPath();
      g.moveTo(p, 0);
      g.lineTo(p, S);
      g.stroke();
      g.beginPath();
      g.moveTo(0, p);
      g.lineTo(S, p);
      g.stroke();
    }
    const mask = g.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S / 2);
    mask.addColorStop(0, "rgba(0,0,0,1)");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    g.globalCompositeOperation = "destination-in";
    g.fillStyle = mask;
    g.fillRect(0, 0, S, S);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ map: grid, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }), [grid]);
  const glow = num(s.params.glow, 1);
  mat.color = new THREE.Color(look.goldLight).multiplyScalar(0.9 * glow * (s.enter < 1 ? s.enter : 1));
  const labelTex = label ? textTexture([{ text: label, font: "600 72px Inter, sans-serif", color: "#FFE2AE", y: 64 }], 1024, 128) : null;
  return (
    <group position={[0, level, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} material={mat}>
        <planeGeometry args={[size, size]} />
      </mesh>
      {labelTex && !mirror && (
        <mesh position={[0, 0.16, size * 0.3]}>
          <planeGeometry args={[2.4, 0.3]} />
          <meshBasicMaterial map={labelTex} transparent depthWrite={false} toneMapped={false} opacity={s.enter} />
        </mesh>
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// Light shaft (fake volumetric beam) and number wall

export function LightShaft({ s, look }: ActorProps) {
  const width = num(s.params.width, 1.6);
  const strength = num(s.params.strength, 0.8);
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 256;
    const g = c.getContext("2d")!;
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, "rgba(255,255,255,0)");
    gr.addColorStop(0.25, "rgba(255,255,255,0.5)");
    gr.addColorStop(1, "rgba(255,255,255,0.05)");
    g.fillStyle = gr;
    g.fillRect(0, 0, 4, 256);
    const t = new THREE.CanvasTexture(c);
    return t;
  }, []);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }), [tex]);
  mat.color = new THREE.Color(look.goldLight).multiplyScalar(0.18 * strength * s.enter);
  return (
    <mesh position={[0, 3.2, 0]} material={mat}>
      <cylinderGeometry args={[width * 0.25, width, 6.4, 48, 1, true]} />
    </mesh>
  );
}

export function NumberWall({ s, look, seed }: ActorProps) {
  const density = num(s.params.density, 0.6);
  const items = useMemo(() => {
    const r = rng(seed + 99);
    return Array.from({ length: Math.round(60 * density) }, () => ({ x: (r() - 0.5) * 18, y: r() * 10, z: -6 - r() * 10, d: Math.floor(r() * 10), sz: 0.3 + r() * 0.7, sp: 0.05 + r() * 0.15 }));
  }, [seed, density]);
  const texes = useMemo(() => Array.from({ length: 10 }, (_, d) => textTexture([{ text: String(d), font: "700 200px 'Inter Display', Inter, sans-serif", color: "#7FE3D8", y: 128 }], 256, 256)), []);
  void look;
  return (
    <group>
      {items.map((it, i) => (
        <mesh key={i} position={[it.x, (it.y + s.time * it.sp) % 10, it.z]} scale={it.sz}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial map={texes[it.d]} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={0.25 + 0.2 * smoothNoise(seed, i, s.time)} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

export const ACTOR_COMPONENTS: Record<ActorKind, (p: ActorProps) => React.ReactNode> = {
  FIGURE: Figure,
  CROWD: Crowd,
  PLATFORM: Platform,
  STAIRS: Stairs,
  LADDER: Ladder,
  BALANCE: Balance,
  DOOR: Door,
  WALLS: Walls,
  WHEEL: Wheel,
  SNOWBALL: Snowball,
  TREE: Tree,
  BLOCKS: Blocks,
  BUCKET: Bucket,
  HOURGLASS: Hourglass,
  CHAIN: Chain,
  FORK_PATH: ForkPath,
  MAGNIFIER: Magnifier,
  DOCUMENT: DocumentPage,
  RECEIPT: Receipt,
  CALENDAR: Calendar,
  GAUGE: Gauge,
  METER: Meter,
  DIVIDER: Divider,
  HOUSE: House,
  PHONE: Phone,
  BANK_CARD: BankCard,
  BAR_CHART: BarChart,
  LINE_CHART: LineChart,
  PIE_CHART: PieChart,
  TEXT_3D: Text3D,
  ARROW: Arrow,
  COIN_STACK: CoinStack,
  COIN_CHART: CoinChart,
  PEDESTAL: Pedestal,
  BUILDING: Building,
  CAR: Car,
  CARD: SingleCard,
  CARD_FAN: CardFan,
  BASELINE: Baseline,
  LIGHT_SHAFT: LightShaft,
  NUMBER_WALL: NumberWall,
};
