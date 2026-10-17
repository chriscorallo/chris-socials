import { useMemo, type CSSProperties, type ReactNode } from "react";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EASE_IN_OUT, EASE_OUT, SPRINGS, clamp01, countUp, prog, springAt } from "../motion";
import { FONT, TEXT_LIFT, compactNumber, formatNumber, mix, rgba, withUnit, type Palette } from "../theme";
import { gradientText } from "./text";
import type { TemplateComponentProps } from "./types";
import { hitBuildLength } from "./hit-timing";
import { stackCountFor } from "../../timing";

/**
 * Real 3D (three.js through @remotion/three): procedurally modeled objects, PBR materials,
 * studio three-point lighting plus a PMREM "room" environment for believable metal
 * reflections, a soft contact shadow, and a slow camera/object drift. Frame-driven only —
 * every transform is a pure function of the frame, so renders are deterministic.
 */

const fill: CSSProperties = { position: "absolute", inset: 0 };

// ------------------------------------------------------------------ shared scene pieces
function StudioEnvironment() {
  const { gl, scene } = useThree();
  // Synchronous (not an effect) so the very first captured frame already has reflections.
  useMemo(() => {
    const pm = new THREE.PMREMGenerator(gl);
    scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.85;
    pm.dispose();
  }, [gl, scene]);
  return null;
}

function StudioLights({ p }: { p: Palette }) {
  return (
    <>
      <ambientLight intensity={0.22} />
      {/* key: warm, high front-right */}
      <directionalLight position={[3.5, 4.5, 5]} intensity={2.4} color="#FFF4E0" />
      {/* rim: tinted with the palette's secondary, behind-left — the cinematic edge light */}
      <directionalLight position={[-4.5, 2.5, -3.5]} intensity={3.2} color={mix(p.secondary, "#FFFFFF", 0.35)} />
      {/* fill: soft, low front-left */}
      <directionalLight position={[-3.5, -1, 4]} intensity={0.55} color="#DDE6FF" />
      <pointLight position={[0, -2.5, 2]} intensity={6} distance={8} color={mix(p.primary, "#FFFFFF", 0.4)} />
    </>
  );
}

let shadowTex: THREE.Texture | null = null;
function contactShadowTexture(): THREE.Texture {
  if (shadowTex) return shadowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, "rgba(0,0,0,0.55)");
  grd.addColorStop(0.45, "rgba(0,0,0,0.25)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  shadowTex = new THREE.CanvasTexture(c);
  return shadowTex;
}

function ContactShadow({ y, scale, opacity = 1 }: { y: number; scale: [number, number]; opacity?: number }) {
  const tex = useMemo(() => contactShadowTexture(), []);
  return (
    <mesh position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={-1}>
      <planeGeometry args={[scale[0], scale[1]]} />
      <meshBasicMaterial map={tex} transparent opacity={opacity} depthWrite={false} />
    </mesh>
  );
}

function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Rounded slab centered on the origin (depth along z), with a soft bevel. */
function roundedSlab(w: number, h: number, depth: number, r: number, bevel = 0.03): THREE.ExtrudeGeometry {
  const g = new THREE.ExtrudeGeometry(roundedRectShape(w - 2 * bevel, h - 2 * bevel, Math.max(0.001, r - bevel)), {
    depth: Math.max(0.001, depth - 2 * bevel),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 5,
    curveSegments: 16,
  });
  g.translate(0, 0, -(depth - 2 * bevel) / 2);
  return g;
}

function useMaterials(p: Palette) {
  return useMemo(() => {
    const metal = (color: string, roughness = 0.26) => new THREE.MeshPhysicalMaterial({ color, metalness: 1, roughness, clearcoat: 0.4, clearcoatRoughness: 0.2 });
    return {
      gold: metal(mix(p.primary, "#C8901A", 0.25)),
      goldBright: metal(mix(p.primary, "#FFFFFF", 0.15), 0.16),
      silver: metal("#D8DCE4", 0.2),
      accent: new THREE.MeshPhysicalMaterial({ color: p.secondary, metalness: 0.25, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.12 }),
      accentDeep: new THREE.MeshPhysicalMaterial({ color: mix(p.secondary, "#1A1030", 0.45), metalness: 0.35, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.1 }),
      ceramic: new THREE.MeshPhysicalMaterial({ color: "#F3F3F6", metalness: 0, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.25 }),
      dark: new THREE.MeshPhysicalMaterial({ color: "#16161D", metalness: 0.55, roughness: 0.25, clearcoat: 0.8 }),
      ink: new THREE.MeshStandardMaterial({ color: "#0B0B10", metalness: 0, roughness: 0.6 }),
      pink: new THREE.MeshPhysicalMaterial({ color: "#F08AAE", metalness: 0, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.12, sheen: 0.4 }),
      leather: new THREE.MeshPhysicalMaterial({ color: "#7A4A2A", metalness: 0, roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.4 }),
      leatherDark: new THREE.MeshPhysicalMaterial({ color: "#4A2C18", metalness: 0, roughness: 0.6 }),
      glass: new THREE.MeshPhysicalMaterial({ color: "#BFE3FF", metalness: 0, roughness: 0.08, transmission: 0, clearcoat: 1, emissive: new THREE.Color("#5FB4FF"), emissiveIntensity: 0.25 }),
      positive: new THREE.MeshPhysicalMaterial({ color: p.positive, metalness: 0.2, roughness: 0.3, clearcoat: 1 }),
    };
  }, [p]);
}
type Mats = ReturnType<typeof useMaterials>;

