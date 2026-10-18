import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { clamp01, ease, rng } from "../../ease";
import { COIN, snowballRadius } from "../../kinds";
import type { ActorProps } from "./actors";
import { goldMaterials, radialTexture, textTexture, windowTexture } from "./materials";

/**
 * The v1.1 visual vocabulary: props and metaphor machines (platform, stairs, ladder, balance,
 * door, walls, wheel, snowball, tree, doubling blocks, leaky bucket, hourglass, chain, forked
 * path, magnifier + document, receipt, calendar, gauge, meter, divider, house, phone, bank
 * card, 3D charts, text in the world, trend arrow). All procedural, all a pure function of the
 * actor's state — see src/catalog.ts for what each one means.
 */

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const numArr = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((x) => Number.isFinite(x)) : []);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const d2r = (d: number) => (d * Math.PI) / 180;
const dummy = new THREE.Object3D();

// ---------------------------------------------------------------------------------------------
// shared materials / helpers

function useDarkMat(color = "#1a1716", rough = 0.55, metal = 0.2) {
  return useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), roughness: rough, metalness: metal, clearcoat: 0.3, clearcoatRoughness: 0.4 }), [color, rough, metal]);
}

function useGlowMat(color: string, intensity: number) {
  const m = useMemo(() => new THREE.MeshStandardMaterial({ color: new THREE.Color(color), emissive: new THREE.Color(color), emissiveIntensity: 1, metalness: 0.6, roughness: 0.3, toneMapped: false }), [color]);
  m.emissiveIntensity = intensity;
  return m;
}

/** Text in the world on a transparent plane, `width` meters wide (height follows the text). */
export function Label({ text, width, color = "#F5F1EA", font = "600 96px Inter, sans-serif", position = [0, 0, 0], rotation = [0, 0, 0], opacity = 1, billboard }: { text: string; width: number; color?: string; font?: string; position?: [number, number, number]; rotation?: [number, number, number]; opacity?: number; billboard?: boolean }) {
  const W = 1024;
  const H = 160;
  const tex = textTexture([{ text, font, color, y: H / 2 }], W, H);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }), [tex]);
  mat.opacity = opacity;
  void billboard;
  if (!text) return null;
  return (
    <mesh position={position} rotation={rotation} material={mat} renderOrder={5}>
      <planeGeometry args={[width, (width * H) / W]} />
    </mesh>
  );
}

