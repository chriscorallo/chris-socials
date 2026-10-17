/**
 * Optional font override for the renderer. Unset (the normal case), every overlay style and
 * caption uses the Inter weights bundled in packages/media/assets/fonts (shipped to Vercel via
 * next.config.ts's outputFileTracingIncludes). If set, the path must exist — the renderer
 * throws rather than letting ffmpeg silently fall back to a random system font.
 */
export function getRenderFontPath(): string | undefined {
  return process.env.RENDER_FONT_PATH || undefined;
}

/**
 * Where heavy jobs (render with graphics, Whisper, face tracking, person matte) run:
 * "inline" = in this server process (local `next dev`, a self-hosted worker); "sandbox" = a
 * fresh Vercel Sandbox microVM per job (lib/heavy-jobs.ts). Default: sandbox on Vercel, inline
 * elsewhere. RENDER_MODE=inline|sandbox overrides (e.g. to exercise the cloud path locally).
 */
export function heavyJobMode(): "inline" | "sandbox" {
  const v = process.env.RENDER_MODE?.toLowerCase();
  if (v === "inline" || v === "sandbox") return v;
  return process.env.VERCEL ? "sandbox" : "inline";
}

/** The cloud worker is usable: a snapshot is configured (docs/decisions-pending/cloud-renderer.md). */
export function cloudWorkerConfigured(): boolean {
  return !!process.env.RENDER_SANDBOX_SNAPSHOT_ID;
}

/** Heavy jobs can run in this deployment at all (in-process, or a configured cloud worker). */
export function heavyJobsAvailable(): boolean {
  return heavyJobMode() === "inline" ? true : cloudWorkerConfigured();
}

function defaultHeavyFlag(): boolean {
  // Inline on Vercel (RENDER_MODE=inline) has no ONNX budget — off, as before the cloud worker.
  if (heavyJobMode() === "inline") return !process.env.VERCEL;
  return cloudWorkerConfigured();
}

/**
 * Local Whisper transcription is CPU-heavy (~290 MB model, onnxruntime) — fine on Chris's
 * machine or in the cloud worker, unsuitable for a serverless function. Default: on locally, on
 * on Vercel when the cloud worker is configured (it runs there), else off — a transcript can
 * still be pasted manually. TRANSCRIPTION=on|off overrides.
 */
export function isAutoTranscriptionEnabled(): boolean {
  const flag = process.env.TRANSCRIPTION?.toLowerCase();
  if (flag === "on") return true;
  if (flag === "off") return false;
  return defaultHeavyFlag();
}

/**
 * Subject tracking (where Chris's face is, for motion-graphics placement) runs the UltraFace
 * ONNX detector over the take — same weight class as Whisper, same default (placement assumes
 * a centred framing and says so when it's off). SUBJECT_TRACKING=on|off overrides.
 */
export function isAutoSubjectTrackingEnabled(): boolean {
  const flag = process.env.SUBJECT_TRACKING?.toLowerCase();
  if (flag === "on") return true;
  if (flag === "off") return false;
  return defaultHeavyFlag();
}

/**
 * Person matte after upload (Motion v2: graphics behind Chris). Same default as tracking (ONNX +
 * ~26 MB model + minutes of CPU per take — the cloud worker runs it on Vercel).
 * PERSON_MATTE=on|off overrides. Takes without a matte still render — behind-subject graphics
 * fall back to the render-time job or render in front with a warning.
 */
export function isAutoPersonMatteEnabled(): boolean {
  const flag = process.env.PERSON_MATTE?.toLowerCase();
  if (flag === "on") return true;
  if (flag === "off") return false;
  return defaultHeavyFlag();
}
