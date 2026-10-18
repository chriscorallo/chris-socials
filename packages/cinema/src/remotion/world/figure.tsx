import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { rng } from "../../ease";
import { skeletonFor, type Skeleton } from "../../figure-poses";
import type { ActorProps } from "./actors";

/**
 * FIGURE — a faceless, stylized "artist's mannequin": matte ceramic body, gold ball joints.
 * Deliberately abstract (no face, no hair, no clothing, no likeness of anyone) so it reads as
 * "a person / you" in a metaphor without pretending to be a character. Every limb is a group
 * whose rotation comes from the pure skeleton (src/figure-poses.ts). Height ≈ params.height.
 */

const d2r = (d: number) => (d * Math.PI) / 180;
const v3 = (a: [number, number, number]): [number, number, number] => [d2r(a[0]), d2r(a[1]), d2r(a[2])];

const GEO = {
  thigh: new THREE.CapsuleGeometry(0.075, 0.34, 6, 16),
  shin: new THREE.CapsuleGeometry(0.06, 0.36, 6, 16),
  upperArm: new THREE.CapsuleGeometry(0.052, 0.22, 6, 14),
  forearm: new THREE.CapsuleGeometry(0.045, 0.2, 6, 14),
  hand: new THREE.CapsuleGeometry(0.04, 0.06, 4, 10),
  foot: new THREE.CapsuleGeometry(0.045, 0.16, 4, 10),
  chest: new THREE.CapsuleGeometry(0.15, 0.2, 8, 20),
  pelvis: new THREE.CapsuleGeometry(0.13, 0.06, 8, 20),
  neck: new THREE.CylinderGeometry(0.045, 0.05, 0.1, 14),
  head: new THREE.SphereGeometry(0.1, 28, 20),
  joint: new THREE.SphereGeometry(1, 16, 12),
};

export function useFigureMaterials(color: string, accent: string) {
  return useMemo(
    () => ({
      body: new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), roughness: 0.48, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.5, sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color("#FFE9C8") }),
      joint: new THREE.MeshPhysicalMaterial({ color: new THREE.Color(accent), metalness: 1, roughness: 0.28, envMapIntensity: 1.6 }),
    }),
    [color, accent],
  );
}

function Joint({ r, m }: { r: number; m: THREE.Material }) {
  return <mesh geometry={GEO.joint} material={m} scale={r} castShadow />;
}

/** The posed mannequin in its own local space (feet at y = 0, facing +Z), 1.8 m tall. */
export function Mannequin({ sk, mats, mirror }: { sk: Skeleton; mats: { body: THREE.Material; joint: THREE.Material }; mirror?: boolean }) {
  const b = mats.body;
  const j = mats.joint;
  const shadow = !mirror;
  const leg = (side: 1 | -1) => {
    const hip = side === 1 ? sk.lHip : sk.rHip;
    const knee = side === 1 ? sk.lKnee : sk.rKnee;
    const ankle = side === 1 ? sk.lAnkle : sk.rAnkle;
    return (
      <group position={[0.1 * side, -0.04, 0]} rotation={v3(hip)}>
        <Joint r={0.068} m={j} />
        <mesh geometry={GEO.thigh} material={b} position={[0, -0.23, 0]} castShadow={shadow} />
        <group position={[0, -0.45, 0]} rotation={[d2r(knee), 0, 0]}>
          <Joint r={0.056} m={j} />
          <mesh geometry={GEO.shin} material={b} position={[0, -0.22, 0]} castShadow={shadow} />
          <group position={[0, -0.44, 0]} rotation={[d2r(ankle), 0, 0]}>
            <mesh geometry={GEO.foot} material={b} position={[0, -0.03, 0.06]} rotation={[Math.PI / 2, 0, 0]} castShadow={shadow} />
          </group>
        </group>
      </group>
    );
  };
  const arm = (side: 1 | -1) => {
    const sh = side === 1 ? sk.lShoulder : sk.rShoulder;
    const el = side === 1 ? sk.lElbow : sk.rElbow;
    return (
      <group position={[0.205 * side, 0.43, 0]} rotation={v3(sh)}>
        <Joint r={0.06} m={j} />
        <mesh geometry={GEO.upperArm} material={b} position={[0, -0.16, 0]} castShadow={shadow} />
        <group position={[0, -0.31, 0]} rotation={[d2r(el), 0, 0]}>
          <Joint r={0.048} m={j} />
          <mesh geometry={GEO.forearm} material={b} position={[0, -0.15, 0]} castShadow={shadow} />
          <mesh geometry={GEO.hand} material={b} position={[0, -0.33, 0]} castShadow={shadow} />
        </group>
      </group>
    );
  };
  return (
    // pelvis at 0.98 m; legs are ~0.98 m long to the sole
    <group position={[0, 0.98 + sk.rootY, 0]} rotation={[d2r(sk.lean), 0, 0]}>
      <mesh geometry={GEO.pelvis} material={b} scale={[1.15, 1, 0.82]} castShadow={shadow} />
      {leg(1)}
      {leg(-1)}
      <group position={[0, 0.06, 0]} rotation={v3(sk.spine)}>
        <Joint r={0.07} m={j} />
        <mesh geometry={GEO.chest} material={b} position={[0, 0.26, 0]} scale={[1.18, 1, 0.78]} castShadow={shadow} />
        {arm(1)}
        {arm(-1)}
        <mesh geometry={GEO.neck} material={b} position={[0, 0.5, 0]} castShadow={shadow} />
        <group position={[0, 0.55, 0]} rotation={v3(sk.head)}>
          <mesh geometry={GEO.head} material={b} position={[0, 0.1, 0.01]} scale={[0.98, 1.22, 1.06]} castShadow={shadow} />
        </group>
      </group>
    </group>
  );
}

