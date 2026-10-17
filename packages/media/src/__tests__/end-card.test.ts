import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { brightnessFit, detectEndCard, measureTailFrames, overlayShares, probeVideo, TAIL_H, TAIL_W } from "../style-analysis";
import { runFfmpegRaw } from "./ffmpeg-test-helpers";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "face-portrait-pd.jpg");
const FPS = 30;
const W = 360;
const H = 640;
const CONTENT_S = 4;
const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-r", String(FPS)];

/**
 * Platform end cards (Instagram / TikTok download outros) on synthetic clips: a moving, grainy
 * "talking head" (the public-domain portrait drifting, jump-cut every ~1 s) followed by
 *  - an Instagram-like card: the last frame frozen + dimmed, a centred logo (box outline) and a
 *    handle bar — static, and a fade-in variant;
 *  - a TikTok-like card: cut to black, the logo animating in;
 * and endings that must be KEPT: a normal-brightness held closing shot with centred white text,
 * a creator's fade to black held with nothing on it, and no tail at all.
 * The full study (17 clips incl. low-bitrate, light dim, dark motion graphics, real Whisper) is in
 * docs/decisions-pending/reference-measuring-v2.md.
 */
describe("end card detection", () => {
  let dir: string;
  let content: string;
  let lastPng: string;
  const clip = (name: string) => join(dir, `${name}.mp4`);

  async function card(name: string, dur: number, vf: string, input: string[] = ["-loop", "1", "-framerate", String(FPS), "-t", String(dur), "-i", lastPng]) {
    const c = join(dir, `${name}-card.mp4`);
    await runFfmpegRaw(["-y", "-v", "error", ...input, "-vf", `${vf},format=yuv420p`, "-t", String(dur), ...enc, c]);
    await runFfmpegRaw([
      "-y", "-v", "error", "-i", content, "-i", c,
      "-filter_complex", `[0:v]setsar=1[a];[1:v]setsar=1[b];[a][b]concat=n=2:v=1:a=0[v]`,
      "-map", "[v]", ...enc, clip(name),
    ]);
  }

  const LOGO = "drawbox=x=(iw-50)/2:y=(ih-50)/2-15:w=50:h=50:color=white:t=5,drawbox=x=(iw-18)/2:y=(ih-18)/2-15:w=18:h=18:color=white:t=4,drawbox=x=(iw-90)/2:y=ih/2+25:w=90:h=8:color=white:t=fill";
  const DIM = "format=rgb24,colorchannelmixer=rr=0.45:gg=0.45:bb=0.45";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-endcard-test-"));
    content = join(dir, "content.mp4");
    await runFfmpegRaw([
      "-y", "-v", "error", "-loop", "1", "-framerate", String(FPS), "-i", FIXTURE, "-t", String(CONTENT_S),
      "-vf", `scale=400:711,setsar=1,crop=${W}:${H}:20+14*sin(2*PI*t/3.1)+if(gte(mod(t\\,2.1)\\,1.05)\\,10\\,0):35+8*sin(2*PI*t/2.3),noise=alls=6:allf=t,format=yuv420p`,
      ...enc, content,
    ]);
    lastPng = join(dir, "last.png");
    await runFfmpegRaw(["-y", "-v", "error", "-sseof", "-0.2", "-i", content, "-update", "1", "-frames:v", "100", lastPng]);
    await card("ig-static", 3, `${DIM},${LOGO}`);
    await card("ig-fade", 3, `format=rgb24,split[a][b];[b]colorchannelmixer=rr=0.45:gg=0.45:bb=0.45[d];[a][d]blend=all_expr='A*(1-min(T/0.5\\,1))+B*min(T/0.5\\,1)',${LOGO.replace(/:t=(\d)/g, ":t=$1:enable='gte(t\\,0.4)'").replace(":t=fill", ":t=fill:enable='gte(t\\,0.4)'")}`);
    await card("tiktok", 2.6, "drawbox=x=(iw-60)/2+15*sin(6*t)*max(0\\,1-t):y=(ih-60)/2-20:w=60:h=60:color=0x25F4EE:t=fill,drawbox=x=(iw-50)/2:y=(ih-50)/2-18:w=50:h=50:color=white:t=fill:enable='gte(t\\,0.4)',drawbox=x=(iw-80)/2:y=ih/2+30:w=80:h=8:color=white:t=fill:enable='gte(t\\,0.6)'", [
      "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${FPS}:d=2.6`,
    ]);
    await card("held-closing", 2.5, "drawbox=x=(iw-200)/2:y=(ih-30)/2:w=200:h=30:color=white:t=fill");
    // A creator's own fade to black (content keeps moving), then 2 s of plain black.
    const faded = join(dir, "faded.mp4");
    await runFfmpegRaw(["-y", "-v", "error", "-i", content, "-vf", `fade=t=out:st=${CONTENT_S - 0.8}:d=0.8`, ...enc, faded]);
    const black = join(dir, "black.mp4");
    await runFfmpegRaw(["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${FPS}:d=2`, ...enc, black]);
    await runFfmpegRaw(["-y", "-v", "error", "-i", faded, "-i", black, "-filter_complex", "[0:v]setsar=1[a];[1:v]setsar=1[b];[a][b]concat=n=2:v=1:a=0[v]", "-map", "[v]", ...enc, clip("fade-black")]);
  }, 120_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function detect(file: string, lastWordEndS: number | null = CONTENT_S - 0.4) {
    const p = await probeVideo(file);
    return detectEndCard(await measureTailFrames(file), { durationS: p.durationS, lastWordEndS });
  }

  it("strips an Instagram-style card (dimmed frozen last frame + centred logo/handle), static and fading in", async () => {
    for (const name of ["ig-static", "ig-fade"]) {
      const r = await detect(clip(name));
      expect(r.startS, `${name}: ${r.reason}`).not.toBeNull();
      expect(Math.abs(r.startS! - CONTENT_S)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(r.durationS! - 3)).toBeLessThanOrEqual(0.15);
      expect(r.evidence.darkRatio!).toBeLessThan(0.6);
    }
  }, 60_000);

  it("strips a TikTok-style card (cut to black, logo animating in)", async () => {
    const r = await detect(clip("tiktok"));
    expect(r.startS, r.reason).not.toBeNull();
    expect(Math.abs(r.startS! - CONTENT_S)).toBeLessThanOrEqual(0.1);
  }, 60_000);

  it("keeps a normal-brightness held closing shot with centred text, a fade to black with nothing on it, and a plain ending", async () => {
    expect((await detect(clip("held-closing"))).reason).toMatch(/isn't darker/);
    expect((await detect(clip("fade-black"))).reason).toMatch(/no centred logo/);
    expect((await detect(content)).startS).toBeNull();
  }, 60_000);

  it("never cuts off talking: a card that starts before the last word isn't one", async () => {
    const r = await detect(clip("ig-static"), CONTENT_S + 1.5);
    expect(r.startS).toBeNull();
    expect(r.reason).toMatch(/talking continues/);
  }, 60_000);

  it("pure: brightness fit sees a dimmed copy as the same still, and different footage as not", () => {
    const n = TAIL_W * TAIL_H;
    const a = new Uint8Array(n);
    let seed = 5;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < n; i++) a[i] = 16 + Math.floor(((i % TAIL_W) / TAIL_W) * 150 + rnd() * 60);
    const dimmed = a.map((v) => Math.round(16 + (v - 16) * 0.5));
    const fit = brightnessFit(a, dimmed);
    expect(fit.beta).toBeCloseTo(0.5, 1);
    expect(fit.residual).toBeLessThan(1);
    const other = a.map(() => 16 + Math.floor(rnd() * 200));
    expect(brightnessFit(a, other).residual).toBeGreaterThan(10);
    // A centred white logo on a dim frame is an overlay; the same logo in a corner isn't centred.
    const dim = new Uint8Array(n).fill(40);
    const put = (x0: number, y0: number) => {
      for (let y = y0; y < y0 + 20; y++) for (let x = x0; x < x0 + 20; x++) dim[y * TAIL_W + x] = 235;
    };
    put(80, 150);
    expect(overlayShares(dim)).toMatchObject({ centred: true, outside: 0 });
    const corner = new Uint8Array(n).fill(40);
    for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) corner[y * TAIL_W + x] = 235;
    expect(overlayShares(corner).inside).toBe(0);
  });
});