function roundedRect(w: number, h: number, r: number): THREE.Shape {
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

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const smallCoin = new THREE.CylinderGeometry(COIN.radius * 0.36, COIN.radius * 0.36, COIN.thickness * 0.4, 28);

// ---------------------------------------------------------------------------------------------
// PLATFORM — the floor itself, rising: a solid plinth whose top is at `level`

export function Platform({ s, look, mirror }: ActorProps) {
  const level = Math.max(0.004, num(s.params.level, 0));
  const w = num(s.params.width, 8);
  const d = num(s.params.depth, 5);
  const glow = num(s.params.glow, 0.8);
  const label = str(s.params.label);
  const body = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#15110f"), roughness: 0.42, metalness: 0.25, clearcoat: 0.6, clearcoatRoughness: 0.3 }), []);
  const top = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#4a3a2a"), roughness: 0.5, metalness: 0.15, clearcoat: 0.5 }), []);
  const edge = useGlowMat(look.goldLight, 1.2 * glow);
  const ghost = s.params.ghost === true;
  const ghostTex = useMemo(
    () =>
      canvasTexture(1024, 1024, (g) => {
        g.strokeStyle = "rgba(255,226,170,0.9)";
        g.lineWidth = 10;
        g.setLineDash([46, 30]);
        g.strokeRect(8, 8, 1008, 1008);
      }),
    [],
  );
  const ghostMat = useMemo(() => new THREE.MeshBasicMaterial({ map: ghostTex, transparent: true, depthWrite: false, toneMapped: false, opacity: 0.8 }), [ghostTex]);
  const strip = 0.035;
  return (
    <group>
      <mesh position={[0, level / 2, 0]} material={[body, body, top, body, body, body]} castShadow={!mirror} receiveShadow>
        <boxGeometry args={[w, level, d]} />
      </mesh>
      {/* glowing lip around the top edge — reads as "a level" from any angle */}
      <mesh position={[0, level - strip / 2, d / 2 + 0.004]} material={edge}>
        <boxGeometry args={[w + 0.01, strip, strip]} />
      </mesh>
      <mesh position={[0, level - strip / 2, -d / 2 - 0.004]} material={edge}>
        <boxGeometry args={[w + 0.01, strip, strip]} />
      </mesh>
      <mesh position={[w / 2 + 0.004, level - strip / 2, 0]} material={edge}>
        <boxGeometry args={[strip, strip, d + 0.01]} />
      </mesh>
      <mesh position={[-w / 2 - 0.004, level - strip / 2, 0]} material={edge}>
        <boxGeometry args={[strip, strip, d + 0.01]} />
      </mesh>
      {ghost && !mirror && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} material={ghostMat}>
          <planeGeometry args={[w + 0.6, d + 0.6]} />
        </mesh>
      )}
      {label && !mirror && level > 0.25 && <Label text={label} width={Math.min(w * 0.7, 4.4)} color="#FFE2AE" position={[0, level * 0.5, d / 2 + 0.02]} opacity={clamp01((level - 0.25) / 0.3)} />}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// STAIRS / LADDER

export function Stairs({ s, look, mirror }: ActorProps) {
  const steps = Math.max(1, Math.round(num(s.params.steps, 8)));
  const rise = num(s.params.rise, 0.22);
  const run = num(s.params.run, 0.38);
  const width = num(s.params.width, 1.4);
  const L = steps * run;
  const mat = useDarkMat("#1d1916", 0.5, 0.25);
  const nose = useGlowMat(look.goldLight, 0.9 * num(s.params.glow, 0.6));
  return (
    <group>
      {Array.from({ length: steps }, (_, i) => {
        const h = (i + 1) * rise;
        const x = -L / 2 + run * (i + 0.5);
        return (
          <group key={i}>
            <mesh position={[x, h / 2, 0]} material={mat} castShadow={!mirror} receiveShadow>
              <boxGeometry args={[run, h, width]} />
            </mesh>
            <mesh position={[x - run / 2 + 0.02, h + 0.006, 0]} material={nose}>
              <boxGeometry args={[0.03, 0.012, width]} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

export function Ladder({ s, look, mirror }: ActorProps) {
  const h = num(s.params.height, 4);
  const rungs = Math.max(2, Math.round(num(s.params.rungs, 12)));
  const w = num(s.params.width, 0.7);
  const gold = goldMaterials(look.gold).plain;
  return (
    <group>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[(side * w) / 2, h / 2, 0]} material={gold} castShadow={!mirror}>
          <cylinderGeometry args={[0.035, 0.035, h, 16]} />
        </mesh>
      ))}
      {Array.from({ length: rungs }, (_, i) => (
        <mesh key={i} position={[0, ((i + 0.5) / rungs) * h, 0]} rotation={[0, 0, Math.PI / 2]} material={gold} castShadow={!mirror}>
          <cylinderGeometry args={[0.022, 0.022, w, 12]} />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// BALANCE — a scale that tips

function CoinPile({ count, gold }: { count: number; gold: THREE.Material[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const n = Math.min(60, Math.max(0, Math.round(count)));
    const r = rng(7);
    for (let i = 0; i < n; i++) {
      const ring = i % 3;
      const a = r() * Math.PI * 2;
      dummy.position.set(ring ? Math.cos(a) * 0.12 * ring : 0, 0.02 + Math.floor(i / 3) * 0.032, ring ? Math.sin(a) * 0.12 * ring : 0);
      dummy.rotation.set((r() - 0.5) * 0.1, r() * 6, (r() - 0.5) * 0.1);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[smallCoin, gold, 60]} castShadow frustumCulled={false} />;
}

export function Balance({ s, look, mirror }: ActorProps) {
  const left = num(s.params.leftCount, 3);
  const right = num(s.params.rightCount, 8);
  const tilt = s.params.auto === true ? Math.max(-1, Math.min(1, (right - left) / Math.max(1, right + left))) : Math.max(-1, Math.min(1, num(s.params.tilt, 0)));
  const ang = -tilt * d2r(18);
  const gm = goldMaterials(look.gold);
  const goldArr = useMemo(() => [gm.edge, gm.face, gm.face], [gm]);
  const dark = useDarkMat();
  const half = 1.5;
  const H = 1.9;
  const pan = (side: 1 | -1, count: number, label: string) => {
    const ex = Math.cos(ang) * half * side;
    const ey = Math.sin(ang) * half * side;
    return (
      <group position={[ex, H + ey, 0]}>
        {[0, 1, 2].map((k) => {
          const a = (k / 3) * Math.PI * 2;
          const dx = Math.cos(a) * 0.42;
          const dz = Math.sin(a) * 0.42;
          const len = Math.hypot(dx, 0.75, dz);
          return (
            <mesh key={k} position={[dx / 2, -0.375, dz / 2]} quaternion={new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-dx, 0.75, -dz).normalize())} material={gm.plain}>
              <cylinderGeometry args={[0.006, 0.006, len, 6]} />
            </mesh>
          );
        })}
        <group position={[0, -0.78, 0]}>
          <mesh material={gm.plain} castShadow={!mirror} receiveShadow>
            <cylinderGeometry args={[0.5, 0.42, 0.06, 40]} />
          </mesh>
          <group position={[0, 0.03, 0]}>
            <CoinPile count={count} gold={goldArr} />
          </group>
          {label && !mirror && <Label text={label} width={1.3} position={[0, -0.28, 0.5]} />}
        </group>
      </group>
    );
  };
  return (
    <group>
      <mesh position={[0, 0.06, 0]} material={dark} castShadow={!mirror} receiveShadow>
        <cylinderGeometry args={[0.45, 0.55, 0.12, 40]} />
      </mesh>
      <mesh position={[0, H / 2, 0]} material={gm.plain} castShadow={!mirror}>
        <cylinderGeometry args={[0.045, 0.06, H, 16]} />
      </mesh>
      <mesh position={[0, H, 0]} material={gm.plain}>
        <sphereGeometry args={[0.08, 20, 14]} />
      </mesh>
      <mesh position={[0, H, 0]} rotation={[0, 0, ang]} material={gm.plain} castShadow={!mirror}>
        <boxGeometry args={[half * 2, 0.05, 0.07]} />
      </mesh>
      {pan(-1, left, str(s.params.leftLabel))}
      {pan(1, right, str(s.params.rightLabel))}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// DOOR — a door in a frame with light behind it

export function Door({ s, look, mirror }: ActorProps) {
  const open = clamp01(num(s.params.open, 0));
  const w = num(s.params.width, 1.2);
  const h = num(s.params.height, 2.4);
  const glow = num(s.params.glow, 1);
  const frame = useDarkMat("#14110f", 0.4, 0.4);
  const leaf = useDarkMat("#2a231d", 0.45, 0.2);
  const handle = goldMaterials(look.gold).plain;
  const light = useMemo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color("#FFE9C4"), toneMapped: false }), []);
  light.color = new THREE.Color("#FFE9C4").multiplyScalar(0.4 + 2.2 * glow * Math.min(1, open * 2.5));
  const spillTex = radialTexture("rgba(255,226,170,0.9)", "rgba(255,200,120,0)", 256);
  const spill = useMemo(() => new THREE.MeshBasicMaterial({ map: spillTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }), [spillTex]);
  spill.opacity = open * glow;
  const label = str(s.params.label);
  const t = 0.12;
  return (
    <group>
      {/* frame */}
      <mesh position={[-w / 2 - t / 2, h / 2, 0]} material={frame} castShadow={!mirror}>
        <boxGeometry args={[t, h + t, 0.3]} />
      </mesh>
      <mesh position={[w / 2 + t / 2, h / 2, 0]} material={frame} castShadow={!mirror}>
        <boxGeometry args={[t, h + t, 0.3]} />
      </mesh>
      <mesh position={[0, h + t / 2, 0]} material={frame} castShadow={!mirror}>
        <boxGeometry args={[w + 2 * t, t, 0.3]} />
      </mesh>
      {/* the light beyond */}
      <mesh position={[0, h / 2, -0.12]} material={light}>
        <planeGeometry args={[w, h]} />
      </mesh>
      {/* the leaf, hinged at its left edge */}
      <group position={[-w / 2, 0, 0.04]} rotation={[0, -open * d2r(105), 0]}>
        <mesh position={[w / 2, h / 2, 0]} material={leaf} castShadow={!mirror} receiveShadow>
          <boxGeometry args={[w - 0.02, h - 0.02, 0.07]} />
        </mesh>
        <mesh position={[w - 0.14, h * 0.47, 0.06]} material={handle}>
          <sphereGeometry args={[0.045, 16, 12]} />
        </mesh>
      </group>
      {!mirror && open > 0 && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 1.4]} material={spill} scale={[1, 1.8, 1]}>
          <planeGeometry args={[w * 2.2, 2.4]} />
        </mesh>
      )}
      {label && !mirror && <Label text={label} width={Math.max(1.4, w * 1.4)} color="#FFE2AE" position={[0, h + 0.42, 0.16]} />}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// WALLS — closing in

export function Walls({ s, look, mirror }: ActorProps) {
  const closed = clamp01(num(s.params.closed, 0));
  const H = num(s.params.height, 3);
  const L = num(s.params.length, 4);
  const gap = num(s.params.gap, 6) * (1 - 0.82 * ease("EASE_IN_OUT", closed));
  const mat = useDarkMat("#211c18", 0.7, 0.05);
  const line = useGlowMat(look.danger, 0.6 + closed * 1.8);
  return (
    <group>
      {[-1, 1].map((side) => (
        <group key={side} position={[(side * gap) / 2 + side * 0.15, 0, 0]}>
          <mesh position={[0, H / 2, 0]} material={mat} castShadow={!mirror} receiveShadow>
            <boxGeometry args={[0.3, H, L]} />
          </mesh>
          <mesh position={[-side * 0.152, H - 0.08, 0]} material={line}>
            <boxGeometry args={[0.01, 0.03, L]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// WHEEL — hamster wheel / treadmill drum (rotation = integrated speed)

export function Wheel({ s, look, mirror }: ActorProps) {
  const R = num(s.params.radius, 1.4);
  const gold = goldMaterials(look.gold).plain;
  const dark = useDarkMat();
  const rungs = 28;
  const depth = 1.1;
  return (
    <group>
      {/* A-frame stand */}
      {[-1, 1].map((z) => (
        <group key={z} position={[0, 0, (z * (depth / 2 + 0.12))]}>
          <mesh position={[-0.35, R / 2 + 0.05, 0]} rotation={[0, 0, -0.32]} material={dark} castShadow={!mirror}>
            <boxGeometry args={[0.08, R + 0.4, 0.08]} />
          </mesh>
          <mesh position={[0.35, R / 2 + 0.05, 0]} rotation={[0, 0, 0.32]} material={dark} castShadow={!mirror}>
            <boxGeometry args={[0.08, R + 0.4, 0.08]} />
          </mesh>
        </group>
      ))}
      <group position={[0, R + 0.1, 0]} rotation={[0, 0, -s.phase * Math.PI * 2]}>
        {[-1, 1].map((z) => (
          <mesh key={z} position={[0, 0, (z * depth) / 2]} material={gold} castShadow={!mirror}>
            <torusGeometry args={[R, 0.035, 10, 96]} />
          </mesh>
        ))}
        {Array.from({ length: rungs }, (_, i) => {
          const a = (i / rungs) * Math.PI * 2;
          return (
            <mesh key={i} position={[Math.cos(a) * R, Math.sin(a) * R, 0]} rotation={[Math.PI / 2, 0, 0]} material={gold} castShadow={!mirror}>
              <cylinderGeometry args={[0.018, 0.018, depth, 8]} />
            </mesh>
          );
        })}
        {[0, 1, 2].map((k) => (
          <mesh key={k} rotation={[0, 0, (k / 3) * Math.PI]} material={gold}>
            <boxGeometry args={[R * 2, 0.03, 0.03]} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// SNOWBALL — grows as it rolls

export function Snowball({ s, look, mirror }: ActorProps) {
  const r = snowballRadius(num(s.params.growth, 0));
  const gm = goldMaterials(look.gold);
  const mat = useMemo(() => {
    const m = gm.face.clone();
    m.color = new THREE.Color("#F6DCA0");
    m.roughness = 0.35;
    m.normalScale = new THREE.Vector2(0.5, 0.5);
    if (m.normalMap) {
      m.normalMap = m.normalMap.clone();
      m.normalMap.wrapS = m.normalMap.wrapT = THREE.RepeatWrapping;
      m.normalMap.repeat.set(6, 3);
      m.normalMap.needsUpdate = true;
    }
    return m;
  }, [gm]);
  // rolling: the angle is distance / radius (world x drives it)
  const roll = -s.position[0] / Math.max(0.1, r);
  return (
    <mesh position={[0, r, 0]} rotation={[s.position[2] / Math.max(0.1, r), 0, roll]} material={mat} castShadow={!mirror} receiveShadow>
      <sphereGeometry args={[r, 48, 32]} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------------------------
// TREE — compounding growth: branches split and sprout gold coin-leaves

interface Branch {
  from: THREE.Vector3;
  dir: THREE.Vector3;
  len: number;
  rad: number;
  level: number;
}

function buildTree(levels: number, seed: number): Branch[] {
  const r = rng(seed + 31);
  const out: Branch[] = [];
  const grow = (from: THREE.Vector3, dir: THREE.Vector3, len: number, rad: number, level: number) => {
    out.push({ from: from.clone(), dir: dir.clone(), len, rad, level });
    if (level >= levels - 1) return;
    const end = from.clone().addScaledVector(dir, len);
    const kids = level === 0 ? 3 : 2 + (r() > 0.55 ? 1 : 0);
    for (let k = 0; k < kids; k++) {
      const yaw = (k / kids) * Math.PI * 2 + r() * 0.9 + level;
      const pitch = 0.42 + r() * 0.35;
      const d = new THREE.Vector3(Math.sin(pitch) * Math.cos(yaw), Math.cos(pitch), Math.sin(pitch) * Math.sin(yaw)).lerp(dir, 0.35).normalize();
      grow(end, d, len * (0.68 + r() * 0.12), rad * 0.62, level + 1);
    }
  };
  grow(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), 1.3, 0.2, 0);
  return out;
}

const branchGeo = new THREE.CylinderGeometry(0.7, 1, 1, 10, 1);
branchGeo.translate(0, 0.5, 0);
const leafGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.014, 20);

export function Tree({ s, look, seed, mirror }: ActorProps) {
  const levels = Math.max(2, Math.min(7, Math.round(num(s.params.levels, 5))));
  const growth = clamp01(num(s.params.growth, 1));
  const branches = useMemo(() => buildTree(levels, seed), [levels, seed]);
  const bRef = useRef<THREE.InstancedMesh>(null);
  const lRef = useRef<THREE.InstancedMesh>(null);
  const bark = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#3b2a1c"), roughness: 0.55, metalness: 0.5, clearcoat: 0.3 }), []);
  const gm = goldMaterials(look.gold);
  const leaves = s.params.leaves !== false;
  useLayoutEffect(() => {
    const bm = bRef.current;
    const lm = lRef.current;
    if (!bm || !lm) return;
    const g = growth * levels; // how many levels are (partly) grown
    let k = 0;
    let lk = 0;
    const up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion();
    for (const b of branches) {
      const p = clamp01(g - b.level);
      if (p <= 0) continue;
      const e = ease("EASE_OUT", p);
      q.setFromUnitVectors(up, b.dir);
      dummy.position.copy(b.from);
      dummy.quaternion.copy(q);
      dummy.scale.set(b.rad * Math.max(0.3, e), b.len * e, b.rad * Math.max(0.3, e));
      dummy.updateMatrix();
      bm.setMatrixAt(k++, dummy.matrix);
      if (leaves && b.level === levels - 1 && p > 0.4) {
        const end = b.from.clone().addScaledVector(b.dir, b.len * e);
        const lp = ease("SPRING", clamp01((p - 0.4) / 0.6));
        for (let c = 0; c < 3; c++) {
          const a = c * 2.1 + b.len * 13;
          dummy.position.set(end.x + Math.cos(a) * 0.14, end.y + (c - 1) * 0.08, end.z + Math.sin(a) * 0.14);
          dummy.rotation.set(0.6 + c * 0.7, a, 0.3 * c);
          dummy.scale.setScalar(lp);
          dummy.updateMatrix();
          lm.setMatrixAt(lk++, dummy.matrix);
        }
      }
    }
    bm.count = k;
    lm.count = lk;
    bm.instanceMatrix.needsUpdate = true;
    lm.instanceMatrix.needsUpdate = true;
  });
  return (
    <group>
      <instancedMesh ref={bRef} args={[branchGeo, bark, 800]} castShadow={!mirror} receiveShadow frustumCulled={false} />
      <instancedMesh ref={lRef} args={[leafGeo, gm.plain, 2400]} castShadow={!mirror} frustumCulled={false} />
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// BLOCKS — 1, 2, 4, 8 … (doubling)

const blockGeo = new THREE.BoxGeometry(1, 1, 1);

export function blockSlot(i: number): [number, number, number] {
  // fill a growing cube: 2x2 floor, then up, then out
  const layer = Math.floor(i / 16);
  const j = i % 16;
  return [(j % 4) - 1.5, layer, Math.floor(j / 4) - 1.5];
}

export function Blocks({ s, look, mirror }: ActorProps) {
  const gen = Math.max(0, Math.min(8, num(s.params.generations, 3)));
  const size = num(s.params.size, 0.5);
  const ref = useRef<THREE.InstancedMesh>(null);
  const gm = goldMaterials(look.gold);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const whole = Math.floor(gen);
    const frac = gen - whole;
    const have = Math.pow(2, whole);
    const next = Math.min(256, Math.pow(2, whole + 1));
    const n = frac > 0 ? next : have;
    // center the occupied footprint
    let k = 0;
    for (let i = 0; i < Math.min(256, n); i++) {
      const sl = blockSlot(i);
      const born = i >= have ? ease("SPRING", clamp01(frac * 1.4 - ((i - have) / Math.max(1, next - have)) * 0.4)) : 1;
      if (born <= 0.001) continue;
      dummy.position.set(sl[0] * size * 1.06, (sl[1] + 0.5) * size * 1.06, sl[2] * size * 1.06);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(size * born);
      dummy.updateMatrix();
      m.setMatrixAt(k++, dummy.matrix);
    }
    m.count = k;
    m.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[blockGeo, gm.plain, 256]} castShadow={!mirror} receiveShadow frustumCulled={false} />;
}

// ---------------------------------------------------------------------------------------------
// BUCKET — fills with gold, leaks through holes

export function Bucket({ s, look, mirror }: ActorProps) {
  const R = num(s.params.radius, 0.8);
  const H = num(s.params.height, 1.2);
  const fill = clamp01(num(s.params.fill, 0.6));
  const leaks = Math.max(0, Math.min(6, Math.round(num(s.params.leaks, 3))));
  const inflow = clamp01(num(s.params.inflow, 0));
  const bucketGeo = useMemo(() => {
    const pts = [new THREE.Vector2(R * 0.78, 0), new THREE.Vector2(R * 0.78, 0.02), new THREE.Vector2(R, H), new THREE.Vector2(R * 0.97, H), new THREE.Vector2(R * 0.75, 0.04), new THREE.Vector2(0, 0.04)];
    return new THREE.LatheGeometry(pts, 64);
  }, [R, H]);
  const metal = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#3a3430"), metalness: 0.85, roughness: 0.35, side: THREE.DoubleSide }), []);
  const gm = goldMaterials(look.gold);
  const goldArr = useMemo(() => [gm.edge, gm.face, gm.face], [gm]);
  const fy = 0.04 + fill * (H - 0.08);
  const rAt = R * 0.75 + (R - R * 0.75) * (fy / H);
  const flyRef = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = flyRef.current;
    if (!m) return;
    let k = 0;
    const t = s.time;
    const per = 10;
    if (fill > 0.03) {
      for (let h = 0; h < leaks; h++) {
        const a = (h / Math.max(1, leaks)) * Math.PI * 1.2 - 0.6 + Math.PI / 2;
        const hy = 0.18 + (h % 2) * 0.12;
        const hr = R * 0.78 + (R - R * 0.78) * (hy / H);
        for (let c = 0; c < per; c++) {
          const u = (t * 0.9 + c / per + h * 0.37) % 1;
          const v = 0.9;
          const x = Math.cos(a) * (hr + u * v);
          const z = Math.sin(a) * (hr + u * v);
          const y = hy - 4.9 * Math.pow(u * 0.55, 2) * 1.2;
          if (y < 0.02) continue;
          dummy.position.set(x, y, z);
          dummy.rotation.set(u * 9, a, u * 5);
          dummy.scale.setScalar(0.7);
          dummy.updateMatrix();
          m.setMatrixAt(k++, dummy.matrix);
        }
      }
    }
    if (inflow > 0) {
      for (let c = 0; c < 16; c++) {
        const u = (t * 1.2 + c / 16) % 1;
        const y = H + 2.2 - u * (2.2 + H - fy);
        dummy.position.set(Math.sin(c * 2.3) * 0.08, y, Math.cos(c * 1.7) * 0.08);
        dummy.rotation.set(u * 7 + c, c, u * 3);
        dummy.scale.setScalar(0.8 * inflow);
        dummy.updateMatrix();
        m.setMatrixAt(k++, dummy.matrix);
      }
    }
    m.count = k;
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <group>
      <mesh geometry={bucketGeo} material={metal} castShadow={!mirror} receiveShadow />
      <mesh position={[0, H, 0]} rotation={[Math.PI / 2, 0, 0]} material={gm.plain}>
        <torusGeometry args={[R * 0.985, 0.025, 8, 64]} />
      </mesh>
      {fill > 0.01 && (
        <mesh position={[0, fy, 0]} rotation={[-Math.PI / 2, 0, 0]} material={gm.face}>
          <circleGeometry args={[rAt * 0.97, 48]} />
        </mesh>
      )}
      <instancedMesh ref={flyRef} args={[smallCoin, goldArr, 90]} castShadow={!mirror} frustumCulled={false} />
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// HOURGLASS

export function Hourglass({ s, look, mirror }: ActorProps) {
  const H = num(s.params.height, 1.6);
  const p = clamp01(num(s.params.progress, 0));
  const half = H / 2 - 0.08;
  const bulbR = H * 0.24;
  const glassGeo = useMemo(() => {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 32; i++) {
      const y = (i / 32) * 2 - 1; // -1..1
      const r = 0.03 + bulbR * Math.pow(Math.abs(y), 0.7) * (1 - Math.pow(Math.abs(y), 6) * 0.25);
      pts.push(new THREE.Vector2(r, y * half));
    }
    return new THREE.LatheGeometry(pts, 48);
  }, [bulbR, half]);
  const glass = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#d8e4ea"), roughness: 0.05, metalness: 0, transparent: true, opacity: 0.22, clearcoat: 1, envMapIntensity: 2.2, depthWrite: false, side: THREE.DoubleSide }), []);
  const sand = useMemo(() => new THREE.MeshStandardMaterial({ color: new THREE.Color(look.goldLight), roughness: 0.8, emissive: new THREE.Color(look.goldDeep), emissiveIntensity: 0.15 }), [look]);
  const wood = goldMaterials(look.gold).plain;
  const topH = (1 - p) * half * 0.8;
  const botH = p * half * 0.75;
  return (
    <group position={[0, H / 2, 0]}>
      {topH > 0.01 && (
        <mesh position={[0, 0.04 + topH / 2, 0]} rotation={[Math.PI, 0, 0]} material={sand}>
          <coneGeometry args={[bulbR * 0.86 * Math.pow(topH / (half * 0.8), 0.6), topH, 40]} />
        </mesh>
      )}
      {botH > 0.01 && (
        <mesh position={[0, -half + 0.02 + botH / 2, 0]} material={sand}>
          <coneGeometry args={[bulbR * 0.95, botH, 40]} />
        </mesh>
      )}
      {p > 0.002 && p < 0.998 && (
        <mesh position={[0, -half / 2 + 0.02, 0]} material={sand}>
          <cylinderGeometry args={[0.012, 0.012, half, 8]} />
        </mesh>
      )}
      <mesh geometry={glassGeo} material={glass} renderOrder={4} />
      {[-1, 1].map((y) => (
        <mesh key={y} position={[0, y * (half + 0.05), 0]} material={wood} castShadow={!mirror}>
          <cylinderGeometry args={[bulbR + 0.08, bulbR + 0.08, 0.08, 40]} />
        </mesh>
      ))}
      {[0, 1, 2].map((k) => {
        const a = (k / 3) * Math.PI * 2;
        return (
          <mesh key={k} position={[Math.cos(a) * (bulbR + 0.03), 0, Math.sin(a) * (bulbR + 0.03)]} material={wood} castShadow={!mirror}>
            <cylinderGeometry args={[0.022, 0.022, half * 2 + 0.1, 10]} />
          </mesh>
        );
      })}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// CHAIN — links that snap

const linkGeo = new THREE.TorusGeometry(0.16, 0.035, 10, 28);

export function Chain({ s, look, seed, mirror }: ActorProps) {
  const links = Math.max(4, Math.min(40, Math.round(num(s.params.links, 14))));
  const L = num(s.params.length, 5);
  const Hy = num(s.params.height, 1.2);
  const broken = clamp01(num(s.params.broken, 0));
  const ref = useRef<THREE.InstancedMesh>(null);
  const metal = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#8d8a86"), metalness: 1, roughness: 0.32 }), []);
  const dark = useDarkMat();
  const flash = useGlowMat(look.goldLight, 3 * Math.max(0, 1 - broken * 3) * (broken > 0 ? 1 : 0));
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const r = rng(seed + 9);
    const mid = Math.floor(links / 2);
    const b = ease("EASE_OUT", broken);
    for (let i = 0; i < links; i++) {
      const u = links === 1 ? 0.5 : i / (links - 1);
      let x = -L / 2 + u * L;
      // slight sag
      let y = Hy - Math.sin(u * Math.PI) * 0.18;
      let z = 0;
      let rx = i % 2 ? Math.PI / 2 : 0;
      let rz = 0;
      if (broken > 0) {
        const side = i < mid ? -1 : 1;
        const dist = Math.abs(i - mid + 0.5) / (links / 2);
        // halves swing down from their anchors; the links nearest the break fly most
        const swing = b * (1 - dist) * 1.2;
        x += side * b * 0.5 * (1 - dist);
        y -= swing * 1.1 + (1 - dist) * b * 0.4;
        z += (r() - 0.5) * b * 0.6 * (1 - dist);
        rx += b * (r() - 0.5) * 3 * (1 - dist);
        rz += b * side * 0.8 * (1 - dist);
        if (i === mid || i === mid - 1) {
          x += side * b * 1.4;
          y += b * 0.8 - 4.9 * b * b * 0.5;
          rz += b * 9 * side;
        }
      }
      dummy.position.set(x, Math.max(0.05, y), z);
      dummy.rotation.set(rx, 0, rz);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    }
    m.count = links;
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <group>
      <instancedMesh ref={ref} args={[linkGeo, metal, 40]} castShadow={!mirror} frustumCulled={false} />
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * (L / 2 + 0.15), Hy / 2 + 0.1, 0]} material={dark} castShadow={!mirror}>
          <boxGeometry args={[0.18, Hy + 0.2, 0.18]} />
        </mesh>
      ))}
      {broken > 0 && broken < 0.35 && !mirror && (
        <mesh position={[0, Hy - 0.18, 0]} material={flash}>
          <sphereGeometry args={[0.12 + broken, 16, 12]} />
        </mesh>
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// FORK_PATH — two futures

function roadRibbon(points: THREE.Vector3[], width: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let acc = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[Math.min(points.length - 1, i + 1)]!;
    const o = points[Math.max(0, i - 1)]!;
    const dir = new THREE.Vector3().subVectors(q, o).setY(0).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(width / 2);
    if (i > 0) acc += p.distanceTo(points[i - 1]!);
    pos.push(p.x - side.x, p.y, p.z - side.z, p.x + side.x, p.y, p.z + side.z);
    uv.push(0, acc, 1, acc);
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function forkPaths(length: number): { trunk: THREE.Vector3[]; left: THREE.Vector3[]; right: THREE.Vector3[] } {
  const trunk: THREE.Vector3[] = [];
  const left: THREE.Vector3[] = [];
  const right: THREE.Vector3[] = [];
  const half = length / 2;
  for (let i = 0; i <= 16; i++) trunk.push(new THREE.Vector3(0, 0.02, half - (i / 16) * half));
  for (let i = 0; i <= 32; i++) {
    const u = i / 32;
    const z = -u * half;
    const x = Math.sin(u * Math.PI * 0.5) * half * 0.55;
    left.push(new THREE.Vector3(-x, 0.021, z));
    right.push(new THREE.Vector3(x, 0.021, z));
  }
  return { trunk, left, right };
}

export function ForkPath({ s, look, mirror }: ActorProps) {
  const length = num(s.params.length, 14);
  const progress = clamp01(num(s.params.progress, 0));
  const choose = str(s.params.choose, "NONE");
  const paths = useMemo(() => forkPaths(length), [length]);
  const geos = useMemo(() => ({ trunk: roadRibbon(paths.trunk, 1.6), left: roadRibbon(paths.left, 1.3), right: roadRibbon(paths.right, 1.3) }), [paths]);
  const roadTex = useMemo(
    () =>
      canvasTexture(64, 512, (g) => {
        g.fillStyle = "#16120f";
        g.fillRect(0, 0, 64, 512);
        g.fillStyle = "rgba(243,196,106,0.85)";
        g.fillRect(0, 0, 3, 512);
        g.fillRect(61, 0, 3, 512);
        g.fillStyle = "rgba(245,241,234,0.25)";
        for (let y = 0; y < 512; y += 64) g.fillRect(30, y, 4, 32);
      }),
    [],
  );
  roadTex.wrapT = THREE.RepeatWrapping;
  roadTex.repeat.set(1, 0.25);
  const road = useMemo(() => new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.7, emissive: new THREE.Color("#ffffff"), emissiveMap: roadTex, emissiveIntensity: 0.9, side: THREE.DoubleSide }), [roadTex]);
  const glow = useGlowMat(look.goldLight, 2.2);
  const dim = useMemo(() => {
    const m = road.clone();
    m.emissiveIntensity = 0.06;
    m.color = new THREE.Color("#666");
    return m;
  }, [road]);
  // light travels the trunk, then the chosen branch
  const along = (pts: THREE.Vector3[], u: number) => pts[Math.min(pts.length - 1, Math.max(0, Math.round(u * (pts.length - 1))))]!;
  const lightPos = progress < 0.4 ? along(paths.trunk, progress / 0.4) : choose === "LEFT" ? along(paths.left, (progress - 0.4) / 0.6) : choose === "RIGHT" ? along(paths.right, (progress - 0.4) / 0.6) : along(paths.trunk, 1);
  const half = length / 2;
  return (
    <group>
      <mesh geometry={geos.trunk} material={road} receiveShadow />
      <mesh geometry={geos.left} material={choose === "RIGHT" && progress > 0.4 ? dim : road} receiveShadow />
      <mesh geometry={geos.right} material={choose === "LEFT" && progress > 0.4 ? dim : road} receiveShadow />
      {progress > 0 && !mirror && (
        <mesh position={[lightPos.x, 0.25, lightPos.z]} material={glow}>
          <sphereGeometry args={[0.18, 20, 14]} />
        </mesh>
      )}
      {!mirror && <Label text={str(s.params.leftLabel)} width={3} position={[-half * 0.55, 1.4, -half - 0.2]} color={choose === "RIGHT" ? "#8a857e" : "#FFE2AE"} />}
      {!mirror && <Label text={str(s.params.rightLabel)} width={3} position={[half * 0.55, 1.4, -half - 0.2]} color={choose === "LEFT" ? "#8a857e" : "#FFE2AE"} />}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// DOCUMENT + MAGNIFIER — the fine print

export function DocumentPage({ s, look, mirror }: ActorProps) {
  const title = str(s.params.title, "AGREEMENT");
  const lines = Math.max(2, Math.min(18, Math.round(num(s.params.lines, 10))));
  const fine = str(s.params.fine);
  const reveal = clamp01(num(s.params.reveal, 0));
  const tex = useMemo(
    () =>
      canvasTexture(700, 950, (g) => {
        g.fillStyle = "#F3EEE4";
        g.fillRect(0, 0, 700, 950);
        g.fillStyle = "#1b1814";
        g.font = "700 46px Inter, sans-serif";
        g.textAlign = "left";
        g.fillText(title, 60, 100);
        g.fillStyle = "rgba(30,26,22,0.32)";
        const r = rng(title.length * 13);
        for (let i = 0; i < lines; i++) g.fillRect(60, 160 + i * 52, 580 * (0.55 + r() * 0.45), 14);
        g.fillStyle = "rgba(30,26,22,0.55)";
        g.font = "400 15px Inter, sans-serif";
        g.fillText(fine, 60, 880);
        g.fillStyle = "rgba(30,26,22,0.6)";
        g.fillRect(400, 820, 220, 2);
      }),
    [title, lines, fine],
  );
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }), [tex]);
  const hl = useGlowMat(look.goldLight, 1.5 * reveal);
  return (
    <group position={[0, 0.95, 0]} rotation={[d2r(-12), 0, 0]}>
      <mesh material={mat} castShadow={!mirror} receiveShadow>
        <boxGeometry args={[1.4, 1.9, 0.01]} />
      </mesh>
      {reveal > 0 && !mirror && (
        <mesh position={[-0.12, -0.78, 0.008]} material={hl}>
          <planeGeometry args={[1.0 * reveal, 0.008]} />
        </mesh>
      )}
    </group>
  );
}

export function Magnifier({ s, look, mirror }: ActorProps) {
  const size = num(s.params.size, 0.6);
  const reveal = clamp01(num(s.params.reveal, 0));
  const text = str(s.params.text);
  const gold = goldMaterials(look.gold).plain;
  const lens = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#e8f0f4"), roughness: 0.02, transparent: true, opacity: 0.18, clearcoat: 1, envMapIntensity: 2.5, depthWrite: false }), []);
  const tex = useMemo(
    () =>
      canvasTexture(512, 512, (g) => {
        g.clearRect(0, 0, 512, 512);
        g.fillStyle = "#F3EEE4";
        g.beginPath();
        g.arc(256, 256, 250, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#1b1814";
        g.textAlign = "center";
        g.textBaseline = "middle";
        const words = text.split(/\s+/);
        const linesOut: string[] = [];
        let cur = "";
        g.font = "700 46px Inter, sans-serif";
        for (const w of words) {
          const next = cur ? `${cur} ${w}` : w;
          if (g.measureText(next).width > 360 && cur) {
            linesOut.push(cur);
            cur = w;
          } else cur = next;
        }
        if (cur) linesOut.push(cur);
        linesOut.slice(0, 5).forEach((l, i, arr) => g.fillText(l, 256, 256 + (i - (arr.length - 1) / 2) * 56));
      }),
    [text],
  );
  const inner = useMemo(() => new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }), [tex]);
  inner.opacity = reveal;
  return (
    <group scale={size / 0.6}>
      <mesh material={gold} castShadow={!mirror}>
        <torusGeometry args={[0.6, 0.05, 16, 80]} />
      </mesh>
      <mesh position={[0.62, -0.62, 0]} rotation={[0, 0, Math.PI / 4]} material={gold} castShadow={!mirror}>
        <cylinderGeometry args={[0.055, 0.07, 0.9, 16]} />
      </mesh>
      {text && !mirror && reveal > 0 && (
        <mesh position={[0, 0, -0.01]} material={inner} scale={0.5 + 0.5 * ease("EASE_OUT", reveal)}>
          <circleGeometry args={[0.58, 64]} />
        </mesh>
      )}
      <mesh material={lens} renderOrder={6}>
        <circleGeometry args={[0.58, 64]} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// RECEIPT — unrolls out of a printer

export function Receipt({ s, look, mirror }: ActorProps) {
  const items = strArr(s.params.items);
  const total = str(s.params.total);
  const unroll = clamp01(num(s.params.unroll, 0));
  const rows = items.length + (total ? 2 : 0) + 2;
  const fullLen = 0.5 + rows * 0.34;
  const W = 1.4;
  const tex = useMemo(
    () =>
      canvasTexture(440, Math.round(fullLen * 400), (g) => {
        const H = g.canvas.height;
        g.fillStyle = "#F7F3EA";
        g.fillRect(0, 0, 440, H);
        g.fillStyle = "#1b1814";
        g.font = "600 34px 'Inter', monospace";
        // reads top-down from the roll; unrolling reveals the lines below
        const row = (i: number) => 110 + i * 136;
        items.forEach((it, i) => {
          const [a, b] = it.split("|");
          g.textAlign = "left";
          g.fillText(a ?? "", 30, row(i));
          g.textAlign = "right";
          g.fillText(b ?? "", 410, row(i));
        });
        if (total) {
          g.fillRect(30, row(items.length) - 60, 380, 3);
          g.font = "800 44px Inter, sans-serif";
          g.textAlign = "left";
          g.fillText("TOTAL", 30, row(items.length + 0.6));
          g.textAlign = "right";
          g.fillStyle = "#9a6a1a";
          g.fillText(total, 410, row(items.length + 0.6));
        }
        // zigzag tear edge at the tip
        g.fillStyle = "rgba(0,0,0,0)";
      }),
    [items, total, fullLen],
  );
  const vis = Math.max(0.02, unroll * fullLen);
  tex.repeat.set(1, vis / fullLen);
  tex.offset.set(0, 1 - vis / fullLen);
  tex.needsUpdate = true;
  const paper = useMemo(() => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, side: THREE.DoubleSide }), [tex]);
  const dark = useDarkMat("#18151a", 0.35, 0.5);
  const top = 2.9;
  const slot = useGlowMat(look.goldLight, 0.8);
  return (
    <group>
      <mesh position={[0, top + 0.2, -0.1]} material={dark} castShadow={!mirror}>
        <boxGeometry args={[W + 0.35, 0.4, 0.6]} />
      </mesh>
      <mesh position={[0, top + 0.01, 0.2]} material={slot}>
        <boxGeometry args={[W + 0.04, 0.015, 0.02]} />
      </mesh>
      <mesh position={[0, top - vis / 2, 0.19]} material={paper} castShadow={!mirror}>
        <planeGeometry args={[W, vis]} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// CALENDAR — pages flip

export function Calendar({ s, look, mirror }: ActorProps) {
  const labels = strArr(s.params.labels);
  const page = Math.max(0, num(s.params.page, 0));
  const idx = Math.floor(page);
  const frac = page - idx;
  const lab = (i: number) => (labels.length ? labels[((i % labels.length) + labels.length) % labels.length]! : String(i + 1));
  const pageTex = (text: string) =>
    textTexture([{ text, font: "800 200px 'Inter Display', Inter, sans-serif", color: "#1b1814", y: 300 }], 512, 512, (g) => {
      g.fillStyle = "#F4EFE6";
      g.fillRect(0, 0, 512, 512);
      g.fillStyle = look.gold;
      g.fillRect(0, 0, 512, 90);
    });
  const cur = useMemo(() => new THREE.MeshStandardMaterial({ map: pageTex(lab(idx)), roughness: 0.85, side: THREE.DoubleSide }), [idx, labels.join("|")]);
  const nxt = useMemo(() => new THREE.MeshStandardMaterial({ map: pageTex(lab(idx + 1)), roughness: 0.85 }), [idx, labels.join("|")]);
  const curFront = useMemo(() => new THREE.MeshStandardMaterial({ map: cur.map, roughness: 0.85, side: THREE.FrontSide }), [cur]);
  const back = useMemo(() => new THREE.MeshStandardMaterial({ color: new THREE.Color("#E9E3D8"), roughness: 0.9, side: THREE.BackSide }), []);
  const dark = useDarkMat();
  const W = 1.0;
  const H = 1.0;
  const flip = ease("EASE_IN_OUT", frac);
  return (
    <group position={[0, 0.1, 0]} rotation={[d2r(-14), 0, 0]}>
      <mesh position={[0, H / 2, -0.05]} material={dark} castShadow={!mirror}>
        <boxGeometry args={[W + 0.1, H + 0.12, 0.08]} />
      </mesh>
      <mesh position={[0, H / 2, 0]} material={frac > 0 ? nxt : cur}>
        <planeGeometry args={[W, H]} />
      </mesh>
      {frac > 0 && (
        <group position={[0, H, 0.01]} rotation={[-flip * Math.PI * 0.95, 0, 0]}>
          <mesh position={[0, -H / 2, 0]} material={curFront}>
            <planeGeometry args={[W, H]} />
          </mesh>
          <mesh position={[0, -H / 2, 0]} material={back}>
            <planeGeometry args={[W, H]} />
          </mesh>
        </group>
      )}
      {[-0.3, 0, 0.3].map((x) => (
        <mesh key={x} position={[x, H + 0.04, 0.02]} rotation={[0, 0, Math.PI / 2]} material={goldMaterials(look.gold).plain}>
          <torusGeometry args={[0.05, 0.012, 8, 20]} />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// GAUGE (dial) / METER (tube)

export function Gauge({ s, look, mirror }: ActorProps) {
  const value = clamp01(num(s.params.value, 0));
  const label = str(s.params.label);
  const face = useMemo(
    () =>
      canvasTexture(512, 512, (g) => {
        g.fillStyle = "#14110f";
        g.beginPath();
        g.arc(256, 256, 250, 0, Math.PI * 2);
        g.fill();
        const a0 = Math.PI * 0.75;
        const a1 = Math.PI * 2.25;
        for (let i = 0; i <= 40; i++) {
          const a = a0 + ((a1 - a0) * i) / 40;
          const big = i % 5 === 0;
          g.strokeStyle = i > 32 ? "#EE6B52" : "#F3C46A";
          g.lineWidth = big ? 7 : 3;
          g.beginPath();
          g.moveTo(256 + Math.cos(a) * (big ? 180 : 200), 256 + Math.sin(a) * (big ? 180 : 200));
          g.lineTo(256 + Math.cos(a) * 225, 256 + Math.sin(a) * 225);
          g.stroke();
        }
        g.fillStyle = "#A7A39C";
        g.font = "600 30px Inter, sans-serif";
        g.textAlign = "center";
        g.fillText(str(s.params.low), 140, 430);
        g.fillText(str(s.params.high), 372, 430);
      }),
    [s.params.low, s.params.high],
  );
  const faceMat = useMemo(() => new THREE.MeshStandardMaterial({ map: face, roughness: 0.5, emissive: new THREE.Color("#ffffff"), emissiveMap: face, emissiveIntensity: 0.5 }), [face]);
  const gold = goldMaterials(look.gold).plain;
  const needle = useGlowMat(value > 0.8 ? look.danger : look.goldLight, 1.6);
  const ang = d2r(135) - value * d2r(270);
  return (
    <group position={[0, 1.25, 0]}>
      <mesh material={gold} rotation={[Math.PI / 2, 0, 0]} castShadow={!mirror}>
        <cylinderGeometry args={[1.05, 1.05, 0.12, 64]} />
      </mesh>
      <mesh rotation={[0, 0, 0]} position={[0, 0, 0.065]} material={faceMat}>
        <circleGeometry args={[0.98, 64]} />
      </mesh>
      <group position={[0, 0, 0.09]} rotation={[0, 0, ang - Math.PI / 2]}>
        <mesh position={[0.36, 0, 0]} material={needle}>
          <boxGeometry args={[0.78, 0.035, 0.02]} />
        </mesh>
      </group>
      <mesh position={[0, 0, 0.1]} material={gold}>
        <sphereGeometry args={[0.07, 16, 12]} />
      </mesh>
      <mesh position={[0, -0.85, -0.1]} material={gold} castShadow={!mirror}>
        <cylinderGeometry args={[0.05, 0.08, 0.6, 12]} />
      </mesh>
      {label && !mirror && <Label text={label} width={2.0} position={[0, -1.35, 0.1]} />}
    </group>
  );
}

export function Meter({ s, look, mirror }: ActorProps) {
  const value = clamp01(num(s.params.value, 0));
  const H = num(s.params.height, 3);
  const label = str(s.params.label);
  const glass = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#dfe8ec"), roughness: 0.04, transparent: true, opacity: 0.2, clearcoat: 1, envMapIntensity: 2.5, depthWrite: false }), []);
  const liquid = useGlowMat(value > 0.85 ? look.danger : look.goldLight, 0.9);
  const dark = useDarkMat();
  const lh = Math.max(0.001, value * (H - 0.2));
  return (
    <group>
      <mesh position={[0, 0.1, 0]} material={dark} castShadow={!mirror}>
        <cylinderGeometry args={[0.45, 0.5, 0.2, 40]} />
      </mesh>
      <mesh position={[0, 0.2 + lh / 2, 0]} material={liquid}>
        <cylinderGeometry args={[0.2, 0.2, lh, 32]} />
      </mesh>
      <mesh position={[0, 0.2 + (H - 0.2) / 2, 0]} material={glass} renderOrder={4}>
        <cylinderGeometry args={[0.26, 0.26, H - 0.2, 40, 1, true]} />
      </mesh>
      {Array.from({ length: 9 }, (_, i) => (
        <mesh key={i} position={[0.27, 0.2 + ((i + 1) / 10) * (H - 0.2), 0.05]} material={liquid}>
          <boxGeometry args={[0.08, 0.012, 0.012]} />
        </mesh>
      ))}
      {label && !mirror && <Label text={label} width={2.0} position={[0, H + 0.3, 0]} />}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// DIVIDER — before / after

export function Divider({ s, look, mirror }: ActorProps) {
  const H = num(s.params.height, 4);
  const L = num(s.params.length, 10);
  const wallTex = useMemo(
    () =>
      canvasTexture(64, 256, (g) => {
        const gr = g.createLinearGradient(0, 0, 0, 256);
        gr.addColorStop(0, "rgba(255,226,170,0)");
        gr.addColorStop(0.5, "rgba(255,226,170,0.9)");
        gr.addColorStop(1, "rgba(255,226,170,0.3)");
        g.fillStyle = gr;
        g.fillRect(0, 0, 64, 256);
      }),
    [],
  );
  const wall = useMemo(() => new THREE.MeshBasicMaterial({ map: wallTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }), [wallTex]);
  const cool = useMemo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color("#0c1a24"), transparent: true, opacity: 0.55, depthWrite: false }), []);
  const warm = useMemo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color("#2a1a08"), transparent: true, opacity: 0.45, depthWrite: false }), []);
  const line = useGlowMat(look.goldLight, 2);
  if (mirror) return null;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-L / 4, 0.006, 0]} material={cool}>
        <planeGeometry args={[L / 2, L]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[L / 4, 0.006, 0]} material={warm}>
        <planeGeometry args={[L / 2, L]} />
      </mesh>
      <mesh position={[0, H / 2, 0]} rotation={[0, Math.PI / 2, 0]} material={wall}>
        <planeGeometry args={[L, H]} />
      </mesh>
      <mesh position={[0, 0.01, 0]} material={line}>
        <boxGeometry args={[0.03, 0.02, L]} />
      </mesh>
      <Label text={str(s.params.leftLabel)} width={2.2} position={[-L / 5, H * 0.85, 1]} color="#9fb4c2" />
      <Label text={str(s.params.rightLabel)} width={2.2} position={[L / 5, H * 0.85, 1]} color="#FFE2AE" />
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// HOUSE / PHONE / BANK_CARD

export function House({ s, look, seed, mirror }: ActorProps) {
  const size = num(s.params.size, 1);
  const glow = num(s.params.glow, 0.8);
  const color = str(s.params.color, "#2A2622");
  const win = windowTexture(2, 3, seed);
  const wall = useMemo(() => new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.55, metalness: 0.2, emissive: new THREE.Color("#FFD8A0"), emissiveMap: win }), [color, win]);
  wall.emissiveIntensity = 1.1 * glow;
  const roofMat = useDarkMat("#141112", 0.45, 0.4);
  const trim = goldMaterials(look.gold).plain;
  const roofGeo = useMemo(() => {
    const sh = new THREE.Shape();
    sh.moveTo(-1.15, 0);
    sh.lineTo(0, 0.85);
    sh.lineTo(1.15, 0);
    sh.lineTo(-1.15, 0);
    const g = new THREE.ExtrudeGeometry(sh, { depth: 1.9, bevelEnabled: false });
    g.translate(0, 0, -0.95);
    return g;
  }, []);
  const door = useGlowMat("#FFCF8A", 0.6 * glow);
  return (
    <group scale={size}>
      <mesh position={[0, 0.65, 0]} material={wall} castShadow={!mirror} receiveShadow>
        <boxGeometry args={[2, 1.3, 1.7]} />
      </mesh>
      <mesh geometry={roofGeo} position={[0, 1.3, 0]} material={roofMat} castShadow={!mirror} />
      <mesh position={[0, 1.31, 0.86]} material={trim}>
        <boxGeometry args={[2.1, 0.03, 0.03]} />
      </mesh>
      <mesh position={[0.55, 1.7, -0.3]} material={roofMat} castShadow={!mirror}>
        <boxGeometry args={[0.22, 0.6, 0.22]} />
      </mesh>
      <mesh position={[-0.55, 0.38, 0.852]} material={door}>
        <planeGeometry args={[0.36, 0.72]} />
      </mesh>
    </group>
  );
}

export function Phone({ s, look, mirror }: ActorProps) {
  const text = str(s.params.text);
  const sub = str(s.params.sub);
  const glow = num(s.params.glow, 1);
  const body = useMemo(() => {
    const g = new THREE.ExtrudeGeometry(roundedRect(0.78, 1.6, 0.12), { depth: 0.07, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 3, curveSegments: 12 });
    g.translate(0, 0, -0.035);
    return g;
  }, []);
  const metal = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#1b1a1e"), metalness: 0.9, roughness: 0.25, clearcoat: 1 }), []);
  const screenTex = useMemo(
    () =>
      canvasTexture(390, 800, (g) => {
        const gr = g.createLinearGradient(0, 0, 0, 800);
        gr.addColorStop(0, "#1a1530");
        gr.addColorStop(1, "#08070c");
        g.fillStyle = gr;
        g.fillRect(0, 0, 390, 800);
        g.fillStyle = "#000";
        g.fillRect(150, 22, 90, 26);
        g.textAlign = "center";
        g.fillStyle = look.goldLight;
        g.font = "800 72px 'Inter Display', Inter, sans-serif";
        g.fillText(text, 195, 380);
        g.fillStyle = "#F5F1EA";
        g.font = "600 30px Inter, sans-serif";
        g.fillText(sub, 195, 440);
      }),
    [text, sub, look.goldLight],
  );
  const screen = useMemo(() => new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false }), [screenTex]);
  screen.color.setScalar(0.55 + 0.6 * glow);
  return (
    <group position={[0, 0.82, 0]} rotation={[d2r(-8), 0, 0]}>
      <mesh geometry={body} material={metal} castShadow={!mirror} />
      <mesh position={[0, 0, 0.052]} material={screen}>
        <planeGeometry args={[0.72, 1.5]} />
      </mesh>
    </group>
  );
}

export function BankCard({ s, look, mirror }: ActorProps) {
  const label = str(s.params.label);
  const last4 = str(s.params.last4, "4821");
  const color = str(s.params.color, "#17141C");
  const body = useMemo(() => {
    const g = new THREE.ExtrudeGeometry(roundedRect(1.71, 1.08, 0.08), { depth: 0.02, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2 });
    g.translate(0, 0, -0.01);
    return g;
  }, []);
  const mat = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), metalness: 0.6, roughness: 0.3, clearcoat: 1 }), [color]);
  const faceTex = useMemo(
    () =>
      canvasTexture(856, 540, (g) => {
        g.clearRect(0, 0, 856, 540);
        g.strokeStyle = "rgba(243,196,106,0.25)";
        g.lineWidth = 2;
        for (let i = -540; i < 856; i += 28) {
          g.beginPath();
          g.moveTo(i, 540);
          g.lineTo(i + 540, 0);
          g.stroke();
        }
        g.fillStyle = "#F5F1EA";
        g.font = "600 44px Inter, sans-serif";
        g.textAlign = "left";
        g.fillText(`•••• •••• •••• ${last4}`, 60, 380);
        g.font = "700 36px Inter, sans-serif";
        g.fillStyle = look.goldLight;
        g.fillText(label, 60, 470);
      }),
    [label, last4, look.goldLight],
  );
  const face = useMemo(() => new THREE.MeshBasicMaterial({ map: faceTex, transparent: true, toneMapped: false }), [faceTex]);
  const chip = goldMaterials(look.gold).plain;
  return (
    <group position={[0, 0.62, 0]} rotation={[d2r(-10), 0, 0]}>
      <mesh geometry={body} material={mat} castShadow={!mirror} />
      <mesh position={[0, 0, 0.0141]} material={face}>
        <planeGeometry args={[1.71, 1.08]} />
      </mesh>
      <mesh position={[-0.52, 0.12, 0.016]} material={chip}>
        <boxGeometry args={[0.26, 0.2, 0.01]} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// Charts as sculptures

export function BarChart({ s, look, mirror }: ActorProps) {
  const values = numArr(s.params.values);
  const labels = strArr(s.params.labels);
  const progress = clamp01(num(s.params.progress, 1));
  const spacing = num(s.params.spacing, 1.2);
  const maxH = num(s.params.maxHeight, 4);
  const hi = Math.round(num(s.params.highlight, -1));
  const max = Math.max(1e-6, ...values.map(Math.abs));
  const gm = goldMaterials(look.gold);
  const hiMat = useGlowMat(look.goldLight, 0.35);
  const dimMat = useDarkMat("#3a332c", 0.4, 0.6);
  const n = values.length;
  return (
    <group>
      {values.map((v, i) => {
        const p = ease("EASE_OUT", clamp01((progress * (n + 2) - i) / 3));
        const h = Math.max(0.001, (Math.abs(v) / max) * maxH * p);
        const x = (i - (n - 1) / 2) * spacing;
        const m = hi === i ? hiMat : hi >= 0 ? dimMat : gm.plain;
        return (
          <group key={i} position={[x, 0, 0]}>
            <mesh position={[0, h / 2, 0]} material={m} castShadow={!mirror} receiveShadow>
              <boxGeometry args={[spacing * 0.62, h, spacing * 0.62]} />
            </mesh>
            {labels[i] && !mirror && <Label text={labels[i]!} width={spacing * 0.95} position={[0, -0.01, spacing * 0.5]} rotation={[-Math.PI / 2.6, 0, 0]} />}
          </group>
        );
      })}
    </group>
  );
}

export function LineChart({ s, look, mirror }: ActorProps) {
  const values = numArr(s.params.values);
  const progress = clamp01(num(s.params.progress, 1));
  const W = num(s.params.width, 8);
  const maxH = num(s.params.maxHeight, 3);
  const max = Math.max(1e-6, ...values);
  const q = Math.round(progress * 60) / 60;
  const geo = useMemo(() => {
    if (values.length < 2 || q <= 0) return null;
    const pts = values.map((v, i) => new THREE.Vector3(-W / 2 + (i / (values.length - 1)) * W, 0.15 + (v / max) * maxH, 0));
    const curve = new THREE.CatmullRomCurve3(pts);
    const part = new THREE.CatmullRomCurve3(curve.getPoints(80).slice(0, Math.max(2, Math.round(81 * q))));
    return new THREE.TubeGeometry(part, 120, 0.06, 10, false);
  }, [values.join(","), W, maxH, max, q]);
  const glow = useGlowMat(look.goldLight, 1.4);
  const grid = useMemo(
    () =>
      canvasTexture(512, 256, (g) => {
        g.strokeStyle = "rgba(245,241,234,0.12)";
        g.lineWidth = 2;
        for (let y = 0; y <= 4; y++) {
          g.beginPath();
          g.moveTo(0, 8 + y * 60);
          g.lineTo(512, 8 + y * 60);
          g.stroke();
        }
      }),
    [],
  );
  const gridMat = useMemo(() => new THREE.MeshBasicMaterial({ map: grid, transparent: true, depthWrite: false, toneMapped: false }), [grid]);
  return (
    <group>
      {!mirror && (
        <mesh position={[0, maxH / 2 + 0.15, -0.3]} material={gridMat}>
          <planeGeometry args={[W + 0.6, maxH + 0.3]} />
        </mesh>
      )}
      {geo && <mesh geometry={geo} material={glow} castShadow={!mirror} />}
    </group>
  );
}

export function PieChart({ s, look, mirror }: ActorProps) {
  const values = numArr(s.params.values);
  const labels = strArr(s.params.labels);
  const progress = clamp01(num(s.params.progress, 1));
  const R = num(s.params.radius, 1.5);
  const explode = Math.round(num(s.params.explode, -1));
  const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const colors = [look.gold, "#8F76FF", "#2BB3A8", "#EE6B52", "#A7A39C", look.goldDeep];
  const qp = Math.round(progress * 90) / 90;
  const slices = useMemo(() => {
    let a = 0;
    return values.map((v) => {
      const span = (Math.max(0, v) / total) * Math.PI * 2 * qp;
      const sh = new THREE.Shape();
      const a0 = a;
      const a1 = a + span;
      sh.absarc(0, 0, R, a0, a1, false);
      sh.absarc(0, 0, R * 0.48, a1, a0, true);
      a = a1;
      const g = span > 0.001 ? new THREE.ExtrudeGeometry(sh, { depth: 0.35, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2, curveSegments: 48 }) : null;
      return { g, mid: (a0 + a1) / 2 };
    });
  }, [values.join(","), R, qp, total]);
  const mats = useMemo(() => colors.map((c) => new THREE.MeshPhysicalMaterial({ color: new THREE.Color(c), metalness: 0.5, roughness: 0.3, clearcoat: 0.6 })), [colors.join("|")]);
  return (
    <group position={[0, 0.25, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      {slices.map((sl, i) =>
        sl.g ? (
          <group key={i} position={explode === i ? [Math.cos(sl.mid) * 0.35, Math.sin(sl.mid) * 0.35, 0] : [0, 0, 0]}>
            <mesh geometry={sl.g} material={mats[i % mats.length]} castShadow={!mirror} receiveShadow />
            {labels[i] && !mirror && <Label text={labels[i]!} width={1.4} position={[Math.cos(sl.mid) * R * 0.74, Math.sin(sl.mid) * R * 0.74, 0.42]} />}
          </group>
        ) : null,
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// TEXT_3D — words standing in the world (layered planes read as an extrusion)

export function Text3D({ s, look, mirror }: ActorProps) {
  const text = str(s.params.text);
  const size = num(s.params.size, 1);
  const style = str(s.params.style, "GOLD");
  const reveal = clamp01(num(s.params.reveal, 1));
  const front = style === "NEON" ? "#FFF3DC" : style === "STONE" ? "#C9C2B8" : look.goldLight;
  const side = style === "NEON" ? "#E5A94A" : style === "STONE" ? "#3a3530" : "#6b4a17";
  const font = style === "STONE" ? "400 200px 'DM Serif Display', serif" : "800 200px 'Inter Display', Inter, sans-serif";
  const measure = useMemo(() => {
    const c = document.createElement("canvas").getContext("2d")!;
    c.font = font;
    return Math.max(1, c.measureText(text).width);
  }, [text, font]);
  const W = Math.ceil(measure + 60);
  const H = 260;
  const frontTex = textTexture([{ text, font, color: front, y: H / 2 + 10 }], W, H);
  const sideTex = textTexture([{ text, font, color: side, y: H / 2 + 10 }], W, H);
  const fMat = useMemo(() => new THREE.MeshBasicMaterial({ map: frontTex, transparent: true, depthWrite: false, toneMapped: style !== "NEON", side: THREE.DoubleSide }), [frontTex, style]);
  const sMat = useMemo(() => new THREE.MeshBasicMaterial({ map: sideTex, transparent: true, depthWrite: false, side: THREE.DoubleSide }), [sideTex]);
  fMat.opacity = reveal;
  sMat.opacity = reveal;
  const w = (size * W) / (H * 0.62);
  const h = size / 0.62;
  if (!text || mirror) return null;
  const layers = 9;
  const depth = size * 0.18;
  const rise = (1 - ease("EASE_OUT", reveal)) * -0.4 * size;
  return (
    <group position={[0, h / 2 + rise, 0]}>
      {Array.from({ length: layers }, (_, i) => (
        <mesh key={i} position={[0, 0, -depth + (i / layers) * depth]} material={sMat} renderOrder={5 + i}>
          <planeGeometry args={[w, h]} />
        </mesh>
      ))}
      <mesh position={[0, 0, 0.002]} material={fMat} renderOrder={20}>
        <planeGeometry args={[w, h]} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// ARROW — trend up / down

export function Arrow({ s, look, mirror }: ActorProps) {
  const up = str(s.params.direction, "UP") !== "DOWN";
  const growth = clamp01(num(s.params.growth, 1));
  const L = num(s.params.length, 4) * Math.max(0.05, ease("EASE_OUT", growth));
  const geo = useMemo(() => {
    const sh = new THREE.Shape();
    const w = 0.22;
    const hw = 0.55;
    const hl = 0.8;
    const shaft = Math.max(0.05, L - hl);
    sh.moveTo(-w, 0);
    sh.lineTo(w, 0);
    sh.lineTo(w, shaft);
    sh.lineTo(hw, shaft);
    sh.lineTo(0, shaft + hl);
    sh.lineTo(-hw, shaft);
    sh.lineTo(-w, shaft);
    sh.lineTo(-w, 0);
    return new THREE.ExtrudeGeometry(sh, { depth: 0.3, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 3 });
  }, [L]);
  const gm = goldMaterials(look.gold);
  const red = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color(look.danger), metalness: 0.6, roughness: 0.3, clearcoat: 1 }), [look.danger]);
  // tilted like a chart trend: 35° off vertical
  return (
    <group position={[up ? -L * 0.25 : L * 0.25, up ? 0.2 : L * 0.85, -0.15]} rotation={[0, 0, up ? d2r(-35) : d2r(180 + 35)]}>
      <mesh geometry={geo} material={up ? gm.plain : red} castShadow={!mirror} />
    </group>
  );
}
