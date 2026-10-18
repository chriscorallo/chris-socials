import * as THREE from "three";
import { rng } from "../../ease";

/**
 * Procedural materials and textures — everything drawn from code (no image files), so the
 * asset manifest stays "original / generated" and renders are deterministic.
 */

const cache = new Map<string, unknown>();
function memo<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/** Height map (grayscale canvas) → tangent-space normal map. */
function heightToNormal(src: HTMLCanvasElement, strength: number): THREE.CanvasTexture {
  const w = src.width;
  const h = src.height;
  const sctx = src.getContext("2d")!;
  const data = sctx.getImageData(0, 0, w, h).data;
  const [dst, dctx] = canvas(w, h);
  const out = dctx.createImageData(w, h);
  const H = (x: number, y: number) => data[(((y + h) % h) * w + ((x + w) % w)) * 4]! / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      out.data[i] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      out.data[i + 1] = Math.round(((dy / len) * 0.5 + 0.5) * 255);
      out.data[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      out.data[i + 3] = 255;
    }
  }
  dctx.putImageData(out, 0, 0);
  const t = new THREE.CanvasTexture(dst);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Coin face: raised rim, recessed field, an original abstract mark (concentric arcs + a
 * stylized upward chevron — "growth"), and a beaded ring. Not any real currency. */
export function coinFaceNormal(): THREE.CanvasTexture {
  return memo("coinFace", () => {
    const S = 512;
    const [c, g] = canvas(S, S);
    g.fillStyle = "#000";
    g.fillRect(0, 0, S, S);
    const cx = S / 2;
    // field
    const field = g.createRadialGradient(cx, cx, 0, cx, cx, S * 0.5);
    field.addColorStop(0, "#5a5a5a");
    field.addColorStop(0.82, "#4a4a4a");
    field.addColorStop(0.86, "#d0d0d0");
    field.addColorStop(0.97, "#e8e8e8");
    field.addColorStop(1, "#202020");
    g.fillStyle = field;
    g.beginPath();
    g.arc(cx, cx, S * 0.5, 0, Math.PI * 2);
    g.fill();
    // beaded ring
    g.fillStyle = "#9a9a9a";
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      g.beginPath();
      g.arc(cx + Math.cos(a) * S * 0.395, cx + Math.sin(a) * S * 0.395, S * 0.009, 0, Math.PI * 2);
      g.fill();
    }
    // mark: three concentric arcs + chevron
    g.strokeStyle = "#a8a8a8";
    g.lineCap = "round";
    for (let k = 0; k < 3; k++) {
      g.lineWidth = S * 0.02;
      g.beginPath();
      g.arc(cx, cx + S * 0.05, S * (0.12 + k * 0.065), Math.PI * 1.15, Math.PI * 1.85);
      g.stroke();
    }
    g.lineWidth = S * 0.035;
    g.beginPath();
    g.moveTo(cx - S * 0.13, cx + S * 0.12);
    g.lineTo(cx, cx - S * 0.01);
    g.lineTo(cx + S * 0.13, cx + S * 0.12);
    g.stroke();
    g.filter = "blur(2px)";
    g.drawImage(c, 0, 0);
    return heightToNormal(c, 3.2);
  });
}

/** Reeded coin edge (fine vertical ridges) — tiles around the cylinder. */
export function coinEdgeNormal(): THREE.CanvasTexture {
  return memo("coinEdge", () => {
    const [c, g] = canvas(512, 16);
    for (let x = 0; x < 512; x++) {
      const v = 0.5 + 0.5 * Math.sin((x / 512) * Math.PI * 2 * 96);
      const s = Math.round(60 + v * 160);
      g.fillStyle = `rgb(${s},${s},${s})`;
      g.fillRect(x, 0, 1, 16);
    }
    const t = heightToNormal(c, 2.2);
    t.wrapS = THREE.RepeatWrapping;
    return t;
  });
}

