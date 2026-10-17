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
 * Local Whisper transcription is CPU-heavy (~290 MB model, onnxruntime) — fine on Chris's
 * machine, unsuitable for a serverless function. Default: on locally, off on Vercel, where a
 * transcript can still be pasted manually. TRANSCRIPTION=on|off overrides.
 */
export function isAutoTranscriptionEnabled(): boolean {
  const flag = process.env.TRANSCRIPTION?.toLowerCase();
  if (flag === "on") return true;
  if (flag === "off") return false;
  return !process.env.VERCEL;
}

/**
 * Subject tracking (where Chris's face is, for motion-graphics placement) runs the UltraFace
 * ONNX detector over the take — same weight class as Whisper. Same default: on locally, off on
 * Vercel (placement then assumes a centred framing and says so). SUBJECT_TRACKING=on|off
 * overrides.
 */
export function isAutoSubjectTrackingEnabled(): boolean {
  const flag = process.env.SUBJECT_TRACKING?.toLowerCase();
  if (flag === "on") return true;
  if (flag === "off") return false;
  return !process.env.VERCEL;
}

/**
 * Person matte after upload (Motion v2: graphics behind Chris). Like tracking: on locally, off on
 * Vercel (ONNX + ~26 MB model + minutes of CPU per take). PERSON_MATTE=on|off overrides. Takes
 * without a matte still render — behind-subject graphics fall back to the render-time job or
 * render in front with a warning.
 */
export function isAutoPersonMatteEnabled(): boolean {
  const flag = process.env.PERSON_MATTE?.toLowerCase();
  if (flag === "on") return true;
  if (flag === "off") return false;
  return !process.env.VERCEL;
}