// ------------------------------------------------------------------ icon models
function Coin({ m }: { m: Mats }) {
  const dollar = useMemo(() => {
    const pts = [
      [0.34, 0.36], [0.16, 0.5], [-0.12, 0.5], [-0.33, 0.33], [-0.27, 0.1], [0, 0.0], [0.27, -0.1], [0.33, -0.33], [0.12, -0.5], [-0.16, -0.5], [-0.34, -0.36],
    ].map(([x, y]) => new THREE.Vector3(x! * 1.05, y! * 1.05, 0));
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, "centripetal"), 160, 0.075, 20, false);
  }, []);
  const face = (z: number, flip: boolean) => (
    <group position={[0, 0, z]} rotation={[0, flip ? Math.PI : 0, 0]}>
      <mesh geometry={dollar} material={m.goldBright} />
      <mesh position={[0, 0, 0]} rotation={[Math.PI / 2, 0, 0]} material={m.goldBright}>
        <cylinderGeometry args={[0.06, 0.06, 0.06, 16]} />
      </mesh>
      <mesh position={[0, 0.66, 0]} material={m.goldBright}>
        <boxGeometry args={[0.1, 0.22, 0.09]} />
      </mesh>
      <mesh position={[0, -0.66, 0]} material={m.goldBright}>
        <boxGeometry args={[0.1, 0.22, 0.09]} />
      </mesh>
      <mesh material={m.goldBright}>
        <torusGeometry args={[0.86, 0.045, 16, 128]} />
      </mesh>
    </group>
  );
  return (
    <group>
      <mesh rotation={[Math.PI / 2, 0, 0]} material={m.gold}>
        <cylinderGeometry args={[1, 1, 0.2, 128, 1]} />
      </mesh>
      {/* reeded edge suggestion: a slightly proud band */}
      <mesh material={m.goldBright}>
        <torusGeometry args={[1, 0.035, 12, 160]} />
      </mesh>
      {face(0.105, false)}
      {face(-0.105, true)}
    </group>
  );
}

function CreditCard({ m, p }: { m: Mats; p: Palette }) {
  const body = useMemo(() => roundedSlab(2.1, 1.34, 0.06, 0.12, 0.02), []);
  const chip = useMemo(() => roundedSlab(0.34, 0.27, 0.03, 0.05, 0.008), []);
  return (
    <group>
      <mesh geometry={body} material={m.accentDeep} />
      <mesh geometry={chip} material={m.goldBright} position={[-0.6, 0.12, 0.04]} />
      {[-0.06, 0, 0.06].map((y) => (
        <mesh key={y} position={[-0.6, 0.12 + y, 0.058]} material={m.gold}>
          <boxGeometry args={[0.3, 0.008, 0.004]} />
        </mesh>
      ))}
      {[0, 1, 2, 3].map((g) => (
        <mesh key={g} position={[-0.66 + g * 0.42, -0.22, 0.036]} material={m.silver}>
          <boxGeometry args={[0.32, 0.06, 0.01]} />
        </mesh>
      ))}
      <mesh position={[-0.7, -0.45, 0.036]} material={m.silver}>
        <boxGeometry args={[0.5, 0.045, 0.01]} />
      </mesh>
      {/* contactless arcs */}
      {[0.08, 0.15, 0.22].map((r) => (
        <mesh key={r} position={[0.62, 0.15, 0.035]} rotation={[0, 0, -Math.PI / 4]} material={m.silver}>
          <torusGeometry args={[r, 0.013, 8, 32, Math.PI / 2]} />
        </mesh>
      ))}
      {/* network mark: two overlapping discs */}
      <mesh position={[0.62, -0.38, 0.036]} rotation={[Math.PI / 2, 0, 0]} material={m.gold}>
        <cylinderGeometry args={[0.15, 0.15, 0.012, 48]} />
      </mesh>
      <mesh position={[0.8, -0.38, 0.04]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.15, 0.15, 0.012, 48]} />
        <meshPhysicalMaterial color={mix(p.secondary, "#FFFFFF", 0.4)} metalness={0.6} roughness={0.25} transparent opacity={0.85} />
      </mesh>
    </group>
  );
}

