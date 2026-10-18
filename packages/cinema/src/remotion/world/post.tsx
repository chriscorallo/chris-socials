import { useFrame, useThree } from "@react-three/fiber";
import { BlendFunction, BloomEffect, DepthOfFieldEffect, Effect, EffectAttribute, EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode } from "postprocessing";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { FrameState } from "../../evaluate";
import type { Tier } from "./World";

/**
 * Post-processing (pmndrs `postprocessing`, Zlib): HDR half-float buffer →
 *   pass 1  depth of field (physical-ish: focus distance + range from fStop & focal length)
 *   pass 2  bloom (mip-chain) → ACES filmic tone mapping → grade (lift/gamma/gain, saturation,
 *           flash/black transitions)
 *   pass 3  lens: whip-pan smear, chromatic aberration, vignette, film grain (frame-seeded)
 * Tiers: DRAFT = no DOF/bloom/lens (fast storyboard), PREVIEW = half-res DOF, FINAL = all +
 * MSAA. Every uniform is set from FrameState each frame — deterministic.
 */

const GRADE_FRAG = /* glsl */ `
uniform float uExposure;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform float uSat;
uniform float uContrast;
uniform float uFlash;
uniform float uBlack;
uniform vec3 uFlashColor;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb * uExposure, 0.0);
  vec3 s = pow(c, vec3(1.0/2.2));
  s = s * uGain + uLift * (1.0 - s);
  s = pow(max(s, 0.0), 1.0 / uGamma);
  // gentle S-curve around mid grey
  s = mix(s, smoothstep(0.0, 1.0, s), uContrast);
  float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
  s = mix(vec3(l), s, uSat);
  s = mix(s, uFlashColor, clamp(uFlash, 0.0, 1.0));
  s *= 1.0 - clamp(uBlack, 0.0, 1.0);
  outputColor = vec4(pow(max(s, 0.0), vec3(2.2)), inputColor.a);
}`;

class GradeEffect extends Effect {
  constructor() {
    super("GradeEffect", GRADE_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ["uExposure", new THREE.Uniform(1)],
        ["uLift", new THREE.Uniform(new THREE.Vector3())],
        ["uGamma", new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ["uGain", new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ["uSat", new THREE.Uniform(1)],
        ["uContrast", new THREE.Uniform(0.2)],
        ["uFlash", new THREE.Uniform(0)],
        ["uBlack", new THREE.Uniform(0)],
        ["uFlashColor", new THREE.Uniform(new THREE.Vector3(1, 0.86, 0.6))],
      ]),
    });
  }
}

const LENS_FRAG = /* glsl */ `
uniform float uWhip;
uniform float uAberr;
uniform float uVignette;
uniform float uGrain;
uniform float uSeed;
uniform vec2 uTexel;
float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 d = uv - 0.5;
  vec3 col;
  if (uWhip > 0.001) {
    vec3 acc = vec3(0.0);
    float w = 0.0;
    for (int i = -6; i <= 6; i++) {
      float f = float(i) / 6.0;
      float k = 1.0 - abs(f) * 0.6;
      acc += texture2D(inputBuffer, uv + vec2(f * uWhip * 0.09, 0.0)).rgb * k;
      w += k;
    }
    col = acc / w;
  } else {
    float a = uAberr * 0.0035 * dot(d, d) * 4.0;
    col.r = texture2D(inputBuffer, uv - d * a).r;
    col.g = inputColor.g;
    col.b = texture2D(inputBuffer, uv + d * a).b;
  }
  float v = smoothstep(0.95, 0.25, length(d * vec2(0.9, 1.0)) * (0.75 + uVignette * 0.6));
  col *= mix(1.0, v, uVignette);
  // luminance-weighted grain (strongest in mids), seeded by the frame
  float g = hash(uv / uTexel * 0.5 + uSeed) - 0.5;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col += g * uGrain * 0.09 * (0.35 + 1.3 * l * (1.0 - l));
  outputColor = vec4(col, inputColor.a);
}`;

class LensEffect extends Effect {
  constructor() {
    super("LensEffect", LENS_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ["uWhip", new THREE.Uniform(0)],
        ["uAberr", new THREE.Uniform(0)],
        ["uVignette", new THREE.Uniform(0.5)],
        ["uGrain", new THREE.Uniform(0.3)],
        ["uSeed", new THREE.Uniform(0)],
        ["uTexel", new THREE.Uniform(new THREE.Vector2(1 / 1080, 1 / 1920))],
      ]),
    });
  }
}

