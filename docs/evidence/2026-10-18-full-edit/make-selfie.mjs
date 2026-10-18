// A 1080x1920 "selfie at arm's length" stand-in: the portrait at 720 px wide (face ≈ 30 % of the
// frame width, eyes ≈ 0.35 of the height) over a blurred, darkened copy of itself (the "room"),
// feathered edges, subtle handheld drift. Usage: node make-selfie.mjs img out.mp4 secs audio.wav
import { spawnSync } from "node:child_process";
const FF = "/Users/christophercorallo/Desktop/Claude Projects/Chris Socials/.claude/worktrees/agent-aad446c9bef68772d/node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg";
const [img, out, secs = "11", audio] = process.argv.slice(2);
const T = "(in/30)";
const Z = `(1.02+0.03*sin(2*PI*${T}/9))`;
const DX = `(10*sin(2*PI*${T}/4.3)+5*sin(2*PI*${T}/1.7))`;
const DY = `(6*sin(2*PI*${T}/3.1))`;
const L = `(540-540/${Z}+${DX})`;
const TP = `(960-960/${Z}+${DY})`;
const R = `(${L}+1080/${Z})`;
const B = `(${TP}+1920/${Z})`;
// photo 1280x1601 -> 720x900, placed at x=180, y=420; feather 70 px on every edge.
const fc =
  `[0:v]split=2[a][b];` +
  `[a]scale=1536:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=40,eq=brightness=-0.12:saturation=0.8[bg];` +
  `[b]scale=720:900:flags=lanczos,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*min(1,min(min(X,W-1-X),min(Y,H-1-Y))/70)'[ph];` +
  `[bg][ph]overlay=180:420:format=auto,format=yuv420p,` +
  `perspective=x0='${L}':y0='${TP}':x1='${R}':y1='${TP}':x2='${L}':y2='${B}':x3='${R}':y3='${B}':interpolation=cubic:sense=source:eval=frame,format=yuv420p[v]`;
const args = ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "30", "-i", img, "-i", audio, "-t", secs, "-filter_complex", fc, "-map", "[v]", "-map", "1:a", "-c:a", "aac", "-b:a", "192k", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-r", "30", "-t", secs, out];
const r = spawnSync(FF, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