function House({ m }: { m: Mats }) {
  const roof = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(-0.86, 0);
    s.lineTo(0, 0.72);
    s.lineTo(0.86, 0);
    s.lineTo(-0.86, 0);
    const g = new THREE.ExtrudeGeometry(s, { depth: 1.18, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 4 });
    g.translate(0, 0, -0.59);
    return g;
  }, []);
  const body = useMemo(() => roundedSlab(1.36, 0.96, 1.0, 0.05, 0.03), []);
  return (
    <group position={[0, -0.25, 0]}>
      <mesh geometry={body} material={m.ceramic} />
      <mesh geometry={roof} material={m.gold} position={[0, 0.47, 0]} />
      <mesh position={[0.42, 0.85, -0.15]} material={m.gold}>
        <boxGeometry args={[0.18, 0.4, 0.18]} />
      </mesh>
      <mesh position={[0, -0.2, 0.51]} material={m.accentDeep}>
        <boxGeometry args={[0.3, 0.52, 0.04]} />
      </mesh>
      <mesh position={[0.08, -0.2, 0.54]} material={m.goldBright}>
        <sphereGeometry args={[0.025, 12, 12]} />
      </mesh>
      {[-0.42, 0.42].map((x) => (
        <group key={x} position={[x, 0.1, 0.51]}>
          <mesh material={m.glass}>
            <boxGeometry args={[0.26, 0.24, 0.03]} />
          </mesh>
          <mesh position={[0, 0, 0.02]} material={m.ceramic}>
            <boxGeometry args={[0.03, 0.24, 0.02]} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, -0.52, 0]} material={m.dark}>
        <boxGeometry args={[1.6, 0.08, 1.24]} />
      </mesh>
    </group>
  );
}

function PiggyBank({ m, frame, fps }: { m: Mats; frame: number; fps: number }) {
  // A coin drops into the slot once the pig has landed.
  const drop = prog(frame, Math.round(fps * 0.8), Math.round(fps * 0.6), EASE_IN_OUT);
  const coinY = 1.55 - drop * 1.0;
  return (
    <group position={[0, -0.15, 0]}>
      <mesh scale={[1.18, 0.98, 0.96]} material={m.pink}>
        <sphereGeometry args={[0.85, 64, 48]} />
      </mesh>
      <mesh position={[1.0, 0, 0]} rotation={[0, 0, Math.PI / 2]} material={m.pink}>
        <cylinderGeometry args={[0.27, 0.3, 0.22, 40]} />
      </mesh>
      {[-0.09, 0.09].map((z) => (
        <mesh key={z} position={[1.115, 0, z]} rotation={[0, 0, Math.PI / 2]} material={m.ink}>
          <cylinderGeometry args={[0.045, 0.045, 0.02, 16]} />
        </mesh>
      ))}
      {[-0.32, 0.32].map((z) => (
        <mesh key={z} position={[0.62, 0.66, z]} rotation={[z > 0 ? 0.35 : -0.35, 0, -0.35]} material={m.pink}>
          <coneGeometry args={[0.17, 0.32, 24]} />
        </mesh>
      ))}
      {[-0.3, 0.3].map((z) => (
        <mesh key={z} position={[0.78, 0.26, z * 0.95]} material={m.ink}>
          <sphereGeometry args={[0.055, 16, 16]} />
        </mesh>
      ))}
      {[
        [0.5, 0.42],
        [0.5, -0.42],
        [-0.5, 0.42],
        [-0.5, -0.42],
      ].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x!, -0.78, z!]} material={m.pink}>
          <cylinderGeometry args={[0.15, 0.13, 0.32, 24]} />
        </mesh>
      ))}
      <mesh position={[-0.05, 0.84, 0]} material={m.ink}>
        <boxGeometry args={[0.44, 0.04, 0.08]} />
      </mesh>
      <mesh position={[-1.02, 0.12, 0]} rotation={[0, Math.PI / 2, 0]} material={m.pink}>
        <torusGeometry args={[0.1, 0.03, 10, 24, Math.PI * 1.5]} />
      </mesh>
      {drop < 0.98 ? (
        <group position={[-0.05, coinY, 0]} rotation={[0, Math.PI / 2, 0]} scale={0.26}>
          <mesh rotation={[Math.PI / 2, 0, 0]} material={m.gold}>
            <cylinderGeometry args={[1, 1, 0.22, 64]} />
          </mesh>
          <mesh material={m.goldBright}>
            <torusGeometry args={[0.82, 0.07, 12, 64]} />
          </mesh>
        </group>
      ) : null}
    </group>
  );
}

function ChartUp({ m, frame, fps }: { m: Mats; frame: number; fps: number }) {
  const heights = [0.45, 0.75, 1.05, 1.45];
  const arrow = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.95, 0.2, 0.45),
      new THREE.Vector3(-0.35, 0.55, 0.45),
      new THREE.Vector3(0.1, 0.62, 0.45),
      new THREE.Vector3(0.6, 1.2, 0.45),
      new THREE.Vector3(0.88, 1.6, 0.45),
    ]);
    return { geo: new THREE.TubeGeometry(curve, 120, 0.055, 16, false), end: curve.getPoint(1), dir: curve.getTangent(1) };
  }, []);
  const arrowT = prog(frame, Math.round(fps * 0.55), Math.round(fps * 0.6), EASE_OUT);
  const headQuat = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), arrow.dir.clone().normalize()), [arrow]);
  return (
    <group position={[0, -0.75, 0]}>
      <mesh geometry={useMemo(() => roundedSlab(2.3, 0.9, 0.14, 0.12, 0.03), [])} material={m.dark} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.07, 0]} />
      {heights.map((h, i) => {
        const s = springAt(frame, fps, 4 + i * 4, SPRINGS.grow);
        const hh = Math.max(0.02, h * s);
        return (
          <mesh key={i} position={[-0.78 + i * 0.52, hh / 2, 0]} material={i === heights.length - 1 ? m.gold : m.accent}>
            <boxGeometry args={[0.36, hh, 0.36]} />
          </mesh>
        );
      })}
      <group scale={[1, 1, 1]} position={[0, 0.15, 0]}>
        <mesh geometry={arrow.geo} material={m.goldBright} visible={arrowT > 0.02} />
        <mesh position={arrow.end} quaternion={headQuat} material={m.goldBright} scale={arrowT}>
          <coneGeometry args={[0.16, 0.34, 32]} />
        </mesh>
      </group>
    </group>
  );
}

