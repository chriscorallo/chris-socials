// Runs INSIDE the sandbox: synthesizes ~60 s of a money monologue with Kokoro, then transcribes it
// with each word-timestamped Whisper export, timing load + transcribe and scoring word errors.
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire("/vercel/sandbox/runner/package.json");
const mod = await import(require.resolve("@huggingface/transformers"));
const tf = mod.pipeline ? mod : mod.default;
const { pipeline, env } = tf;
if (!env) { console.log("transformers exports:", Object.keys(mod).slice(0, 20), Object.keys(mod.default ?? {}).slice(0, 20)); process.exit(1); }
env.cacheDir = process.env.TRANSCRIPTION_CACHE_DIR || "/vercel/sandbox/cache/transformers";
env.allowRemoteModels = true;
const TEXT = `Both of these people are making a hundred grand a year, which means they are taking home about eight thousand three hundred dollars a month. One of them rents a very expensive apartment for five thousand dollars a month, pays sixteen hundred dollars for a car, and spends another thousand a month just to travel. So that person ends up saving about seven hundred dollars a month. The other person owns a house, pays about two hundred dollars for car insurance because the car is paid off, and spends five hundred on travel because they are a little more modest. That person is saving over four thousand dollars every single month. Same salary, same city, same age. Now which one are you, and honestly, which one would you rather be? Because the difference after ten years is not a nicer apartment. It is whether you ever get to stop working. Let me know in the comments which one you picked.`;
const bench = "/vercel/sandbox/bench"; mkdirSync(bench, { recursive: true });
let wav = `${bench}/speech.wav`;
if (process.env.SPEECH_URL) {
  // Real speech (a take's proxy, time-limited signed URL) instead of synthesized.
  wav = `${bench}/speech.mp4`;
  const res = await fetch(process.env.SPEECH_URL);
  if (!res.ok) throw new Error(`speech download ${res.status}`);
  writeFileSync(wav, Buffer.from(await res.arrayBuffer()));
} else if (!existsSync(wav)) {
  const { KokoroTTS } = await import(require.resolve("kokoro-js"));
  const tts = await KokoroTTS.from_pretrained(process.env.KOKORO_MODEL_ID || "onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8" });
  const audio = await tts.generate(TEXT, { voice: "am_adam" });
  await audio.save(wav);
}
// decode wav → Float32 16k mono using ffmpeg (static) → raw
let ffmpeg = process.env.FFMPEG_PATH || "";
if (!ffmpeg || !existsSync(ffmpeg)) { try { const p = require("ffmpeg-static"); if (typeof p === "string" && existsSync(p)) ffmpeg = p; } catch {} }
for (const c of ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/vercel/sandbox/runner/bin/ffmpeg"]) if ((!ffmpeg || !existsSync(ffmpeg)) && existsSync(c)) ffmpeg = c;
if (!ffmpeg || !existsSync(ffmpeg)) { try { ffmpeg = execFileSync("bash", ["-lc", "command -v ffmpeg"]).toString().trim(); } catch {} }
console.log(JSON.stringify({ ffmpeg }));
const raw = execFileSync(ffmpeg, ["-v", "error", "-i", wav, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"], { maxBuffer: 1 << 28 });
const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const durationS = audio.length / 16000;
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9$%' ]+/g, " ").split(/\s+/).filter(Boolean);
const alpha = (toks) => toks.filter((t) => !/\d/.test(t));
function wer(ref, hyp) { const d = Array.from({ length: ref.length + 1 }, (_, i) => [i, ...Array(hyp.length).fill(0)]); for (let j = 1; j <= hyp.length; j++) d[0][j] = j; for (let i = 1; i <= ref.length; i++) for (let j = 1; j <= hyp.length; j++) d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1] + (ref[i-1] === hyp[j-1] ? 0 : 1)); return d[ref.length][hyp.length] / ref.length; }
let refA = alpha(norm(TEXT));
const results = [];
const models = (process.env.MODELS || "onnx-community/whisper-base.en_timestamped,onnx-community/whisper-small.en_timestamped,onnx-community/whisper-medium.en_timestamped,onnx-community/whisper-large-v3-turbo_timestamped").split(",");
console.log(JSON.stringify({ durationS: +durationS.toFixed(1), refWords: norm(TEXT).length }));
const chunkings = (process.env.CHUNKS || "25/5").split(",").map((c) => c.split("/").map(Number));
function quietSplitPoints(audio, sampleRate, minS = 14, maxS = 26) {
  const frame = Math.round(sampleRate * 0.02); const n = Math.floor(audio.length / frame); const rms = new Float32Array(n);
  for (let f = 0; f < n; f++) { let acc = 0; const o = f * frame; for (let i = 0; i < frame; i++) acc += audio[o + i] * audio[o + i]; rms[f] = Math.sqrt(acc / frame); }
  const win = 7; const out = []; let start = 0; const total = audio.length;
  while (total - start > maxS * sampleRate) {
    const lo = Math.floor((start + minS * sampleRate) / frame); const hi = Math.floor((start + maxS * sampleRate) / frame) - win;
    let best = -1, bestE = Infinity;
    for (let f = Math.max(lo, 0); f <= hi; f++) { let e = 0; for (let k = 0; k < win; k++) e += rms[f + k]; const sc = e * (1 + 0.6 * (hi - f) / Math.max(1, hi - lo)); if (sc < bestE) { bestE = sc; best = f; } }
    if (best < 0) break; const cut = (best + 3) * frame; out.push({ start, end: cut }); start = cut;
  }
  out.push({ start, end: total }); return out;
}
for (const model of models) {
  for (const dtype of (process.env.DTYPES || "fp32").split(",")) for (const [chunk, stride] of chunkings) {
    try {
      const t0 = Date.now();
      const asr = await pipeline("automatic-speech-recognition", model, { dtype });
      const loadMs = Date.now() - t0;
      const t1 = Date.now();
      let out;
      if (chunk === 0) {
        // PIECES mode: cut at quiet points, transcribe each piece alone, offset timings.
        const pieces = quietSplitPoints(audio, 16000); const chunksAll = []; const texts = [];
        for (const pc of pieces) { const res = await asr(audio.subarray(pc.start, pc.end), { return_timestamps: "word", ...(model.includes(".en") ? {} : { language: "en", task: "transcribe" }) }); const off = pc.start / 16000; for (const c of res.chunks || []) chunksAll.push({ ...c, timestamp: [c.timestamp[0] == null ? null : c.timestamp[0] + off, c.timestamp[1] == null ? null : c.timestamp[1] + off] }); if (res.text) texts.push(res.text.trim()); }
        out = { text: texts.join(" "), chunks: chunksAll, pieces: pieces.map((p) => +(p.end / 16000).toFixed(1)) };
      } else out = await asr(audio, { return_timestamps: "word", chunk_length_s: chunk, stride_length_s: stride, ...(model.includes(".en") ? {} : { language: "en", task: "transcribe" }) });
      const transcribeMs = Date.now() - t1;
      const chunks = out.chunks || [];
      const hyp = norm(out.text);
      const nums = hyp.filter((t) => /\d/.test(t));
      const times = chunks.map((c) => c.timestamp).filter((t) => Array.isArray(t));
      const bad = times.filter((t) => t[0] == null || t[1] == null || t[1] < t[0]).length;
      const glitch = [/\$5,000 a month|five thousand dollars a month/.test(out.text) ? "5000-ok" : "5000-BAD", /saving about \$?733/.test(out.text) ? "733-ok" : "733-BAD", /\$3,500|thirty.five hundred/.test(out.text) ? "3500-ok" : "3500-BAD", /\$1,600|sixteen hundred/.test(out.text) ? "1600-ok" : "1600-BAD"].join(" ") + (out.pieces ? " pieces@" + out.pieces.join(",") : "");
      const row = { model, dtype, chunk, stride, glitch, punctuation: (out.text.match(/[.?!]/g) || []).length, loadMs, transcribeMs, rtf: +(transcribeMs / 1000 / durationS).toFixed(2), words: chunks.length, wer: process.env.SPEECH_URL ? null : +wer(refA, alpha(hyp)).toFixed(3), numbers: nums, badTimes: bad, lastWordEnd: times.length ? times[times.length - 1][1] : null, text: out.text.slice(0, 400), hyp };
      results.push(row);
      console.log(JSON.stringify({ ...row, hyp: undefined }));
      await asr.dispose?.();
    } catch (e) { console.log(JSON.stringify({ model, dtype, error: String(e && e.message || e).slice(0, 300) })); }
  }
}
if (process.env.SPEECH_URL && results.length > 1) {
  // No ground truth for real speech: distance from the strongest model's transcript (the last one).
  const ref = alpha(results[results.length - 1].hyp);
  for (const r of results) console.log(JSON.stringify({ model: r.model, werVsStrongest: +wer(ref, alpha(r.hyp)).toFixed(3) }));
}