/** Subtle micro-roughness variation for metals (seeded noise), avoids "CG-perfect" gold. */
export function roughnessNoise(seed = 3): THREE.CanvasTexture {
  return memo(`rough${seed}`, () => {
    const r = rng(seed);
    const S = 256;
    const [c, g] = canvas(S, S);
    const img = g.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const v = 150 + Math.round((r() - 0.5) * 60);
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    g.filter = "blur(1.2px)";
    g.drawImage(c, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  });
}

/** Physically-based gold (linear albedo of gold ≈ (1.0, 0.77, 0.34)). */
export function goldMaterials(tint = "#E5A94A") {
  return memo(`gold${tint}`, () => {
    const base = new THREE.Color("#FFD27A").lerp(new THREE.Color(tint), 0.2);
    const common = { color: base, metalness: 1, roughness: 0.22, roughnessMap: roughnessNoise(), envMapIntensity: 2.0 };
    const face = new THREE.MeshPhysicalMaterial({ ...common, normalMap: coinFaceNormal(), normalScale: new THREE.Vector2(0.9, 0.9), clearcoat: 0.25, clearcoatRoughness: 0.18 });
    const edgeMap = coinEdgeNormal().clone();
    edgeMap.needsUpdate = true;
    edgeMap.repeat.set(1, 1);
    const edge = new THREE.MeshPhysicalMaterial({ ...common, roughness: 0.3, normalMap: edgeMap, normalScale: new THREE.Vector2(0.8, 0.8) });
    const plain = new THREE.MeshPhysicalMaterial({ ...common, roughness: 0.28 });
    return { face, edge, plain };
  });
}

/** Radial soft blob (contact shadows, glows, particles). */
export function radialTexture(inner = "rgba(255,255,255,1)", outer = "rgba(255,255,255,0)", size = 256): THREE.CanvasTexture {
  return memo(`radial${inner}${outer}${size}`, () => {
    const [c, g] = canvas(size, size);
    const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gr.addColorStop(0, inner);
    gr.addColorStop(1, outer);
    g.fillStyle = gr;
    g.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** Text drawn to a texture (labels in the world: cards, the baseline). */
export function textTexture(lines: Array<{ text: string; font: string; color: string; y: number }>, w: number, h: number, bg?: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const key = `text${JSON.stringify(lines)}${w}x${h}${bg ? "bg" : ""}`;
  return memo(key, () => {
    const [c, g] = canvas(w, h);
    bg?.(g);
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (const l of lines) {
      g.font = l.font;
      g.fillStyle = l.color;
      g.fillText(l.text, w / 2, l.y);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  });
}

/** Window grid for miniature buildings (emissive map): warm lit windows, some dark (seeded). */
export function windowTexture(floors: number, cols: number, seed: number): THREE.CanvasTexture {
  return memo(`win${floors}x${cols}s${seed}`, () => {
    const r = rng(seed);
    const cw = 32;
    const ch = 40;
    const [c, g] = canvas(cols * cw, floors * ch);
    g.fillStyle = "#000";
    g.fillRect(0, 0, c.width, c.height);
    for (let y = 0; y < floors; y++) {
      for (let x = 0; x < cols; x++) {
        const lit = r() > 0.42;
        if (!lit) continue;
        const warm = 200 + Math.round(r() * 55);
        g.fillStyle = `rgb(255,${warm},${Math.round(warm * 0.62)})`;
        g.globalAlpha = 0.55 + r() * 0.45;
        g.fillRect(x * cw + 9, y * ch + 10, cw - 18, ch - 20);
      }
    }
    g.globalAlpha = 1;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/**
 * A studio environment for reflections, built from emissive "softboxes" in a dark room (the
 * look of product photography: a big warm key box, strip lights for long specular streaks on
 * metal, a cool kicker). PMREM-filtered once per renderer.
 */
export function studioEnvironment(gl: THREE.WebGLRenderer, warm: string, cool: string): THREE.Texture {
  const key = `env${warm}${cool}`;
  const existing = envCache.get(gl)?.get(key);
  if (existing) return existing;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#050404");
  const box = (w: number, h: number, color: string, intensity: number, pos: [number, number, number], rot: [number, number, number]) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.rotation.set(...rot);
    scene.add(m);
  };
  // a dim warm surround so metal never reflects pure black, then the hard sources
  const surround = new THREE.Mesh(new THREE.SphereGeometry(20, 32, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(warm).multiplyScalar(0.06), side: THREE.BackSide }));
  scene.add(surround);
  box(6, 4, warm, 3.2, [-5, 5, 4], [0, Math.PI / 4, 0]); // key softbox
  box(8, 3, warm, 1.6, [0, 2, 9], [0, Math.PI, 0]); // front fill (camera side) — lights coin edges
  box(5, 2.5, "#FFFFFF", 2.2, [5, 4, 5], [0, -Math.PI / 4, 0]); // right softbox
  box(0.6, 8, "#FFFFFF", 4.5, [6, 3, -2], [0, -Math.PI / 2.4, 0]); // strip right
  box(0.6, 8, warm, 3.0, [-6, 3, -4], [0, Math.PI / 2.6, 0]); // strip left back
  box(10, 1.2, cool, 1.2, [0, 9, 0], [Math.PI / 2, 0, 0]); // overhead cool band
  box(14, 2, warm, 0.35, [0, -1.5, -8], [0, 0, 0]); // floor bounce glow
  const pm = new THREE.PMREMGenerator(gl);
  const tex = pm.fromScene(scene, 0.03).texture;
  pm.dispose();
  if (!envCache.has(gl)) envCache.set(gl, new Map());
  envCache.get(gl)!.set(key, tex);
  return tex;
}
const envCache = new WeakMap<THREE.WebGLRenderer, Map<string, THREE.Texture>>();