function Calendar({ m, frame, fps }: { m: Mats; frame: number; fps: number }) {
  const page = useMemo(() => roundedSlab(1.6, 1.7, 0.16, 0.14, 0.04), []);
  const cell = useMemo(() => roundedSlab(0.2, 0.17, 0.03, 0.04, 0.008), []);
  const hl = springAt(frame, fps, Math.round(fps * 0.6), SPRINGS.soft);
  return (
    <group>
      <mesh geometry={page} material={m.ceramic} />
      <mesh position={[0, 0.62, 0.02]} material={m.accent}>
        <boxGeometry args={[1.52, 0.38, 0.16]} />
      </mesh>
      {[-0.42, 0.42].map((x) => (
        <mesh key={x} position={[x, 0.86, 0]} rotation={[0, Math.PI / 2, 0]} material={m.silver}>
          <torusGeometry args={[0.13, 0.035, 12, 32]} />
        </mesh>
      ))}
      {Array.from({ length: 20 }, (_, k) => {
        const col = k % 5;
        const row = Math.floor(k / 5);
        const special = k === 12;
        return (
          <mesh key={k} geometry={cell} position={[-0.56 + col * 0.28, 0.24 - row * 0.25, 0.09 + (special ? 0.04 * hl : 0)]} scale={special ? 1 + 0.15 * hl : 1} material={special ? m.gold : m.dark}>
            {special ? null : <meshStandardMaterial color="#C9CBD3" roughness={0.6} />}
          </mesh>
        );
      })}
    </group>
  );
}

function Lock({ m, frame, fps }: { m: Mats; frame: number; fps: number }) {
  const body = useMemo(() => roundedSlab(1.34, 1.04, 0.48, 0.16, 0.05), []);
  const close = prog(frame, Math.round(fps * 0.7), 8, EASE_IN_OUT);
  return (
    <group position={[0, -0.35, 0]}>
      <mesh geometry={body} material={m.gold} />
      <group position={[0, 0.52 + 0.3 * (1 - close), 0]}>
        <mesh position={[0, 0.3, 0]} material={m.silver}>
          <torusGeometry args={[0.4, 0.1, 20, 48, Math.PI]} />
        </mesh>
        {[-0.4, 0.4].map((x) => (
          <mesh key={x} position={[x, 0.05, 0]} material={m.silver}>
            <cylinderGeometry args={[0.1, 0.1, 0.5, 24]} />
          </mesh>
        ))}
      </group>
      <mesh position={[0, 0.08, 0.25]} rotation={[Math.PI / 2, 0, 0]} material={m.ink}>
        <cylinderGeometry args={[0.1, 0.1, 0.04, 24]} />
      </mesh>
      <mesh position={[0, -0.1, 0.25]} material={m.ink}>
        <boxGeometry args={[0.08, 0.26, 0.04]} />
      </mesh>
    </group>
  );
}

