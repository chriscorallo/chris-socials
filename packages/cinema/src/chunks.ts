/**
 * Chunked rendering, the pure part: split a film's frames into contiguous ranges (rendered in
 * parallel workers), and estimate wall time / cost before anything starts. Browser-safe.
 */

export interface FrameChunk {
  index: number;
  /** Inclusive first / last frame. */
  start: number;
  end: number;
}

/**
 * Splits [0, totalFrames) into `n` contiguous, non-overlapping, gap-free ranges of near-equal
 * length (the first ones get the extra frame). Never more chunks than `totalFrames / minFrames`.
 */
export function planChunks(totalFrames: number, n: number, minFrames = 45): FrameChunk[] {
  const total = Math.max(1, Math.floor(totalFrames));
  const count = Math.max(1, Math.min(Math.floor(n), Math.max(1, Math.floor(total / Math.max(1, minFrames)))));
  const base = Math.floor(total / count);
  const extra = total % count;
  const out: FrameChunk[] = [];
  let s = 0;
  for (let i = 0; i < count; i++) {
    const len = base + (i < extra ? 1 : 0);
    out.push({ index: i, start: s, end: s + len - 1 });
    s += len;
  }
  return out;
}

/** True when chunks cover 0..total-1 exactly once, in order. */
export function chunksCover(chunks: FrameChunk[], totalFrames: number): boolean {
  let next = 0;
  for (const c of [...chunks].sort((a, b) => a.start - b.start)) {
    if (c.start !== next || c.end < c.start) return false;
    next = c.end + 1;
  }
  return next === totalFrames;
}

export type RenderHost = "MAC_GPU" | "MAC_CPU" | "SANDBOX_8VCPU";
export type FilmTier = "DRAFT" | "PREVIEW" | "FINAL";

/**
 * Measured picture cost in seconds of wall time per second of film (30 fps, 1080×1920), per host
 * and tier — see docs/decisions-pending/studio-engine.md "Render benchmarks". The Sandbox row is
 * the M1 Pro CPU (SwiftShader) measurement scaled by the measured 8-vCPU/M1-Pro ratio of the
 * motion layer (×1.25), so treat it as ±30 %.
 */
export const RENDER_SECONDS_PER_FILM_SECOND: Record<RenderHost, Record<FilmTier, number>> = {
  MAC_GPU: { DRAFT: 1.2, PREVIEW: 2.4, FINAL: 3.4 },
  MAC_CPU: { DRAFT: 14, PREVIEW: 40, FINAL: 65 },
  SANDBOX_8VCPU: { DRAFT: 18, PREVIEW: 50, FINAL: 81 },
};

/** Vercel Sandbox pricing (Pro, iad1, fetched 2026-10-17): active CPU $/vCPU-h, memory $/GB-h. */
export const SANDBOX_PRICING = { cpuPerVcpuHour: 0.128, memPerGbHour: 0.0212, vcpus: 8, gbPerVcpu: 2, bootSeconds: 3 } as const;

export interface FilmRenderEstimate {
  host: RenderHost;
  tier: FilmTier;
  chunks: number;
  /** Seconds, wall clock, start to finished file (narration + picture + assembly). */
  wallSeconds: number;
  /** Sum of all workers' busy time (seconds). */
  workerSeconds: number;
  /** $ for the cloud (0 on the Mac). Upper bound: assumes all vCPUs busy the whole time. */
  usd: number;
  /** Plain line for the button: "~9 min, about $0.80 of Vercel's included credit". */
  summary: string;
}

/** Narration (Kokoro + Whisper) ≈ 0.6 s per film-second on 8 vCPU; mix + concat/mux ≈ 15 s. */
const PREP_SECONDS_PER_FILM_SECOND = 0.6;
const ASSEMBLY_SECONDS = 15;

export function estimateFilmRender(input: { durationSeconds: number; tier: FilmTier; host: RenderHost; chunks?: number }): FilmRenderEstimate {
  const d = Math.max(1, input.durationSeconds);
  const chunks = input.host === "SANDBOX_8VCPU" ? Math.max(1, input.chunks ?? 1) : 1;
  const picture = d * RENDER_SECONDS_PER_FILM_SECOND[input.host][input.tier];
  const prep = d * PREP_SECONDS_PER_FILM_SECOND + (input.host === "SANDBOX_8VCPU" ? SANDBOX_PRICING.bootSeconds + 20 : 5);
  const perChunk = picture / chunks + (input.host === "SANDBOX_8VCPU" ? SANDBOX_PRICING.bootSeconds + 25 : 0); // + bundle/browser start per worker
  const wallSeconds = Math.round(prep + perChunk + ASSEMBLY_SECONDS);
  const workerSeconds = Math.round(prep + perChunk * chunks + ASSEMBLY_SECONDS);
  let usd = 0;
  if (input.host === "SANDBOX_8VCPU") {
    const h = workerSeconds / 3600;
    usd = h * SANDBOX_PRICING.vcpus * SANDBOX_PRICING.cpuPerVcpuHour + h * SANDBOX_PRICING.vcpus * SANDBOX_PRICING.gbPerVcpu * SANDBOX_PRICING.memPerGbHour;
  }
  usd = Math.round(usd * 100) / 100;
  const mins = wallSeconds < 90 ? `${wallSeconds} s` : `${Math.round(wallSeconds / 60)} min`;
  const summary = input.host === "SANDBOX_8VCPU" ? `~${mins} in the cloud (${chunks} worker${chunks > 1 ? "s" : ""}), about $${usd.toFixed(2)} of Vercel's included credit` : `~${mins} on your Mac, $0`;
  return { host: input.host, tier: input.tier, chunks, wallSeconds, workerSeconds, usd, summary };
}

/** How many cloud workers to split a film over: enough that each chunk fits well inside the 45-min sandbox, at most `maxWorkers`. */
export function chooseChunkCount(durationSeconds: number, tier: FilmTier, maxWorkers: number, targetChunkSeconds = 600): number {
  const picture = durationSeconds * RENDER_SECONDS_PER_FILM_SECOND.SANDBOX_8VCPU[tier];
  return Math.max(1, Math.min(Math.max(1, maxWorkers), Math.ceil(picture / targetChunkSeconds)));
}
