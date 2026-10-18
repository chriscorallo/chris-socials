import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rng } from "../ease";
import { encodeStereoWav } from "./score";

/**
 * SFX for mini-movies. Nine sounds are the repo's own procedural kit
 * (packages/motion/assets/sfx — synthesized by packages/motion/scripts/generate-sfx.mjs, no
 * third-party audio, see docs/DECISIONS.md "Procedural SFX kit"); two cinema-specific sounds
 * (SUB_DROP, COIN_CLINK) are synthesized here the same way. Zero licensing risk.
 */

const KIT = ["WHOOSH", "SWOOSH_UP", "SOFT_POP", "CLICK", "TICK", "RISER", "IMPACT", "SHIMMER", "CASH"] as const;

export function resolveMotionSfxDir(): string | null {
  if (process.env.MOTION_SFX_DIR && existsSync(process.env.MOTION_SFX_DIR)) return process.env.MOTION_SFX_DIR;
  const starts: string[] = [];
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // bundled
  }
  starts.push(process.cwd());
  for (const s of starts) {
    let dir = s;
    for (let i = 0; i < 8; i++) {
      const c = join(dir, "packages", "motion", "assets", "sfx");
      if (existsSync(join(c, "whoosh.wav"))) return c;
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

const SR = 48000;

function synthSubDrop(): Float32Array {
  const n = Math.round(SR * 2.2);
  const out = new Float32Array(n * 2);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 34 + 70 * Math.exp(-t * 2.6);
    ph += f / SR;
    const env = Math.min(1, t * 80) * Math.exp(-t * 1.6);
    const v = Math.tanh(Math.sin(2 * Math.PI * ph) * 1.6) * env;
    out[i * 2] = v;
    out[i * 2 + 1] = v;
  }
  return out;
}

function synthCoinClink(seed = 7): Float32Array {
  const r = rng(seed);
  const n = Math.round(SR * 0.9);
  const out = new Float32Array(n * 2);
  // inharmonic partials of a small metal disc
  const partials = [2380, 3910, 5620, 7090, 8810].map((f, k) => ({ f: f * (1 + (r() - 0.5) * 0.01), a: 1 / (k + 1.3), d: 7 + k * 5, p: r() * 6.28 }));
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (const p of partials) v += Math.sin(2 * Math.PI * p.f * t + p.p) * p.a * Math.exp(-t * p.d);
    // a second, quieter strike (coins settle)
    const t2 = t - 0.085;
    if (t2 > 0) for (const p of partials) v += Math.sin(2 * Math.PI * p.f * 1.012 * t2) * p.a * 0.35 * Math.exp(-t2 * (p.d + 4));
    const click = t < 0.003 ? (r() * 2 - 1) * (1 - t / 0.003) * 0.6 : 0;
    const s = (v * 0.35 + click) * Math.min(1, t * 4000);
    out[i * 2] = s;
    out[i * 2 + 1] = s * 0.92;
  }
  return out;
}

/** sound id → WAV path. Synthesized sounds are written once into `cacheDir`. */
export async function cinemaSfxFiles(cacheDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const kitDir = resolveMotionSfxDir();
  if (kitDir) for (const s of KIT) files[s] = join(kitDir, `${s.toLowerCase()}.wav`);
  await mkdir(cacheDir, { recursive: true });
  const synth: Record<string, () => Float32Array> = { SUB_DROP: synthSubDrop, COIN_CLINK: () => synthCoinClink() };
  for (const [name, make] of Object.entries(synth)) {
    const p = join(cacheDir, `${name.toLowerCase()}.wav`);
    if (!existsSync(p)) await writeFile(p, encodeStereoWav(make(), SR, -8));
    files[name] = p;
  }
  return files;
}