function screenTexture(p: Palette): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 512;
  const g = c.getContext("2d")!;
  const bg = g.createLinearGradient(0, 0, 256, 512);
  bg.addColorStop(0, mix(p.secondary, "#0B0B14", 0.55));
  bg.addColorStop(1, "#0B0B14");
  g.fillStyle = bg;
  g.fillRect(0, 0, 256, 512);
  g.strokeStyle = p.primary;
  g.lineWidth = 9;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.beginPath();
  [[30, 360], [80, 320], [120, 340], [170, 250], [226, 170]].forEach(([x, y], i) => (i ? g.lineTo(x!, y!) : g.moveTo(x!, y!)));
  g.stroke();
  g.fillStyle = "rgba(255,255,255,0.85)";
  g.fillRect(30, 70, 120, 18);
  g.fillStyle = "rgba(255,255,255,0.35)";
  g.fillRect(30, 104, 80, 12);
  g.fillStyle = p.positive;
  g.beginPath();
  g.arc(226, 170, 12, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function Phone({ m, p }: { m: Mats; p: Palette }) {
  const body = useMemo(() => roundedSlab(1.04, 2.04, 0.12, 0.18, 0.035), []);
  const tex = useMemo(() => screenTexture(p), [p]);
  return (
    <group>
      <mesh geometry={body} material={m.dark} />
      <mesh position={[0, 0, 0.062]}>
        <planeGeometry args={[0.94, 1.92]} />
        <meshStandardMaterial map={tex} emissiveMap={tex} emissive={new THREE.Color("#FFFFFF")} emissiveIntensity={0.9} roughness={0.15} />
      </mesh>
      <mesh position={[0, 0.86, 0.066]} material={m.ink}>
        <boxGeometry args={[0.24, 0.06, 0.005]} />
      </mesh>
    </group>
  );
}

function Briefcase({ m }: { m: Mats }) {
  const body = useMemo(() => roundedSlab(1.9, 1.3, 0.56, 0.14, 0.05), []);
  return (
    <group position={[0, -0.3, 0]}>
      <mesh geometry={body} material={m.leather} />
      <mesh position={[0, 0.25, 0]} material={m.leatherDark}>
        <boxGeometry args={[1.92, 0.05, 0.58]} />
      </mesh>
      <mesh position={[0, 0.66, 0]} material={m.leatherDark}>
        <torusGeometry args={[0.28, 0.06, 16, 32, Math.PI]} />
      </mesh>
      {[-0.5, 0.5].map((x) => (
        <group key={x}>
          <mesh position={[x, 0.25, 0.29]} material={m.goldBright}>
            <boxGeometry args={[0.18, 0.14, 0.04]} />
          </mesh>
          <mesh position={[x, -0.1, 0.285]} material={m.leatherDark}>
            <boxGeometry args={[0.08, 1.0, 0.02]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function GradCap({ m, frame }: { m: Mats; frame: number }) {
  const swing = Math.sin(frame / 9) * 0.12;
  const tassel = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.08, 0),
      new THREE.Vector3(0.6, 0.06, 0.25),
      new THREE.Vector3(0.95, 0.02, 0.35),
      new THREE.Vector3(1.0, -0.15, 0.36),
    ]);
    return new THREE.TubeGeometry(curve, 48, 0.022, 8, false);
  }, []);
  return (
    <group position={[0, 0.1, 0]}>
      <mesh material={m.dark} rotation={[0, Math.PI / 4, 0]}>
        <boxGeometry args={[1.9, 0.07, 1.9]} />
      </mesh>
      <mesh position={[0, -0.32, 0]} material={m.dark}>
        <cylinderGeometry args={[0.66, 0.6, 0.56, 48, 1, true]} />
      </mesh>
      <mesh position={[0, 0.05, 0]} material={m.goldBright}>
        <cylinderGeometry args={[0.08, 0.08, 0.06, 24]} />
      </mesh>
      <mesh geometry={tassel} material={m.goldBright} />
      <group position={[1.0, -0.15, 0.36]} rotation={[swing, 0, swing * 0.5]}>
        <mesh position={[0, -0.18, 0]} material={m.goldBright}>
          <cylinderGeometry args={[0.03, 0.03, 0.36, 12]} />
        </mesh>
        <mesh position={[0, -0.42, 0]} material={m.gold}>
          <coneGeometry args={[0.09, 0.26, 24]} />
        </mesh>
      </group>
    </group>
  );
}

const ICON_FRAMING: Record<string, { y: number; scale: number; tiltX: number }> = {
  COIN: { y: 0, scale: 1.05, tiltX: 0.12 },
  CREDIT_CARD: { y: 0, scale: 1.1, tiltX: 0.2 },
  HOUSE: { y: -0.05, scale: 1.15, tiltX: 0.18 },
  PIGGY_BANK: { y: 0, scale: 1.05, tiltX: 0.15 },
  CHART_UP: { y: 0, scale: 1.05, tiltX: 0.2 },
  CALENDAR: { y: 0, scale: 1.0, tiltX: 0.12 },
  LOCK: { y: 0, scale: 1.1, tiltX: 0.12 },
  PHONE: { y: 0, scale: 0.95, tiltX: 0.1 },
  BRIEFCASE: { y: 0, scale: 1.0, tiltX: 0.18 },
  GRADUATION_CAP: { y: 0, scale: 1.05, tiltX: 0.45 },
};

function Stage({ width, height, dpr, children, cameraZ = 6, fov = 30, cameraY = 0 }: { width: number; height: number; dpr: number; children: ReactNode; cameraZ?: number; fov?: number; cameraY?: number }) {
  return (
    <ThreeCanvas
      width={width}
      height={height}
      dpr={dpr}
      linear={false}
      gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05 }}
      camera={{ fov, position: [0, cameraY, cameraZ], near: 0.1, far: 100 }}
      style={{ position: "absolute", inset: 0, background: "transparent" }}
    >
      {children}
    </ThreeCanvas>
  );
}

