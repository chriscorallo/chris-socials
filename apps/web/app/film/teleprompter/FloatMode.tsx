"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { HandoffStatus, useTakeHandoff } from "./useTakeHandoff";
import { PIP_CANVAS, drawPipFrame, layoutPip, type PipLayout } from "../../../lib/teleprompter/canvas";
import { SPEED_MAX, SPEED_MIN, advanceProgress, estimateSeconds, formatDuration, progressPerSecond, speedToWpm, wordCount } from "../../../lib/teleprompter/scroll";
import { VIDEO_ONLY_MIME_CANDIDATES, pickRecorderMime } from "../../../lib/teleprompter/recording";
import { PIP_FONT_SIZES, type PrompterSettings } from "../../../lib/teleprompter/settings";
import type { HandoffTarget } from "../../../lib/teleprompter/handoff";

type WebkitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: "inline" | "picture-in-picture" | "fullscreen") => void;
  webkitPresentationMode?: string;
};

type Support = { checked: boolean; pip: boolean; capture: boolean; recorder: boolean };

/**
 * Mode 2 — "Use iPhone Camera": the script is drawn on a <canvas>, streamed into a <video>
 * (canvas.captureStream) and floated with Picture-in-Picture, so it stays on top while Chris
 * records in the real Camera app (Cinematic, stabilization, HDR). Play/pause in the PiP window
 * pauses the scroll. If the live stream can't float (or stops when the app is in the
 * background), "Make a script video" pre-records the scroll into a normal video file, which
 * every iPhone can float. See docs/decisions-pending/teleprompter.md.
 */
