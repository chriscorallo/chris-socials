// Contact sheet of a render (hook frames, every graphic mid-way, a few cuts) + audio at every
// splice (sample jump + level around the cut — a clipped word shows as speech-level energy
// right at the splice). Usage: node frames.mjs t1 full|cuts
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const D = "/private/tmp/claude-501/-Users-christophercorallo-Desktop-Claude-Projects-Chris-Socials/2fa27366-298a-4c40-a49e-d2c8b0f369a9/scratchpad/fulledit";
const FF = join(D, "ff");
const [tag, kind = "full"] = process.argv.slice(2);
const j = JSON.parse(readFileSync(join(D, `${tag}-${kind}.json`), "utf8"));
const tl = j.timeline;
const video = join(D, `${tag}-${kind}.mp4`);
const out = join(D, `frames-${tag}-${kind}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const starts = [];
let t = 0;
for (const c of tl.clips) {
  starts.push(t);
  t += c.sourceEnd - c.sourceStart;
}
const times = [0.25, 1.4];
for (const v of tl.visuals) times.push(Math.min(v.end - 0.2, v.start + 1.2));
for (const z of tl.zooms) times.push((z.start + z.end) / 2);
for (let i = 1; i < starts.length && times.length < 16; i += 3) times.push(starts[i] + 0.15);
while (times.length < 16) times.push(t * (times.length / 16));
times.sort((a, b) => a - b);
times.slice(0, 16).forEach((tt, i) => {
  const f = join(out, `f${String(i).padStart(2, "0")}.jpg`);
  spawnSync(FF, ["-hide_banner", "-loglevel", "error", "-y", "-ss", tt.toFixed(3), "-i", video, "-frames:v", "1", "-vf", `scale=270:480,drawtext=text='${tt.toFixed(1)}s':x=6:y=6:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.6`, f]);
});
spawnSync(FF, ["-hide_banner", "-loglevel", "error", "-y", "-i", join(out, "f%02d.jpg"), "-vf", "tile=8x2:padding=4:color=white", "-frames:v", "1", join(D, `sheet-${tag}-${kind}.jpg`)]);
const pcm = spawnSync(FF, ["-hide_banner", "-loglevel", "error", "-i", video, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 1 << 30 }).stdout;
const a = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
const rmsDb = (s, e) => {
  let x = 0;
  for (let i = Math.max(0, s); i < Math.min(a.length, e); i++) x += a[i] * a[i];
  return 20 * Math.log10(Math.sqrt(x / Math.max(1, e - s)) + 1e-9);
};
const rep = [];
for (let i = 1; i < tl.clips.length; i++) {
  const contiguous = Math.abs(tl.clips[i - 1].sourceEnd - tl.clips[i].sourceStart) < 1e-3;
  if (contiguous) continue;
  const s = Math.round(starts[i] * 48000);
  let md = 0;
  for (let k = s - 96; k < s + 96; k++) if (k > 0 && k < a.length) md = Math.max(md, Math.abs(a[k] - a[k - 1]));
  // 30 ms windows right before/after the splice: speech-level energy there = a clipped word.
  rep.push({ cut: i, at: +starts[i].toFixed(2), jump: +md.toFixed(4), before30ms: +rmsDb(s - 1440, s).toFixed(1), after30ms: +rmsDb(s, s + 1440).toFixed(1) });
}
const speech = rmsDb(0, a.length);
writeFileSync(join(D, `audio-${tag}-${kind}.json`), JSON.stringify({ wholeFileDb: speech, splices: rep }, null, 1));
const loud = rep.filter((r) => r.before30ms > speech - 6 || r.after30ms > speech - 6);
console.log(`${tag}-${kind}: ${rep.length} audio splices, file level ${speech.toFixed(1)} dB; splices with speech-level energy within 30 ms: ${loud.length}`, loud);
