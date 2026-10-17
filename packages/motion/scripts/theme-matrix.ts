/**
 * Quality loop for motion THEMES: renders the motion-language x icon-style matrix and themed
 * full examples through the real Remotion pipeline (renderVisualsLayer, FULL_LAYER alpha
 * .mov), then extracts RGBA frames at chosen moments for contact sheets.
 *
 *   pnpm --filter @chris/motion exec tsx scripts/theme-matrix.ts <outDir> [--only=icons,languages,themes]
 *
 * Output: <outDir>/frames/<set>/<config>__<tag>__<ms>.png (+ manifest.json listing them).
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FFMPEG_PATH, type MotionTemplate, type MotionTheme, type TimelineVisual } from "@chris/media";
import { SAMPLE_PROPS, renderVisualsLayer, sampleVisual } from "../src/index";

type Lang = MotionTheme["motionLanguage"];
type Icon = MotionTheme["iconStyle"];

function ff(args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let e = "";
    p.stderr.on("data", (c) => (e += c));
    p.on("close", (code) => (code === 0 ? res() : rej(new Error(e.slice(-2000)))));
  });
}

function theme(name: string, motionLanguage: Lang, iconStyle: Icon, primary: string | null = null, secondary: string | null = null): MotionTheme {
  return { name, motionLanguage, iconStyle, primary, secondary, rationale: null };
}

interface Spec {
  t: MotionTemplate;
  tag: string;
  props?: Record<string, unknown>;
}

/** Renders `specs` back to back (each `seg` s) under `th`, extracts frames at `moments` (s into each visual). */
async function renderSet(outDir: string, set: string, config: string, th: MotionTheme | null, specs: Spec[], seg: number, moments: number[], manifest: string[]) {
  const visuals: TimelineVisual[] = specs.map((s, i) => sampleVisual(s.t, i * seg, i * seg + seg - 0.15, { id: `v${i}`, props: { ...SAMPLE_PROPS[s.t], ...(s.props ?? {}) }, enterSfx: null }));
  const dir = join(outDir, "frames", set);
  await mkdir(dir, { recursive: true });
  const mov = join(outDir, `${set}-${config}.mov`);
  const started = Date.now();
  await renderVisualsLayer({ timeline: { visuals, canvas: { width: 1080, height: 1920 }, motionTheme: th }, fps: 30, durationSeconds: specs.length * seg, outputPath: mov, strategy: "FULL_LAYER" });
  for (let i = 0; i < specs.length; i++) {
    for (const m of moments) {
      const at = i * seg + m;
      const png = join(dir, `${config}__${specs[i]!.tag}__${Math.round(m * 1000)}.png`);
      await ff(["-ss", at.toFixed(3), "-i", mov, "-frames:v", "1", "-pix_fmt", "rgba", png]);
      manifest.push(png);
    }
  }
  console.log(`${set}/${config}: ${specs.length} visuals in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = resolve(args.find((a) => !a.startsWith("--")) ?? "/tmp/chris-theme-matrix");
  const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
  const want = (k: string) => !only || only.includes(k);
  const manifest: string[] = [];
  await mkdir(outDir, { recursive: true });

  // A. Icon style x 3D templates (settled frame + one mid-entrance).
  if (want("icons")) {
    const specs: Spec[] = [
      { t: "ICON_3D", tag: "card", props: { icon: "CREDIT_CARD", caption: "Credit card debt" } },
      { t: "ICON_3D", tag: "house", props: { icon: "HOUSE", caption: "Down payment" } },
      { t: "ICON_3D", tag: "piggy", props: { icon: "PIGGY_BANK", caption: null } },
      { t: "MONEY_STACK_3D", tag: "stack" },
      { t: "BAR_CHART", tag: "bars3d", props: { depth3d: true } },
    ];
    for (const icon of ["GOLD_METAL", "SOFT_CLAY", "GLASS", "LINE"] as const) {
      await renderSet(outDir, "icons", icon, theme(icon, "CRISP", icon), specs, 2.2, [0.35, 1.9], manifest);
    }
  }

  // B. Motion language x 2D templates, sampled through the entrance and settled.
  if (want("languages")) {
    const specs: Spec[] = [
      { t: "KINETIC_TEXT", tag: "kinetic" },
      { t: "NUMBER_COUNTER", tag: "counter" },
      { t: "STAT_CARD", tag: "stat" },
      { t: "LIST_STEPS", tag: "list" },
      { t: "TITLE_CARD", tag: "title" },
      { t: "ICON_3D", tag: "icon", props: { icon: "COIN", caption: "Compound interest" } },
    ];
    for (const lang of ["CALM", "CRISP", "PUNCHY", "CINEMATIC", "PLAYFUL"] as const) {
      await renderSet(outDir, "languages", lang, theme(lang, lang, "GOLD_METAL"), specs, 2.4, [0.1, 0.2, 0.33, 0.6, 2.0], manifest);
    }
  }

  // C. Same templates, three topic themes (as the deterministic fallback would choose them).
  if (want("themes")) {
    const specs: Spec[] = [
      { t: "NUMBER_COUNTER", tag: "counter", props: { value: 6580, prefix: "$", label: "Average card balance" } },
      { t: "BAR_CHART", tag: "bars", props: { depth3d: true } },
      { t: "ICON_3D", tag: "icon", props: { icon: "CREDIT_CARD", caption: "Minimum payment trap" } },
      { t: "LINE_CHART", tag: "line" },
      { t: "COMPARISON", tag: "compare" },
      { t: "KINETIC_TEXT", tag: "kinetic" },
    ];
    const themes: Array<[string, MotionTheme | null]> = [
      ["house", null],
      ["debt", theme("Debt pressure", "PUNCHY", "GOLD_METAL", "#FFB547", "#F0505F")],
      ["investing", theme("Compounding growth", "CINEMATIC", "GLASS", "#F2C14E", "#2FBF8F")],
      ["lifestyle", theme("Golden hour", "PLAYFUL", "SOFT_CLAY", "#FFA567", "#F27BB0")],
    ];
    for (const [k, th] of themes) await renderSet(outDir, "themes", k, th, specs, 2.4, [1.5], manifest);
  }

  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