export function Figure({ s, mirror }: ActorProps) {
  const h = typeof s.params.height === "number" ? s.params.height : 1.8;
  const mats = useFigureMaterials(String(s.params.color ?? "#E9E2D6"), String(s.params.accent ?? "#E5A94A"));
  const sk = skeletonFor(s);
  return (
    <group scale={h / 1.8}>
      <Mannequin sk={sk} mats={mats} mirror={mirror} />
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// CROWD — many simple figures (2 instanced meshes) + one highlighted full mannequin

const crowdBody = new THREE.CapsuleGeometry(0.17, 0.82, 6, 14);
const crowdHead = new THREE.SphereGeometry(0.11, 16, 12);
const crowdDummy = new THREE.Object3D();

export function crowdLayout(count: number, spacing: number, seed: number): Array<[number, number, number]> {
  const r = rng(seed + 404);
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * 1.6)));
  const rows = Math.ceil(count / cols);
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const row = Math.floor(i / cols);
    out.push([(c - (cols - 1) / 2) * spacing + (r() - 0.5) * spacing * 0.5, (r() - 0.5) * 0.06, (row - (rows - 1) / 2) * spacing * 0.9 + (r() - 0.5) * spacing * 0.4]);
  }
  return out;
}

export function Crowd({ s, seed, mirror }: ActorProps) {
  const count = Math.max(1, Math.min(400, Math.round(typeof s.params.count === "number" ? s.params.count : 40)));
  const spacing = typeof s.params.spacing === "number" ? s.params.spacing : 0.9;
  const highlight = typeof s.params.highlight === "number" ? Math.round(s.params.highlight) : -1;
  const layout = useMemo(() => crowdLayout(count, spacing, seed), [count, spacing, seed]);
  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const headRef = useRef<THREE.InstancedMesh>(null);
  const mat = useMemo(() => new THREE.MeshPhysicalMaterial({ color: new THREE.Color(String(s.params.color ?? "#5B5650")), roughness: 0.6, sheen: 0.3, clearcoat: 0.1 }), [s.params.color]);
  const hiMats = useFigureMaterials(String(s.params.highlightColor ?? "#F3C46A"), "#FFF1D6");
  useLayoutEffect(() => {
    const bm = bodyRef.current;
    const hm = headRef.current;
    if (!bm || !hm) return;
    let k = 0;
    layout.forEach((p, i) => {
      if (i === highlight) return;
      const sway = Math.sin(s.time * 1.1 + i * 1.7) * 0.03;
      crowdDummy.position.set(p[0], 0.58 + p[1], p[2]);
      crowdDummy.rotation.set(0, 0, sway);
      crowdDummy.scale.setScalar(1);
      crowdDummy.updateMatrix();
      bm.setMatrixAt(k, crowdDummy.matrix);
      crowdDummy.position.set(p[0] - sway * 1.2, 1.32 + p[1], p[2]);
      crowdDummy.updateMatrix();
      hm.setMatrixAt(k, crowdDummy.matrix);
      k++;
    });
    bm.count = k;
    hm.count = k;
    bm.instanceMatrix.needsUpdate = true;
    hm.instanceMatrix.needsUpdate = true;
  });
  const hp = highlight >= 0 && highlight < layout.length ? layout[highlight]! : null;
  const sk = skeletonFor(s);
  return (
    <group>
      <instancedMesh ref={bodyRef} args={[crowdBody, mat, 400]} castShadow={!mirror} receiveShadow frustumCulled={false} />
      <instancedMesh ref={headRef} args={[crowdHead, mat, 400]} castShadow={!mirror} frustumCulled={false} />
      {hp && (
        <group position={[hp[0], 0, hp[2]]}>
          <Mannequin sk={sk} mats={hiMats} mirror={mirror} />
        </group>
      )}
    </group>
  );
}
