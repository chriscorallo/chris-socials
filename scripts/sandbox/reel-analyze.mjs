// Runs INSIDE a runner-snapshot sandbox: downloads a public reel (yt-dlp), detects cuts (ffmpeg scene
// score), tiles a frame every second into a contact sheet, transcribes the audio with the cached
// Whisper model (word timestamps), and prints: cut list, shot stats, transcript with times, and the
// contact sheet as base64 JPEG (the operator reads it back from stdout).
import { execFileSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
const require = createRequire("/vercel/sandbox/runner/package.json");
const url = process.env.REEL_URL;
const dir = "/vercel/sandbox/reel"; mkdirSync(dir, { recursive: true });
let ffmpeg = "/usr/bin/ffmpeg"; if (!existsSync(ffmpeg)) { try { ffmpeg = require("ffmpeg-static"); } catch {} }
const sh = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }).toString();
let log = {};
// Standalone yt-dlp binary (no Python in the sandbox image).
const ytdlp = `${dir}/yt-dlp`;
if (!existsSync(ytdlp)) sh(`curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o "${ytdlp}" && chmod +x "${ytdlp}"`);
log.ytdlp = sh(`"${ytdlp}" --version`).trim();
const mp4 = `${dir}/reel.mp4`;
if (!existsSync(mp4)) {
  try { sh(`"${ytdlp}" -q --no-warnings --ffmpeg-location "${ffmpeg}" -f "bv*[height<=1080]+ba/b" --merge-output-format mp4 -o "${mp4}" "${url}" 2>&1 | tail -3`); }
  catch (e) { console.log(JSON.stringify({ error: "download failed", detail: String(e.message).slice(0, 600) })); process.exit(1); }
}
const probe = sh(`${ffmpeg} -i "${mp4}" 2>&1 | grep -E "Duration|Stream" | head -3`);
log.probe = probe.trim().split("\n");
// Cuts: scene-change score per frame.
const scene = sh(`${ffmpeg} -i "${mp4}" -vf "select='gt(scene,0.25)',showinfo" -an -f null - 2>&1 | grep -oE "pts_time:[0-9.]+" | cut -d: -f2`);
const cuts = scene.trim().split("\n").filter(Boolean).map(Number);
const dur = (() => { const m = probe.match(/Duration: (\d+):(\d+):([\d.]+)/); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; })();
const shots = []; let prev = 0; for (const c of cuts) { shots.push(+(c - prev).toFixed(2)); prev = c; } shots.push(+(dur - prev).toFixed(2));
const sorted = [...shots].sort((a, b) => a - b);
log.duration = dur; log.cuts = cuts.map((c) => +c.toFixed(2)); log.shotMedian = sorted[Math.floor(sorted.length / 2)]; log.shotP25 = sorted[Math.floor(sorted.length * 0.25)]; log.shotP75 = sorted[Math.floor(sorted.length * 0.75)]; log.shotCount = shots.length;
// Contact sheet: one frame per second, 5 columns.
const cols = 5; const n = Math.ceil(dur); const rows = Math.ceil(n / cols);
sh(`${ffmpeg} -y -i "${mp4}" -vf "fps=1,scale=270:-1,tile=${cols}x${rows}" -frames:v 1 -q:v 4 "${dir}/sheet.jpg" 2>&1 | tail -1`);
// Also a sheet of the first 12 seconds at 2 fps (the hook).
sh(`${ffmpeg} -y -ss 0 -t 12 -i "${mp4}" -vf "fps=2,scale=216:-1,tile=6x4" -frames:v 1 -q:v 4 "${dir}/hook.jpg" 2>&1 | tail -1`);
// Transcript with word times (cached large model).
const raw = execFileSync(ffmpeg, ["-v", "error", "-i", mp4, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"], { maxBuffer: 1 << 28 });
const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const mod = await import(require.resolve("@huggingface/transformers")); const tf = mod.pipeline ? mod : mod.default;
tf.env.cacheDir = "/vercel/sandbox/cache/transformers"; tf.env.allowRemoteModels = true;
const asr = await tf.pipeline("automatic-speech-recognition", "onnx-community/whisper-large-v3-turbo_timestamped", { dtype: "fp32" });
const out = await asr(audio, { return_timestamps: "word", chunk_length_s: 25, stride_length_s: 5, language: "en", task: "transcribe" });
log.transcript = out.text.trim();
log.words = (out.chunks || []).map((c) => [c.text.trim(), +(c.timestamp[0] ?? 0).toFixed(2)]);
log.wpm = Math.round(log.words.length / (dur / 60));
console.log("RESULT " + JSON.stringify(log));
console.log("SHEET " + readFileSync(`${dir}/sheet.jpg`).toString("base64"));
console.log("HOOK " + readFileSync(`${dir}/hook.jpg`).toString("base64"));
