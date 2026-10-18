import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { rng } from "../../ease";
import type { LookDef } from "../../looks";
import { windowTexture } from "./materials";

/**
 * Set dressing for the v1.1 sets (the floor, cyclorama, haze and dust are shared with the
 * studio): CITY_NIGHT adds a distant procedural skyline, ROOM a minimal interior (back wall, a
 * tall window of light, a skirting line), HORIZON an open plain with a glowing horizon band.
 */

const box = new THREE.BoxGeometry(1, 1, 1);
box.translate(0, 0.5, 0);
const dummy = new THREE.Object3D();

export function Skyline({ seed, look }: { seed: number; look: LookDef }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const towers = useMemo(() => {
    const r = rng(seed + 77);
    return Array.from({ length: 140 }, (_, i) => {
      const a = -Math.PI * 0.95 + (i / 140) * Math.PI * 1.9 + (r() - 0.5) * 0.02;
      const dist = 38 + r() * 26;
      return { x: Math.sin(a) * dist, z: -Math.cos(a) * dist, w: 2 + r() * 4, d: 2 + r() * 4, h: 4 + Math.pow(r(), 2.2) * 26 };
    });
  }, [seed]);
  const win = windowTexture(24, 8, seed + 3);
  const mat = useMemo(() => {
    const t = win.clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
    return new THREE.MeshStandardMaterial({ color: new THREE.Color("#0d0b0c"), roughness: 0.9, emissive: new THREE.Color("#FFD8A0"), emissiveMap: t, emissiveIntensity: 0.55, fog: true });
  }, [win]);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    towers.forEach((tw, i) => {
      dummy.position.set(tw.x, 0, tw.z);
      dummy.rotation.set(0, Math.atan2(tw.x, -tw.z), 0);
      dummy.scale.set(tw.w, tw.h, tw.d);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.count = towers.length;
    m.instanceMatrix.needsUpdate = true;
  });
  void look;
  return <instancedMesh ref={ref} args={[box, mat, 140]} frustumCulled={false} />;
}

export function Room({ look }: { look: LookDef }) {
  const wall = useMemo(() => new THREE.MeshStandardMaterial({ color: new THREE.Color("#1c1714"), roughness: 0.92 }), []);
  const windowLight = useMemo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color("#FFE7C2").multiplyScalar(1.6), toneMapped: false }), []);
  const mullion = useMemo(() => new THREE.MeshStandardMaterial({ color: new THREE.Color("#0c0a09"), roughness: 0.6 }), []);
  const trim = useMemo(() => new THREE.MeshStandardMaterial({ color: new THREE.Color(look.goldDeep), metalness: 1, roughness: 0.4 }), [look.goldDeep]);
  return (
    <group>
      <mesh position={[0, 4, -7]} material={wall} receiveShadow>
        <planeGeometry args={[30, 8]} />
      </mesh>
      <mesh position={[-9, 4, 0]} rotation={[0, Math.PI / 2, 0]} material={wall} receiveShadow>
        <planeGeometry args={[18, 8]} />
      </mesh>
      <mesh position={[3.2, 3.1, -6.98]} material={windowLight}>
        <planeGeometry args={[2.6, 3.8]} />
      </mesh>
      <mesh position={[3.2, 3.1, -6.96]} material={mullion}>
        <boxGeometry args={[0.06, 3.8, 0.02]} />
      </mesh>
      <mesh position={[3.2, 3.1, -6.96]} material={mullion}>
        <boxGeometry args={[2.6, 0.06, 0.02]} />
      </mesh>
      <mesh position={[0, 0.08, -6.97]} material={trim}>
        <boxGeometry args={[30, 0.04, 0.03]} />
      </mesh>
    </group>
  );
}

export function HorizonGlow({ look }: { look: LookDef }) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        transparent: true,
        blending: THREE.AdditiveBlending,
        uniforms: { uGlow: { value: new THREE.Color(look.goldLight) }, uSky: { value: new THREE.Color("#2a1d3d") } },
        vertexShader: "varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }",
        fragmentShader:
          "uniform vec3 uGlow; uniform vec3 uSky; varying vec3 vW; void main(){ vec3 d = normalize(vW); float h = d.y;" +
          " float band = exp(-pow(h*14.0, 2.0)); float sky = smoothstep(0.0, 0.5, h);" +
          " vec3 c = uGlow*band*0.55 + uSky*sky*0.35; gl_FragColor = vec4(c, 1.0); }",
      }),
    [look.goldLight],
  );
  return (
    <mesh material={mat} renderOrder={-9} frustumCulled={false}>
      <sphereGeometry args={[110, 48, 24]} />
    </mesh>
  );
}
