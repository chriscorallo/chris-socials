import { useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { rng } from "../../ease";
import type { FrameState } from "../../evaluate";
import type { LookDef } from "../../looks";
import { ACTOR_COMPONENTS, presence } from "./actors";
import { radialTexture, studioEnvironment } from "./materials";
import { PostFX } from "./post";
import { HorizonGlow, Room, Skyline } from "./sets";

/**
 * One frame of the 3D world: set (floor, cyclorama, haze, dust), lights, camera, actors (+ their
 * floor reflections) and post. Everything comes from `FrameState`; nothing here keeps time.
 */

export type Tier = "DRAFT" | "PREVIEW" | "FINAL";

export function CameraRig({ c }: { c: FrameState["camera"] }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  useLayoutEffect(() => {
    camera.position.set(...c.position);
    camera.up.set(0, 1, 0);
    camera.lookAt(...c.lookAt);
    camera.rotateZ(c.roll);
    camera.fov = c.fov;
    camera.near = 0.05;
    camera.far = 300;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  });
  return null;
}

function Lights({ l, look, quality }: { l: FrameState["lights"]; look: LookDef; quality: number }) {
  const key = useRef<THREE.SpotLight>(null);
  const rim = useRef<THREE.SpotLight>(null);
  const top = useRef<THREE.SpotLight>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  const scene = useThree((s) => s.scene);
  useLayoutEffect(() => {
    target.position.set(...l.focus);
    target.updateMatrixWorld();
    for (const r of [key, rim, top]) if (r.current) r.current.target = target;
    if (!target.parent) scene.add(target);
  });
  const I = l.intensity;
  const f = l.focus;
  const shadowSize = quality >= 1 ? 2048 : 1024;
  return (
    <>
      <hemisphereLight args={[new THREE.Color(look.cream), new THREE.Color("#000000"), l.ambient * 6 * I]} />
      <spotLight
        ref={key}
        position={[f[0] + l.key.position[0], f[1] + l.key.position[1], f[2] + l.key.position[2]]}
        color={l.key.color}
        intensity={l.key.intensity * 1.6 * I}
        angle={0.42}
        penumbra={1}
        decay={0}
        castShadow
        shadow-mapSize-width={shadowSize}
        shadow-mapSize-height={shadowSize}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-radius={6}
        shadow-camera-near={1}
        shadow-camera-far={40}
      />
      <spotLight ref={rim} position={[f[0] + l.rim.position[0], f[1] + l.rim.position[1], f[2] + l.rim.position[2]]} color={l.rim.color} intensity={l.rim.intensity * 1.5 * I} angle={0.7} penumbra={1} decay={0} />
      <pointLight position={[f[0] + l.fill.position[0], f[1] + l.fill.position[1], f[2] + l.fill.position[2]]} color={l.fill.color} intensity={l.fill.intensity * 2 * I} decay={0} />
      <spotLight ref={top} position={[f[0], f[1] + 7.5, f[2] + 0.6]} color={l.spot.color} intensity={l.spot.intensity * 0.04 * I} angle={l.spot.angle} penumbra={l.spot.penumbra} decay={0} />
    </>
  );
}

/** Background sweep: a huge back-side sphere with a vertical falloff + a warm glow behind the subject. */
function Cyclorama({ look, glow, focus, kind }: { look: LookDef; glow: number; focus: [number, number, number]; kind: string }) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { uBg: { value: new THREE.Color(look.background) }, uGlow: { value: new THREE.Color(look.backGlowColor) }, uAmt: { value: glow }, uFocus: { value: new THREE.Vector3() }, uTeal: { value: kind === "NUMBERS_VOID" ? 1 : 0 } },
        vertexShader: "varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }",
        fragmentShader:
          "uniform vec3 uBg; uniform vec3 uGlow; uniform float uAmt; uniform vec3 uFocus; uniform float uTeal; varying vec3 vW;\n" +
          "void main(){ vec3 d = normalize(vW - uFocus); float h = clamp(d.y*0.5+0.5,0.0,1.0);\n" +
          " float back = pow(clamp(-d.z*0.6+0.55,0.0,1.0),2.0); float band = exp(-pow((h-0.47)*5.0,2.0));\n" +
          " vec3 c = uBg * (0.7 + 0.6*h); c += uGlow * uAmt * band * (0.35 + back*0.9);\n" +
          " gl_FragColor = vec4(c,1.0); }",
      }),
    [look, kind],
  );
  mat.uniforms.uAmt!.value = glow;
  (mat.uniforms.uFocus!.value as THREE.Vector3).set(...focus);
  return (
    <mesh material={mat} renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[120, 48, 24]} />
    </mesh>
  );
}

