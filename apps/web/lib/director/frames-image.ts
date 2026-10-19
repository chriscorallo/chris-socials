import type { ContactSheetPlan } from "@chris/media/director";

/**
 * Draws the Director chat's frames image in the browser (canvas → JPEG): the cells the server
 * planned for the CURRENT edit (contactSheetPlan), cut from each take's sprite, each labelled
 * with its output time and the detected expression. Free; matches the layout of the evidence
 * script. The sprites are served same-origin (/api/director/sprite/…) so the canvas isn't tainted.
 */

export interface SpriteRef {
  url: string;
  cols: number;
  cellW: number;
  cellH: number;
}

const LABEL = 44;
const PAD = 6;

/** Canvas size for a plan (pure — tested). */
export function framesImageSize(plan: ContactSheetPlan, cell: { w: number; h: number }): { width: number; height: number; rows: number } {
  const rows = Math.ceil(plan.cells.length / plan.cols);
  return { width: plan.cols * cell.w + (plan.cols + 1) * PAD, height: rows * (cell.h + LABEL) + (rows + 1) * PAD, rows };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Couldn't load ${url}`));
    img.src = url;
  });
}

export async function composeFramesImage(plan: ContactSheetPlan, sprites: Record<string, SpriteRef>): Promise<Blob | null> {
  const first = Object.values(sprites)[0];
  if (!first || plan.cells.length === 0) return null;
  const cell = { w: first.cellW, h: first.cellH };
  const { width, height } = framesImageSize(plan, cell);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#0c0c0e";
  ctx.fillRect(0, 0, width, height);
  const images = new Map<string, HTMLImageElement>();
  for (const [id, s] of Object.entries(sprites)) {
    try {
      images.set(id, await loadImage(s.url));
    } catch {
      /* that take's cells stay dark */
    }
  }
  plan.cells.forEach((c, i) => {
    const r = Math.floor(i / plan.cols);
    const k = i % plan.cols;
    const x = PAD + k * (cell.w + PAD);
    const y = PAD + r * (cell.h + LABEL + PAD);
    const s = sprites[c.assetId];
    const img = images.get(c.assetId);
    if (s && img) {
      const sx = (c.spriteIndex % s.cols) * s.cellW;
      const sy = Math.floor(c.spriteIndex / s.cols) * s.cellH;
      ctx.drawImage(img, sx, sy, s.cellW, s.cellH, x, y, cell.w, cell.h);
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y + cell.h, cell.w, LABEL);
    ctx.fillStyle = "#FFD54A";
    ctx.font = "bold 24px -apple-system, system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(c.label, x + 8, y + cell.h + 3);
    ctx.fillStyle = "#dcdce1";
    ctx.font = "15px -apple-system, system-ui, sans-serif";
    ctx.fillText(c.sublabel, x + 8, y + cell.h + 27);
  });
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85));
}

export async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}
