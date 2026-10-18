import { wrapLines } from "./scroll";

/**
 * Canvas renderer for the floating (Picture-in-Picture) script. The PiP window is small, so:
 * big bold white-on-black text, a gold reading-line marker, soft fades top and bottom, and a
 * big "Starts in 7" before scrolling so there's time to open the Camera app and hit record.
 */

export const PIP_CANVAS = { width: 1280, height: 720 } as const;
const READ_Y = 0.36;
const PAD_X = 64;

export interface PipLayout {
  lines: string[];
  fontPx: number;
  lineHeight: number;
  contentHeight: number;
}

export function layoutPip(ctx: CanvasRenderingContext2D, text: string, fontPx: number): PipLayout {
  ctx.font = `700 ${fontPx}px -apple-system, "SF Pro Display", Inter, system-ui, sans-serif`;
  const lines = wrapLines(text || " ", PIP_CANVAS.width - PAD_X * 2, (s) => ctx.measureText(s).width);
  const lineHeight = Math.round(fontPx * 1.22);
  return { lines, fontPx, lineHeight, contentHeight: Math.max(0, (lines.length - 1) * lineHeight) };
}

export function drawPipFrame(
  ctx: CanvasRenderingContext2D,
  layout: PipLayout,
  state: { progress: number; startsIn: number; paused: boolean; mirror?: boolean },
): void {
  const { width: W, height: H } = PIP_CANVAS;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (state.mirror) ctx.setTransform(-1, 0, 0, 1, W, 0);
  ctx.font = `700 ${layout.fontPx}px -apple-system, "SF Pro Display", Inter, system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const readY = H * READ_Y;
  const top = readY - Math.min(1, Math.max(0, state.progress)) * layout.contentHeight;
  for (let i = 0; i < layout.lines.length; i++) {
    const y = top + i * layout.lineHeight;
    if (y < -layout.lineHeight || y > H + layout.lineHeight) continue;
    const near = Math.abs(y - readY) < layout.lineHeight * 0.6;
    ctx.fillStyle = near ? "#ffffff" : "rgba(255,255,255,0.78)";
    ctx.fillText(layout.lines[i]!, PAD_X, y);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Fades
  const topFade = ctx.createLinearGradient(0, 0, 0, H * 0.18);
  topFade.addColorStop(0, "rgba(0,0,0,0.95)");
  topFade.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = topFade;
  ctx.fillRect(0, 0, W, H * 0.18);
  const botFade = ctx.createLinearGradient(0, H * 0.72, 0, H);
  botFade.addColorStop(0, "rgba(0,0,0,0)");
  botFade.addColorStop(1, "rgba(0,0,0,0.95)");
  ctx.fillStyle = botFade;
  ctx.fillRect(0, H * 0.72, W, H * 0.28);
  // Reading-line marker
  ctx.fillStyle = "#f3c46a";
  ctx.beginPath();
  ctx.moveTo(14, readY - 16);
  ctx.lineTo(40, readY);
  ctx.lineTo(14, readY + 16);
  ctx.closePath();
  ctx.fill();
  if (state.startsIn > 0) {
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#f3c46a";
    ctx.textAlign = "center";
    ctx.font = `700 ${Math.round(H * 0.32)}px -apple-system, Inter, system-ui, sans-serif`;
    ctx.fillText(String(Math.ceil(state.startsIn)), W / 2, H * 0.46);
    ctx.fillStyle = "#fff";
    ctx.font = `600 ${Math.round(H * 0.075)}px -apple-system, Inter, system-ui, sans-serif`;
    ctx.fillText("Open Camera and hit record", W / 2, H * 0.8);
  } else if (state.paused) {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(W - 250, 24, 226, 76);
    ctx.fillStyle = "#f3c46a";
    ctx.textAlign = "center";
    ctx.font = `700 44px -apple-system, Inter, system-ui, sans-serif`;
    ctx.fillText("Paused", W - 137, 62);
  }
}