export function Icon3D({ props, palette: p, frame, fps, box }: TemplateComponentProps<"ICON_3D">) {
  const m = useMaterials(p);
  const s = springAt(frame, fps, 0, { damping: 15, stiffness: 70, mass: 1 });
  const t = frame / fps;
  const f = ICON_FRAMING[props.icon]!;
  const rotY = -2.6 * (1 - s) - 0.38 + Math.sin(t * 0.9) * 0.16;
  const floatY = Math.sin(t * 1.6) * 0.06;
  const capT = prog(frame, 12, 18, EASE_OUT);
  const dpr = Math.max(1, box.scale);
  let model: ReactNode = null;
  switch (props.icon) {
    case "COIN": model = <Coin m={m} />; break;
    case "CREDIT_CARD": model = <CreditCard m={m} p={p} />; break;
    case "HOUSE": model = <House m={m} />; break;
    case "PIGGY_BANK": model = <PiggyBank m={m} frame={frame} fps={fps} />; break;
    case "CHART_UP": model = <ChartUp m={m} frame={frame} fps={fps} />; break;
    case "CALENDAR": model = <Calendar m={m} frame={frame} fps={fps} />; break;
    case "LOCK": model = <Lock m={m} frame={frame} fps={fps} />; break;
    case "PHONE": model = <Phone m={m} p={p} />; break;
    case "BRIEFCASE": model = <Briefcase m={m} />; break;
    case "GRADUATION_CAP": model = <GradCap m={m} frame={frame} />; break;
  }
  const hasCap = !!props.caption;
  const canvasH = hasCap ? 480 : 600;
  return (
    <div style={{ ...fill }}>
      <div style={{ position: "absolute", left: 30, right: 30, top: canvasH * 0.14, height: canvasH * 0.64, borderRadius: 999, background: `radial-gradient(ellipse at center, ${rgba(p.primary, 0.2)} 0%, ${rgba(p.secondary, 0.08)} 45%, transparent 70%)`, filter: "blur(20px)", opacity: clamp01(s) }} />
      <div style={{ position: "absolute", left: 0, top: 0, width: 560, height: canvasH }}>
        <Stage width={560} height={canvasH} dpr={dpr} cameraZ={hasCap ? 6.6 : 7}>
          <StudioEnvironment />
          <StudioLights p={p} />
          <group position={[0, f.y + floatY + (1 - s) * -0.6, 0]} rotation={[f.tiltX, rotY, 0]} scale={f.scale * (0.35 + 0.65 * s)}>
            {model}
          </group>
          <ContactShadow y={-1.45} scale={[2.6 * (0.5 + 0.5 * s), 0.9]} opacity={0.7 * clamp01(s) * (1 - floatY * 2)} />
        </Stage>
      </div>
      {hasCap ? (
        <div style={{ position: "absolute", left: 0, right: 0, top: canvasH + 4, textAlign: "center", fontFamily: FONT.displayBold, fontSize: 46, letterSpacing: "-0.015em", color: p.ink, textShadow: TEXT_LIFT, opacity: capT, transform: `translateY(${(1 - capT) * 18}px)` }}>{props.caption}</div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ MONEY_STACK_3D
function billTextures(): { top: THREE.CanvasTexture; side: THREE.CanvasTexture; end: THREE.CanvasTexture } {
  const top = document.createElement("canvas");
  top.width = 512;
  top.height = 220;
  const g = top.getContext("2d")!;
  const bg = g.createLinearGradient(0, 0, 512, 220);
  bg.addColorStop(0, "#4E8A5E");
  bg.addColorStop(0.5, "#6FA67A");
  bg.addColorStop(1, "#467F55");
  g.fillStyle = bg;
  g.fillRect(0, 0, 512, 220);
  g.strokeStyle = "rgba(220,240,215,0.55)";
  g.lineWidth = 6;
  g.strokeRect(14, 14, 484, 192);
  g.lineWidth = 2;
  g.strokeRect(26, 26, 460, 168);
  g.fillStyle = "rgba(20,60,35,0.35)";
  g.beginPath();
  g.ellipse(256, 110, 62, 74, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "rgba(220,240,215,0.5)";
  g.lineWidth = 3;
  g.stroke();
  g.fillStyle = "rgba(230,245,225,0.9)";
  g.font = "bold 44px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("$", 256, 112);
  g.font = "bold 38px sans-serif";
  g.fillText("100", 70, 58);
  g.fillText("100", 442, 162);
  const side = document.createElement("canvas");
  side.width = 64;
  side.height = 512;
  const s = side.getContext("2d")!;
  // Paper edges: fine alternating light/dark bill edges with a little irregularity.
  for (let y = 0; y < 512; y += 3) {
    const k = (Math.sin(y * 12.9898) * 43758.5453) % 1;
    s.fillStyle = y % 6 === 0 ? "#D7E6D0" : Math.abs(k) > 0.5 ? "#7FAF88" : "#6A9A74";
    s.fillRect(0, y, 64, 3);
  }
  const mk = (c: HTMLCanvasElement, rep = false) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    if (rep) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
    }
    return t;
  };
  return { top: mk(top), side: mk(side, true), end: mk(side, true) };
}

function MoneyStack({ height, tex, band }: { height: number; tex: ReturnType<typeof billTextures>; band: THREE.Material }) {
  const W = 1.56;
  const D = 0.68;
  const mats = useMemo(() => {
    const side = tex.side;
    const sideMat = new THREE.MeshStandardMaterial({ map: side, color: "#7FAE88", roughness: 0.85, envMapIntensity: 0.3 });
    const topMat = new THREE.MeshStandardMaterial({ map: tex.top, color: "#B9D6BC", roughness: 0.7, envMapIntensity: 0.3 });
    // BoxGeometry material order: +x, -x, +y, -y, +z, -z
    return [sideMat, sideMat, topMat, sideMat, sideMat, sideMat];
  }, [tex, height]);
  if (height < 0.005) return null;
  return (
    <group>
      <mesh position={[0, height / 2, 0]} material={mats}>
        <boxGeometry args={[W, height, D]} />
      </mesh>
      {height > 0.12 ? (
        <mesh position={[0, height / 2, 0]} material={band}>
          <boxGeometry args={[0.32, height + 0.004, D + 0.012]} />
        </mesh>
      ) : null}
    </group>
  );
}

export function MoneyStack3D({ props, palette: p, frame, fps, box, durationInFrames, exitFrames, hitAtFrame }: TemplateComponentProps<"MONEY_STACK_3D">) {
  const n = stackCountFor(props.amount);
  const tex = useMemo(() => billTextures(), []);
  const band = useMemo(() => new THREE.MeshPhysicalMaterial({ color: mix(p.primary, "#9A6A10", 0.35), roughness: 0.5, metalness: 0.1, clearcoat: 0.4, envMapIntensity: 0.5 }), [p]);
  const t = frame / fps;
  // Motion v2 timing hook: the stacks finish growing (and the amount lands) on the emphasis.
  const growLen = hitBuildLength(Math.round(fps * 1.4), 4, hitAtFrame, fps, durationInFrames, exitFrames);
  // Layout: rows of up to 3, back rows first; pyramid-ish heights.
  const slots = useMemo(() => {
    const out: Array<{ x: number; z: number; h: number; delay: number }> = [];
    const cols = n <= 2 ? n : 3;
    const rows = Math.ceil(n / cols);
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const inRow = Math.min(cols, n - r * cols);
      const x = (c - (inRow - 1) / 2) * 1.75;
      const z = (r - (rows - 1) / 2) * -0.95;
      const h = 0.8 + 0.5 * (1 - Math.abs(c - (inRow - 1) / 2) / 2) - r * 0.1;
      out.push({ x, z, h, delay: i * 3 });
    }
    return out;
  }, [n]);
  const span = Math.max(1, Math.ceil(n / 3)) * 0.95;
  const width = (n <= 2 ? n : 3) * 1.75;
  const camZ = 4.2 + Math.max(width * 0.95, span * 1.6);
  const v = countUp(frame, 0, props.amount, 4, growLen);
  const labelT = prog(frame, 6, 16, EASE_OUT);
  const orbit = -0.42 + Math.sin(t * 0.5) * 0.08 + (1 - springAt(frame, fps, 0, SPRINGS.settle)) * -0.5;
  const amountText = `$${formatNumber(Math.round(v))}`;
  const finalText = `$${formatNumber(props.amount)}`;
  const size = finalText.length <= 7 ? 112 : finalText.length <= 10 ? 96 : 80;
  return (
    <div style={{ ...fill }}>
      <div style={{ position: "absolute", left: 60, right: 60, top: 80, height: 340, background: `radial-gradient(ellipse at center, ${rgba(p.positive, 0.16)} 0%, transparent 70%)`, filter: "blur(16px)" }} />
      <div style={{ position: "absolute", left: 0, top: 0, width: 720, height: 470 }}>
        <Stage width={720} height={470} dpr={Math.max(1, box.scale)} cameraZ={camZ} cameraY={camZ * 0.42} fov={28}>
          <StudioEnvironment />
          <StudioLights p={p} />
          <CameraLookAt y={0.35} />
          <group rotation={[0, orbit, 0]}>
            {slots.map((sl, i) => {
              const g = springAt(frame, fps, 4 + sl.delay, SPRINGS.grow, growLen);
              return (
                <group key={i} position={[sl.x, 0, sl.z]}>
                  <MoneyStack height={sl.h * g} tex={tex} band={band} />
                </group>
              );
            })}
            <ContactShadow y={-0.005} scale={[width + 1.6, span + 1.6]} opacity={0.8} />
          </group>
        </Stage>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 470, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ position: "relative", fontFamily: FONT.display, fontSize: size, lineHeight: 1, letterSpacing: "-0.035em", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          <span style={{ visibility: "hidden" }}>{finalText}</span>
          <span style={{ position: "absolute", inset: 0, textAlign: "center", ...gradientText(p.positive === "#FFFFFF" ? p.primary : mix(p.positive, p.primary, 0.15)), filter: `drop-shadow(0 0 24px ${rgba(p.positive, 0.4)}) drop-shadow(0 8px 22px ${rgba("#000000", 0.5)})` }}>{amountText}</span>
        </div>
        {props.label ? <div style={{ marginTop: 14, fontFamily: FONT.text, fontSize: 38, letterSpacing: "0.1em", textTransform: "uppercase", color: p.ink, opacity: labelT * 0.92, textShadow: TEXT_LIFT }}>{props.label}</div> : null}
      </div>
    </div>
  );
}

function CameraLookAt({ y }: { y: number }) {
  const { camera } = useThree();
  useMemo(() => {
    camera.lookAt(0, y, 0);
    camera.updateProjectionMatrix();
  }, [camera, y]);
  return null;
}

// ------------------------------------------------------------------ BAR_CHART depth3d
/** Shared projection so the HTML labels sit exactly on the 3D bars. */
function barLayout(n: number, W: number, H: number) {
  const spacing = 1.25;
  const camera = new THREE.PerspectiveCamera(26, W / H, 0.1, 100);
  const xs = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * spacing);
  const span = (n - 1) * spacing + 1.2;
  const dist = (span / 2 / Math.tan((26 * Math.PI) / 360) / (W / H)) * 1.12 + 1.2;
  camera.position.set(span * 0.12, 2.3 + dist * 0.18, dist);
  camera.lookAt(0, 1.25, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const project = (x: number, y: number, z: number) => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
  };
  // 2.3 (not 2.6) leaves headroom so the tallest bar's value label clears the card title.
  return { camera, xs, project, plotH: 2.3 };
}

function Bar3D({ x, h, mat, w }: { x: number; h: number; mat: THREE.Material; w: number }) {
  const geo = useMemo(() => {
    const g = roundedSlab(w, w, 1, 0.12, 0.04);
    g.rotateX(-Math.PI / 2); // extrude along +y
    g.translate(0, 0.5, 0);
    return g;
  }, [w]);
  if (h < 0.005) return null;
  return <mesh geometry={geo} material={mat} position={[x, 0, 0]} scale={[1, h, 1]} />;
}

function CameraFrom({ cam }: { cam: THREE.PerspectiveCamera }) {
  const { camera } = useThree();
  useMemo(() => {
    camera.position.copy(cam.position);
    camera.quaternion.copy(cam.quaternion);
    (camera as THREE.PerspectiveCamera).fov = cam.fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }, [camera, cam]);
  return null;
}

export function BarChart3D({ props, palette: p, frame, fps, box }: TemplateComponentProps<"BAR_CHART">) {
  const W = 796;
  const H = props.title ? 596 : 672;
  const n = props.bars.length;
  const lay = useMemo(() => barLayout(n, W, H), [n, W, H]);
  const m = useMaterials(p);
  const max = Math.max(...props.bars.map((b) => Math.abs(b.value)), 1e-9);
  const hl = props.highlightIndex != null && props.highlightIndex < n ? props.highlightIndex : null;
  const w = Math.min(0.86, 1.25 * 0.68);
  const floorW = (n - 1) * 1.25 + 2;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Stage width={W} height={H} dpr={Math.max(1, box.scale)}>
        <CameraFrom cam={lay.camera} />
        <StudioEnvironment />
        <StudioLights p={p} />
        <mesh position={[0, -0.03, 0]} material={m.ink}>
          <boxGeometry args={[floorW, 0.06, 1.6]} />
        </mesh>
        <ContactShadow y={0.002} scale={[floorW, 1.4]} opacity={0.6} />
        {props.bars.map((b, i) => {
          const s = springAt(frame, fps, 8 + i * 5, SPRINGS.grow);
          const h = Math.max(0.04, (Math.abs(b.value) / max) * lay.plotH) * s;
          const mat = hl === null || hl === i ? m.gold : m.accent;
          return <Bar3D key={i} x={lay.xs[i]!} h={h} w={w} mat={mat} />;
        })}
      </Stage>
      {props.bars.map((b, i) => {
        const s = springAt(frame, fps, 8 + i * 5, SPRINGS.grow);
        const h = Math.max(0.04, (Math.abs(b.value) / max) * lay.plotH) * s;
        const top = lay.project(lay.xs[i]!, h + 0.12, 0);
        const base = lay.project(lay.xs[i]!, 0, 0.8);
        const focus = hl === i;
        const v = countUp(frame, 0, b.value, 8 + i * 5, Math.round(fps * 1.0));
        return (
          <div key={i}>
            <div style={{ position: "absolute", left: top.x - 110, width: 220, top: Math.max(6, top.y - 58), textAlign: "center", fontFamily: FONT.display, fontSize: n >= 6 ? 36 : 42, letterSpacing: "-0.02em", color: focus ? p.primary : p.ink, opacity: prog(frame, 12 + i * 5, 12, EASE_OUT), textShadow: focus ? `0 0 24px ${rgba(p.primary, 0.5)}` : TEXT_LIFT, whiteSpace: "nowrap" }}>{withUnit(compactNumber(Number.isInteger(b.value) ? Math.round(v) : Math.round(v * 10) / 10), props.unit)}</div>
            <div style={{ position: "absolute", left: base.x - 110, width: 220, top: base.y + 10, textAlign: "center", fontFamily: FONT.text, fontSize: n >= 6 ? 34 : 38, color: focus ? p.ink : p.muted, opacity: prog(frame, 6 + i * 4, 14, EASE_OUT), whiteSpace: "nowrap" }}>{b.label}</div>
          </div>
        );
      })}
    </div>
  );
}