function Floor({ look, gloss, kind }: { look: LookDef; gloss: number; kind: string }) {
  const mat = useMemo(() => {
    const m = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(look.floor), roughness: 0.8, metalness: 0.0, specularIntensity: 0.2, envMapIntensity: 0.1, transparent: true, opacity: 1 - gloss * 0.3 });
    return m;
  }, [look, gloss]);
  const grid = useMemo(() => {
    if (kind !== "NUMBERS_VOID") return null;
    const c = document.createElement("canvas");
    c.width = 1024;
    c.height = 1024;
    const g = c.getContext("2d")!;
    g.strokeStyle = "rgba(43,179,168,0.35)";
    g.lineWidth = 2;
    for (let i = 0; i <= 64; i++) {
      const p = (i / 64) * 1024;
      g.beginPath();
      g.moveTo(p, 0);
      g.lineTo(p, 1024);
      g.stroke();
      g.beginPath();
      g.moveTo(0, p);
      g.lineTo(1024, p);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [kind]);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={mat} renderOrder={1}>
        <circleGeometry args={[60, 96]} />
      </mesh>
      {grid && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]} renderOrder={2}>
          <planeGeometry args={[64, 64]} />
          <meshBasicMaterial map={grid} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

function Dust({ amount, seed, time, focus, color }: { amount: number; seed: number; time: number; focus: [number, number, number]; color: string }) {
  const N = Math.round(260 * amount);
  const ref = useRef<THREE.Points>(null);
  const base = useMemo(() => {
    const r = rng(seed + 5);
    return Array.from({ length: 400 }, () => ({ x: (r() - 0.5) * 14, y: r() * 7, z: (r() - 0.5) * 12, s: 0.2 + r() * 0.8, p: r() * 10 }));
  }, [seed]);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(400 * 3), 3));
    return g;
  }, []);
  const mat = useMemo(() => new THREE.PointsMaterial({ map: radialTexture("rgba(255,236,200,1)", "rgba(255,220,170,0)", 64), color: new THREE.Color(color).multiplyScalar(1.4), size: 0.035, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.7 }), [color]);
  useLayoutEffect(() => {
    const a = geo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < 400; i++) {
      const b = base[i]!;
      if (i >= N) {
        a.setXYZ(i, 0, -999, 0);
        continue;
      }
      const t = time * 0.12 * b.s + b.p;
      a.setXYZ(i, focus[0] + b.x + Math.sin(t) * 0.3, ((b.y + time * 0.05 * b.s) % 7) + Math.sin(t * 1.3) * 0.1, focus[2] + b.z + Math.cos(t * 0.7) * 0.3);
    }
    a.needsUpdate = true;
  });
  return <points ref={ref} geometry={geo} material={mat} frustumCulled={false} />;
}

function Shadowblob({ x, z, r, opacity }: { x: number; z: number; r: number; opacity: number }) {
  const tex = radialTexture("rgba(0,0,0,0.85)", "rgba(0,0,0,0)", 128);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.004, z]} renderOrder={3}>
      <planeGeometry args={[r * 2, r * 2]} />
      <meshBasicMaterial map={tex} transparent depthWrite={false} opacity={opacity} />
    </mesh>
  );
}

function Actors({ state, look, seed, quality, mirror }: { state: FrameState; look: LookDef; seed: number; quality: number; mirror?: boolean }) {
  return (
    <>
      {state.actors.map((s) => {
        const C = ACTOR_COMPONENTS[s.kind];
        if (!C) return null;
        const p = presence(s);
        if (p.hidden) return null;
        if (mirror && (s.kind === "BASELINE" || s.kind === "LIGHT_SHAFT" || s.kind === "NUMBER_WALL" || s.kind === "FORK_PATH" || s.kind === "DIVIDER" || s.kind === "TEXT_3D")) return null;
        return (
          <group key={s.id} position={[s.position[0], s.position[1] + p.y, s.position[2]]} rotation={s.rotation} scale={s.scale * p.scale}>
            <C s={s} look={look} seed={seed + s.id.length * 131} mirror={mirror} quality={quality} />
          </group>
        );
      })}
    </>
  );
}

/** Soft contact shadow under grounded objects (radius, meters at scale 1). */
const BLOB_RADIUS: Partial<Record<string, number>> = { COIN_STACK: 1.4, CAR: 1.5, BUILDING: 1.6, PEDESTAL: 1.4, FIGURE: 0.45, HOUSE: 1.6, BUCKET: 1.0, HOURGLASS: 0.6, BALANCE: 0.8, METER: 0.6, SNOWBALL: 0.9 };

export function World({ state, look, seed, tier }: { state: FrameState; look: LookDef; seed: number; tier: Tier }) {
  const { gl, scene } = useThree();
  const quality = tier === "FINAL" ? 1 : tier === "PREVIEW" ? 0.75 : 0.5;
  useLayoutEffect(() => {
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFShadowMap;
    scene.environment = studioEnvironment(gl, look.lights.KEY_RIM!.key.color, look.accent);
    scene.environmentIntensity = state.lights.env * state.lights.intensity;
    const haze = state.set.haze ?? 0.35;
    scene.fog = new THREE.FogExp2(new THREE.Color(look.fog), 0.012 + haze * 0.035);
    scene.background = new THREE.Color(look.background);
  });
  const gloss = state.set.floorGloss ?? 0.6;
  const focus = state.lights.focus;
  return (
    <>
      <CameraRig c={state.camera} />
      <Lights l={state.lights} look={look} quality={quality} />
      <Cyclorama look={look} glow={state.lights.backGlow} focus={focus} kind={state.set.kind} />
      <Floor look={look} gloss={gloss} kind={state.set.kind} />
      {state.set.kind === "CITY_NIGHT" && <Skyline seed={seed} look={look} />}
      {state.set.kind === "ROOM" && <Room look={look} />}
      {state.set.kind === "HORIZON" && <HorizonGlow look={look} />}
      {gloss > 0 && (
        <group scale={[1, -1, 1]} position={[0, -0.006, 0]}>
          <Actors state={state} look={look} seed={seed} quality={quality} mirror />
        </group>
      )}
      <Actors state={state} look={look} seed={seed} quality={quality} />
      {state.actors
        .filter((a) => a.visible && a.kind in BLOB_RADIUS && a.position[1] < 0.05)
        .map((a) => (
          <Shadowblob key={`sh-${a.id}`} x={a.position[0]} z={a.position[2]} r={BLOB_RADIUS[a.kind]! * a.scale * presence(a).scale} opacity={0.75} />
        ))}
      {(state.set.particles ?? 0) > 0 && <Dust amount={state.set.particles ?? 0} seed={seed} time={state.time} focus={focus} color={look.goldLight} />}
      <PostFX state={state} tier={tier} />
    </>
  );
}