const GRADES: Record<string, { lift: [number, number, number]; gamma: [number, number, number]; gain: [number, number, number]; sat: number; contrast: number }> = {
  WARM_GOLD: { lift: [0.0, 0.004, 0.012], gamma: [1.02, 1.0, 0.97], gain: [1.05, 1.0, 0.9], sat: 1.04, contrast: 0.22 },
  TEAL_NIGHT: { lift: [0.0, 0.012, 0.02], gamma: [0.98, 1.0, 1.03], gain: [1.0, 1.0, 1.02], sat: 0.92, contrast: 0.25 },
  NEUTRAL: { lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], sat: 1, contrast: 0.12 },
  BLEACH: { lift: [0.01, 0.01, 0.01], gamma: [1, 1, 1], gain: [1.02, 1.02, 1.02], sat: 0.6, contrast: 0.4 },
};

/** Depth of field range (meters around the focus plane) for a lens, film-like but readable. */
export function focusRangeFor(focusDistance: number, fovDeg: number, fStop: number): number {
  const focalMm = 18 / Math.tan(((fovDeg / 2) * Math.PI) / 180);
  const dMm = focusDistance * 1000;
  const coc = 0.03;
  const dofMm = (2 * fStop * coc * dMm * dMm) / (focalMm * focalMm);
  return Math.max(0.25, Math.min(40, (dofMm / 1000) * 0.9));
}

export function PostFX({ state, tier }: { state: FrameState; tier: Tier }) {
  const { gl, scene, camera, size } = useThree();
  const chain = useMemo(() => {
    gl.toneMapping = THREE.NoToneMapping;
    const composer = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: tier === "FINAL" ? 4 : 0 });
    composer.addPass(new RenderPass(scene, camera));
    const dof = tier === "DRAFT" ? null : new DepthOfFieldEffect(camera, { focusDistance: 5, focusRange: 2, bokehScale: 3, resolutionScale: tier === "FINAL" ? 0.75 : 0.5 });
    if (dof) composer.addPass(new EffectPass(camera, dof));
    const bloom = tier === "DRAFT" ? null : new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.82, luminanceSmoothing: 0.25, intensity: 1, radius: 0.72 });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const grade = new GradeEffect();
    composer.addPass(new EffectPass(camera, ...(bloom ? [bloom] : []), tone, grade));
    const lens = new LensEffect();
    composer.addPass(new EffectPass(camera, lens));
    return { composer, dof, bloom, grade, lens };
  }, [gl, scene, camera, tier]);
  useEffect(() => {
    chain.composer.setSize(size.width, size.height);
  }, [chain, size.width, size.height]);
  useEffect(() => () => chain.composer.dispose(), [chain]);

  const p = state.post;
  const c = state.camera;
  const o = state.overlay;
  if (chain.dof) {
    chain.dof.cocMaterial.focusDistance = c.focusDistance;
    const range = p.dof ? focusRangeFor(c.focusDistance, c.fov, c.fStop) : 1000;
    chain.dof.cocMaterial.focusRange = range * (1 - o.blur * 0.95);
    chain.dof.bokehScale = (p.dof ? 2.2 + o.blur * 6 : o.blur * 8) * (size.width / 1080) * (tier === "FINAL" ? 1 : 0.8);
  }
  if (chain.bloom) chain.bloom.intensity = p.bloom * (1 + o.flash * 2);
  const g = GRADES[p.grade] ?? GRADES.NEUTRAL!;
  const u = chain.grade.uniforms;
  u.get("uExposure")!.value = p.exposure * (1 + o.flash * 1.5);
  (u.get("uLift")!.value as THREE.Vector3).set(...g.lift);
  (u.get("uGamma")!.value as THREE.Vector3).set(...g.gamma);
  (u.get("uGain")!.value as THREE.Vector3).set(...g.gain);
  u.get("uSat")!.value = g.sat;
  u.get("uContrast")!.value = g.contrast;
  u.get("uFlash")!.value = o.flash * 0.85;
  u.get("uBlack")!.value = o.black;
  const L = chain.lens.uniforms;
  L.get("uWhip")!.value = tier === "DRAFT" ? 0 : o.whip;
  L.get("uAberr")!.value = tier === "FINAL" ? p.aberration : 0;
  L.get("uVignette")!.value = p.vignette;
  L.get("uGrain")!.value = tier === "DRAFT" ? 0 : p.grain;
  L.get("uSeed")!.value = (state.frame % 997) * 1.618;
  (L.get("uTexel")!.value as THREE.Vector2).set(1 / size.width, 1 / size.height);

  useFrame(() => {
    chain.composer.render();
  }, 1);
  return null;
}
