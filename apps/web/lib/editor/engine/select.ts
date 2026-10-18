/**
 * Which preview engine runs — PURE (tested). The compositor (WebCodecs decode → one WebGL
 * canvas, Web Audio master clock) is the default wherever the browser can run it and every
 * take the edit uses has its 720p preview proxy (our own H.264 + AAC, keyframe every 0.5 s —
 * the only files the compositor's demuxer is built for). Otherwise the <video>-pool engine.
 *
 * Kill switches: `?engine=video` / `?engine=compositor` on the editor URL, or
 * localStorage["chris-editor-engine"] = "video" (survives reloads on Chris's phone).
 */

export type EngineKind = "compositor" | "video";

export interface EngineCaps {
  videoDecoder: boolean;
  webgl2: boolean;
  audioContext: boolean;
}

export interface EngineChoice {
  engine: EngineKind;
  reason: string;
}

export function chooseEngine(opts: {
  caps: EngineCaps;
  /** the takes the edit's clips use */
  assets: Array<{ proxied?: boolean }>;
  override?: string | null;
}): EngineChoice {
  const o = opts.override;
  if (o === "video") return { engine: "video", reason: "forced (?engine=video)" };
  const forced = o === "compositor";
  if (!opts.caps.videoDecoder) return { engine: "video", reason: "no WebCodecs VideoDecoder" };
  if (!opts.caps.webgl2) return { engine: "video", reason: "no WebGL2" };
  if (!opts.assets.length) return { engine: "video", reason: "no takes" };
  if (!opts.assets.every((a) => a.proxied)) return { engine: "video", reason: "a take has no preview proxy yet" };
  return { engine: "compositor", reason: forced ? "forced (?engine=compositor)" : opts.caps.audioContext ? "default" : "default (no Web Audio — silent wall clock)" };
}

export function browserEngineCaps(): EngineCaps {
  if (typeof window === "undefined") return { videoDecoder: false, webgl2: false, audioContext: false };
  // Presence checks only — creating a WebGL context just to probe would cost a context setup
  // during hydration. If the real context then fails, the compositor falls back
  // (compositor.ts: remembers "video" and reloads once).
  const w = window as unknown as { VideoDecoder?: unknown; WebGL2RenderingContext?: unknown; AudioContext?: unknown; webkitAudioContext?: unknown };
  return { videoDecoder: typeof w.VideoDecoder === "function", webgl2: typeof w.WebGL2RenderingContext === "function", audioContext: !!(w.AudioContext ?? w.webkitAudioContext) };
}

export function engineOverride(): string | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search).get("engine");
  if (q) return q;
  try {
    return window.localStorage.getItem("chris-editor-engine");
  } catch {
    return null;
  }
}