export function FloatMode({
  text,
  settings,
  setSettings,
  target,
  mode,
  uploadManyHref,
  onRecordHere,
}: {
  text: string;
  settings: PrompterSettings;
  setSettings: (s: PrompterSettings) => void;
  target: HandoffTarget;
  mode: "blob" | "local";
  uploadManyHref: string;
  onRecordHere: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<WebkitVideo>(null);
  const layoutRef = useRef<PipLayout | null>(null);
  const progress = useRef(0);
  const startAt = useRef<number | null>(null);
  const last = useRef<number | null>(null);
  const pausedRef = useRef(false);
  const floatingRef = useRef(false); // entered PiP since the last Start tap
  const [support, setSupport] = useState<Support>({ checked: false, pip: false, capture: false, recorder: false });
  const [floating, setFloating] = useState(false);
  const [everFloated, setEverFloated] = useState(false);
  const [pipError, setPipError] = useState<string | null>(null);
  const [bakedUrl, setBakedUrl] = useState<string | null>(null);
  const [baking, setBaking] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const handoff = useTakeHandoff(target, mode);
  const words = wordCount(text);
  const wpm = speedToWpm(settings.speed);
  const perSecond = progressPerSecond(words, wpm);
  const live = useRef({ perSecond, delay: settings.pipDelaySec, baking: false });
  useEffect(() => {
    live.current = { perSecond, delay: settings.pipDelaySec, baking: baking != null };
  });

  // Feature detection (client only).
  useEffect(() => {
    const v = document.createElement("video") as WebkitVideo;
    const std = typeof document !== "undefined" && (document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled === true && typeof v.requestPictureInPicture === "function";
    const wk = typeof v.webkitSupportsPresentationMode === "function" && v.webkitSupportsPresentationMode("picture-in-picture");
    setSupport({
      checked: true,
      pip: std || wk,
      capture: typeof HTMLCanvasElement !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function",
      recorder: typeof MediaRecorder !== "undefined",
    });
  }, []);

  // Layout whenever the text or size changes.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    layoutRef.current = layoutPip(ctx, text, PIP_FONT_SIZES[settings.pipFontIndex] ?? 80);
  }, [text, settings.pipFontIndex]);

  const draw = useCallback(() => {
    const ctx = canvasRef.current?.getContext("2d");
    const layout = layoutRef.current;
    if (!ctx || !layout) return;
    const now = performance.now();
    const dt = last.current == null ? 0 : now - last.current;
    last.current = now;
    const startsIn = startAt.current == null ? 0 : Math.max(0, (startAt.current - now) / 1000);
    const scrolling = startAt.current != null && startsIn <= 0 && !pausedRef.current;
    if (scrolling && !live.current.baking) progress.current = advanceProgress(progress.current, dt, live.current.perSecond);
    drawPipFrame(ctx, layout, { progress: progress.current, startsIn, paused: pausedRef.current && startAt.current != null });
  }, []);

  // The draw loop runs on a timer, not requestAnimationFrame: rAF stops as soon as the page is
  // in the background, timers keep going while media is playing (that's the whole point here).
  useEffect(() => {
    const t = setInterval(draw, 1000 / 30);
    draw();
    return () => clearInterval(t);
  }, [draw]);

  // Live stream into the <video> (muted, inline) as soon as possible, so the tap on "Start"
  // can go straight to Picture-in-Picture inside the user gesture.
  useEffect(() => {
    if (!support.checked || !support.capture) return;
    const c = canvasRef.current;
    const v = videoRef.current;
    if (!c || !v || bakedUrl) return;
    const stream = c.captureStream(30);
    v.srcObject = stream;
    void v.play().catch(() => undefined);
    return () => {
      stream.getTracks().forEach((t) => t.stop());
    };
  }, [support, bakedUrl]);

  // PiP lifecycle + play/pause from the PiP window.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onEnter = () => {
      floatingRef.current = true;
      setFloating(true);
      setEverFloated(true);
    };
    const onLeave = () => {
      setFloating(false);
    };
    const onMode = () => (v.webkitPresentationMode === "picture-in-picture" ? onEnter() : onLeave());
    const onPause = () => {
      pausedRef.current = true;
    };
    const onPlay = () => {
      pausedRef.current = false;
    };
    v.addEventListener("enterpictureinpicture", onEnter);
    v.addEventListener("leavepictureinpicture", onLeave);
    v.addEventListener("webkitpresentationmodechanged", onMode);
    v.addEventListener("pause", onPause);
    v.addEventListener("play", onPlay);
    return () => {
      v.removeEventListener("enterpictureinpicture", onEnter);
      v.removeEventListener("leavepictureinpicture", onLeave);
      v.removeEventListener("webkitpresentationmodechanged", onMode);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("play", onPlay);
    };
  }, []);

  useEffect(() => () => {
    if (bakedUrl) URL.revokeObjectURL(bakedUrl);
  }, [bakedUrl]);

  function startFloating() {
    const v = videoRef.current;
    if (!v) return;
    setPipError(null);
    if (bakedUrl) v.currentTime = 0;
    else {
      progress.current = 0;
      startAt.current = performance.now() + settings.pipDelaySec * 1000;
      pausedRef.current = false;
    }
    // Some engines neither open the window nor reject (seen in WebKit for a live canvas
    // stream): if nothing has floated after a few seconds, say so and offer the fallbacks.
    floatingRef.current = false; // "entered since this tap"
    setTimeout(() => {
      if (!floatingRef.current) setPipError((e) => e ?? "The floating window didn't open for the live script on this phone.");
    }, 3500);
    // Must run inside the tap (user gesture): no awaits before the PiP request.
    void v.play().catch(() => undefined);
    try {
      if (typeof v.requestPictureInPicture === "function" && (document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled) {
        v.requestPictureInPicture().catch((err: unknown) => {
          if (typeof v.webkitSetPresentationMode === "function") {
            try {
              v.webkitSetPresentationMode("picture-in-picture");
              return;
            } catch {
              // fall through to the message
            }
          }
          setPipError(pipMessage(err));
        });
      } else if (typeof v.webkitSetPresentationMode === "function") {
        v.webkitSetPresentationMode("picture-in-picture");
      } else {
        setPipError("This browser can't float the script over other apps.");
      }
    } catch (err) {
      setPipError(pipMessage(err));
    }
  }

  function restart() {
    progress.current = 0;
    startAt.current = null;
    pausedRef.current = false;
    if (bakedUrl && videoRef.current) videoRef.current.currentTime = 0;
  }

  /** Fallback: record the whole scroll (with the start countdown) into a normal video file. */
  async function bakeScriptVideo() {
    const c = canvasRef.current;
    const v = videoRef.current;
    if (!c || !v || typeof MediaRecorder === "undefined") return;
    const total = settings.pipDelaySec + estimateSeconds(words, wpm) + 2;
    const stream = c.captureStream(30);
    const mime = pickRecorderMime((t) => MediaRecorder.isTypeSupported(t), VIDEO_ONLY_MIME_CANDIDATES);
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 2_500_000 });
    } catch {
      rec = new MediaRecorder(stream);
    }
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    setBaking(0);
    progress.current = 0;
    pausedRef.current = false;
    startAt.current = performance.now() + settings.pipDelaySec * 1000;
    const t0 = performance.now();
    rec.start(1000);
    // Drive progress from wall-clock time during the bake so timer jitter can't skew it.
    const tick = setInterval(() => {
      const el = (performance.now() - t0) / 1000;
      progress.current = Math.min(1, Math.max(0, (el - settings.pipDelaySec) * perSecond));
      setBaking(Math.min(1, el / total));
      if (el >= total) {
        clearInterval(tick);
        rec.stop();
      }
    }, 100);
    await done;
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: rec.mimeType || mime || "video/mp4" });
    setBaking(null);
    startAt.current = null;
    progress.current = 0;
    if (!blob.size) {
      setPipError("Couldn't make the script video on this browser. Use “Record here” instead.");
      return;
    }
    const url = URL.createObjectURL(blob);
    v.srcObject = null;
    v.src = url;
    v.loop = false;
    setBakedUrl(url);
    void v.play().catch(() => undefined);
  }

  function patch(next: Partial<PrompterSettings>) {
    setSettings({ ...settings, ...next });
  }

  const unsupported = support.checked && (!support.pip || !support.capture);
  const sending = handoff.state.phase !== "idle" || handoff.finishing != null;

  return (
    <div className="flex flex-col gap-4" data-testid="float-mode">
      {/* What floats */}
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black" style={{ aspectRatio: `${PIP_CANVAS.width} / ${PIP_CANVAS.height}` }}>
        <video ref={videoRef} muted playsInline autoPlay className="h-full w-full object-contain" data-testid="pip-video" />
        {floating && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-center text-[15px] font-semibold text-[var(--color-gold-400)]">
            Floating — swipe up and open Camera
          </div>
        )}
        {baking != null && (
          <div className="absolute inset-x-0 bottom-0 bg-black/70 px-3 py-2 text-[13px]">
            Making your script video… {Math.round(baking * 100)}% (plays through once)
          </div>
        )}
      </div>
      {/* Drawing surface (kept in the page — some engines only paint attached canvases) */}
      <canvas ref={canvasRef} width={PIP_CANVAS.width} height={PIP_CANVAS.height} className="pointer-events-none fixed left-0 top-0 h-px w-px opacity-0" aria-hidden />

      {unsupported ? (
        <div className="panel flex flex-col gap-3 p-4" role="alert">
          <p className="text-[16px] font-semibold">This browser can&apos;t float the script</p>
          <p className="text-[14px] text-[var(--color-text-muted)]">
            Floating over the Camera app needs Picture-in-Picture, which isn&apos;t available here. On iPhone, open the app in Safari. Or record right here with the script under the camera.
          </p>
          <button type="button" className="btn btn-primary w-full" onClick={onRecordHere}>
            Record here instead
          </button>
        </div>
      ) : (
        <>
          <div className="panel flex flex-col divide-y divide-[var(--color-border)] px-4">
            <SettingRow label="Text size">
              <Stepper value={`${settings.pipFontIndex + 1}`} dec={() => patch({ pipFontIndex: Math.max(0, settings.pipFontIndex - 1) })} inc={() => patch({ pipFontIndex: Math.min(PIP_FONT_SIZES.length - 1, settings.pipFontIndex + 1) })} disabled={!!bakedUrl || baking != null} />
            </SettingRow>
            <SettingRow label="Speed" hint={`About ${formatDuration(estimateSeconds(words, wpm))} for the whole script`}>
              <Stepper value={`${settings.speed}`} dec={() => patch({ speed: Math.max(SPEED_MIN, settings.speed - 1) })} inc={() => patch({ speed: Math.min(SPEED_MAX, settings.speed + 1) })} disabled={!!bakedUrl || baking != null} />
            </SettingRow>
            <SettingRow label="Wait before scrolling" hint="Time to open Camera and hit record">
              <div className="flex rounded-full bg-white/[0.07] p-1">
                {([0, 5, 10] as const).map((s) => (
                  <button key={s} type="button" disabled={!!bakedUrl || baking != null} onClick={() => patch({ pipDelaySec: s })} className={`min-h-[40px] min-w-[44px] rounded-full px-2.5 text-[14px] ${settings.pipDelaySec === s ? "bg-white/20 font-semibold" : "text-[var(--color-text-muted)]"}`}>
                    {s === 0 ? "Off" : `${s}s`}
                  </button>
                ))}
              </div>
            </SettingRow>
          </div>

          <button type="button" className="btn btn-primary w-full !min-h-[56px] !text-[17px]" onClick={startFloating} disabled={!support.checked || baking != null} data-testid="start-floating">
            {everFloated ? "Start floating script again" : "Start floating script"}
          </button>
          {everFloated && (
            <button type="button" className="btn btn-ghost w-full" onClick={restart}>
              Back to the top
            </button>
          )}
          {pipError && (
            <div className="panel flex flex-col gap-2.5 p-4" role="alert">
              <p className="text-[14.5px]">{pipError}</p>
              {support.recorder && !bakedUrl && (
                <button type="button" className="btn btn-ghost w-full" onClick={() => void bakeScriptVideo()} disabled={baking != null}>
                  Make a script video ({formatDuration(settings.pipDelaySec + estimateSeconds(words, wpm))}) and float that
                </button>
              )}
              <button type="button" className="btn btn-ghost w-full" onClick={onRecordHere}>
                Record here instead
              </button>
            </div>
          )}

          <ol className="panel flex list-none flex-col gap-2.5 p-4 text-[15px] leading-snug">
            <Step n={1}>Tap <b>Start floating script</b>.</Step>
            <Step n={2}>Swipe up to go home and open <b>Camera</b>.</Step>
            <Step n={3}>Record — the script floats on top. Tap the small window to pause or play.</Step>
            <Step n={4}>Come back here and upload your clip.</Step>
          </ol>
          {everFloated && !pipError && support.recorder && !bakedUrl && (
            <button type="button" className="link-quiet -mt-1 text-left text-[13.5px]" onClick={() => void bakeScriptVideo()} disabled={baking != null}>
              Script froze while you were in Camera? Make a script video instead ({formatDuration(settings.pipDelaySec + estimateSeconds(words, wpm))})
            </button>
          )}
        </>
      )}

      <div className="flex flex-col gap-2.5">
        {sending ? (
          <HandoffStatus state={handoff.state} finishing={handoff.finishing} onSkip={handoff.skip} onRetry={() => handoff.state.phase === "failed" && void handoff.send(handoff.state.failed)} />
        ) : (
          <label className="btn btn-primary w-full cursor-pointer !min-h-[56px] !text-[17px]" data-testid="upload-clip">
            <input
              ref={fileRef}
              type="file"
              accept="video/*"
              multiple
              className="sr-only"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) void handoff.send(files);
              }}
            />
            Upload my clip
          </label>
        )}
        <Link href={uploadManyHref} className="btn btn-ghost w-full">
          Filmed several videos? Upload many clips
        </Link>
      </div>
    </div>
  );
}

function pipMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") return "The floating window needs a tap to start — tap Start floating script again.";
  return "This browser wouldn't float the live script.";
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-gold-500)]/20 text-[14px] font-semibold text-[var(--color-gold-400)]">{n}</span>
      <span className="pt-0.5">{children}</span>
    </li>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[56px] items-center justify-between gap-3 py-2">
      <span className="min-w-0">
        <span className="block text-[15px]">{label}</span>
        {hint && <span className="block text-[12.5px] text-[var(--color-text-faint)]">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

function Stepper({ value, dec, inc, disabled }: { value: string; dec: () => void; inc: () => void; disabled?: boolean }) {
  return (
    <div className="flex shrink-0 items-center rounded-full bg-white/[0.07]">
      <button type="button" className="h-11 w-11 text-[22px] disabled:opacity-40" onClick={dec} disabled={disabled} aria-label="Less">−</button>
      <span className="min-w-[24px] text-center tabular-nums">{value}</span>
      <button type="button" className="h-11 w-11 text-[22px] disabled:opacity-40" onClick={inc} disabled={disabled} aria-label="More">+</button>
    </div>
  );
}
