"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PrompterScroller, type PrompterHandle } from "./PrompterScroller";
import { HandoffStatus, useTakeHandoff } from "./useTakeHandoff";
import { FONT_SIZES, SPEED_MAX, SPEED_MIN, formatDuration, speedToWpm } from "../../../lib/teleprompter/scroll";
import {
  AUDIO_BITRATE,
  baseMime,
  cameraConstraints,
  pickRecorderMime,
  settingsLabel,
  supportsQuality,
  takeFileName,
  videoBitrateFor,
} from "../../../lib/teleprompter/recording";
import type { PrompterSettings } from "../../../lib/teleprompter/settings";
import type { HandoffTarget } from "../../../lib/teleprompter/handoff";

type Phase = "starting" | "ready" | "countdown" | "recording" | "review" | "error";
type Take = { file: File; url: string | null; seconds: number };

/**
 * Mode 1 — "Record here": front camera (or back) + the script scrolling at the TOP of the
 * screen, right under the lens, so Chris's eyes stay near the camera. MediaRecorder writes the
 * take (MP4/H.264 on iPhone); Retake / Keep & film another / Use this take; "Use" sends the
 * take(s) into the video through the normal upload plumbing and opens the editor.
 */
export function RecordMode({
  text,
  settings,
  setSettings,
  target,
  mode,
  onExit,
  onUseIphoneCamera,
}: {
  text: string;
  settings: PrompterSettings;
  setSettings: (s: PrompterSettings) => void;
  target: HandoffTarget;
  mode: "blob" | "local";
  onExit: () => void;
  onUseIphoneCamera: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const prompter = useRef<PrompterHandle | null>(null);
  const phaseRef = useRef<Phase>("starting");
  const [phase, setPhaseState] = useState<Phase>("starting");
  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [caps, setCaps] = useState({ fourK: false, sixty: false });
  const [paused, setPaused] = useState(true);
  const [count, setCount] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [kept, setKept] = useState<Take[]>([]);
  const [current, setCurrent] = useState<Take | null>(null);
  const [sheet, setSheet] = useState(false);
  const [landscape, setLandscape] = useState(false);
  const takeCount = useRef(0);
  const handoff = useTakeHandoff(target, mode);
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  });

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const stopRecording = useCallback(() => {
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.requestData();
      } catch {
        // not supported everywhere — stop() still flushes
      }
      rec.stop();
    }
    setPaused(true);
  }, []);

  const startCamera = useCallback(async () => {
    stopTracks();
    setPhase("starting");
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser can't use the camera here. Open the app in Safari (not inside another app) and try again.");
      setPhase("error");
      return;
    }
    const s = settingsRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints({ facing: s.facing, quality: s.quality, fps: s.fps, voiceCleanup: s.voiceCleanup }));
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        await v.play().catch(() => undefined);
      }
      const vt = stream.getVideoTracks()[0];
      if (vt) {
        setLabel(settingsLabel(vt.getSettings()));
        setCaps(supportsQuality(typeof vt.getCapabilities === "function" ? (vt.getCapabilities() as never) : null));
        const onLost = () => {
          // Phone call, Siri, another app grabbed the camera: keep what was recorded so far.
          if (phaseRef.current === "recording") stopRecording();
        };
        vt.addEventListener("ended", onLost);
        vt.addEventListener("mute", onLost);
      }
      setPhase("ready");
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Camera access is off. On iPhone: Settings › Apps › Safari › Camera (and Microphone) → Allow, then tap Try again."
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "No camera was found on this device."
            : name === "NotReadableError"
              ? "The camera is busy in another app. Close that app and tap Try again."
              : "The camera didn't start. Tap Try again.",
      );
      setPhase("error");
    }
  }, [setPhase, stopRecording, stopTracks]);

  // Camera on mount; off on unmount. Takes' object URLs are revoked when replaced/unmounted.
  useEffect(() => {
    void startCamera();
    return () => {
      const rec = recRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [startCamera]);

  useEffect(() => {
    return () => {
      if (current?.url) URL.revokeObjectURL(current.url);
    };
  }, [current]);

  // Keep the screen awake while this screen is open (Wake Lock: iOS 16.4+); re-acquire after
  // returning to the app. Older iPhones: the live camera preview keeps playing, and the tip in
  // the settings sheet suggests Auto-Lock → Never for long sessions.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    const acquire = async () => {
      try {
        if (nav.wakeLock && document.visibilityState === "visible") lock = await nav.wakeLock.request("screen");
      } catch {
        lock = null;
      }
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        // Leaving the app mid-take: finish the take cleanly (it shows up for review on return).
        if (phaseRef.current === "recording") stopRecording();
        if (phaseRef.current === "countdown") setPhase("ready");
      } else {
        void acquire();
        const live = streamRef.current?.getVideoTracks().some((t) => t.readyState === "live");
        if (!live && (phaseRef.current === "ready" || phaseRef.current === "starting")) void startCamera();
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release().catch(() => undefined);
    };
  }, [setPhase, startCamera, stopRecording]);

  // Full-screen: the page underneath must not scroll/bounce.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const check = () =>setLandscape(window.innerWidth > window.innerHeight && window.matchMedia("(pointer: coarse)").matches);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Recording timer.
  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => setElapsed((performance.now() - startedAtRef.current) / 1000), 250);
    return () => clearInterval(t);
  }, [phase]);

  const finalizeTake = useCallback(
    (type: string) => {
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      recRef.current = null;
      if (blob.size === 0) {
        setError("That take came out empty. Try again.");
        setPhase("ready");
        return;
      }
      takeCount.current += 1;
      const file = new File([blob], takeFileName(takeCount.current, type, new Date()), { type: baseMime(type) });
      setCurrent({ file, url: URL.createObjectURL(file), seconds: (performance.now() - startedAtRef.current) / 1000 });
      setPhase("review");
    },
    [setPhase],
  );

  const beginRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const mime = typeof MediaRecorder !== "undefined" ? pickRecorderMime((t) => MediaRecorder.isTypeSupported(t)) : "";
    if (typeof MediaRecorder === "undefined") {
      setError("This browser can't record video. Use “iPhone Camera” instead.");
      setPhase("error");
      return;
    }
    const vs = stream.getVideoTracks()[0]?.getSettings() ?? {};
    const opts: MediaRecorderOptions = { videoBitsPerSecond: videoBitrateFor(vs.width ?? 1080, vs.height ?? 1920, vs.frameRate ?? 30), audioBitsPerSecond: AUDIO_BITRATE };
    if (mime) opts.mimeType = mime;
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, opts);
    } catch {
      rec = new MediaRecorder(stream);
    }
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => finalizeTake(rec.mimeType || mime || "video/mp4");
    rec.onerror = () => {
      if (rec.state !== "inactive") rec.stop();
    };
    recRef.current = rec;
    // 1 s slices: if the phone interrupts the take, everything up to the last second is kept.
    rec.start(1000);
    startedAtRef.current = performance.now();
    setElapsed(0);
    prompter.current?.reset();
    setPaused(false);
    setPhase("recording");
  }, [finalizeTake, setPhase]);

  // 3-2-1 countdown, then record. Tapping the record button again cancels.
  useEffect(() => {
    if (phase !== "countdown") return;
    if (count <= 0) {
      beginRecording();
      return;
    }
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, count, beginRecording]);

  function onRecordButton() {
    if (phase === "recording") return stopRecording();
    if (phase === "countdown") return setPhase("ready");
    if (phase !== "ready") return;
    setError(null);
    prompter.current?.reset();
    if (settings.countdown) {
      setCount(3);
      setPhase("countdown");
    } else beginRecording();
  }

  function patch(next: Partial<PrompterSettings>, restart = false) {
    setSettings({ ...settings, ...next });
    settingsRef.current = { ...settings, ...next };
    if (restart && phase !== "recording" && phase !== "countdown") void startCamera();
  }

  function retake() {
    setCurrent(null); // effect revokes the URL
    setPhase(streamRef.current ? "ready" : "starting");
    if (!streamRef.current) void startCamera();
  }

  function keepAndFilmAnother() {
    if (!current) return;
    setKept((k) => [...k, { file: current.file, url: null, seconds: current.seconds }]);
    retake();
  }

  async function sendTakes() {
    if (!current) return;
    const files = [...kept.map((k) => k.file), current.file];
    stopTracks(); // free the camera (and memory) while uploading
    await handoff.send(files);
  }

  function exit() {
    const n = kept.length + (current ? 1 : 0);
    if (n > 0 && !window.confirm(`Leave without using ${n === 1 ? "this take" : `these ${n} takes`}? ${n === 1 ? "It" : "They"} will be discarded.`)) return;
    stopTracks();
    onExit();
  }

  const fontPx = FONT_SIZES[settings.fontIndex] ?? 36;
  const running = phase === "recording" ? !paused : !settings.scrollOnlyWhileRecording && !paused && phase === "ready";
  const mirrored = settings.facing === "user";

  // ── Review ──────────────────────────────────────────────────────────────────────────────
  if (phase === "review" && current) {
    const sending = handoff.state.phase !== "idle" || handoff.finishing != null;
    return (
      <div className="fixed inset-0 z-[100] flex flex-col bg-black text-white" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }} data-testid="take-review">
        <div className="flex min-h-[52px] items-center justify-between px-4">
          <p className="text-[16px] font-semibold">
            Take {takeCount.current} · {formatDuration(current.seconds)}
          </p>
          {kept.length > 0 && <p className="text-[13px] text-white/60">+{kept.length} kept</p>}
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center px-4">
          {current.url && <video src={current.url} controls playsInline className="max-h-full w-full rounded-2xl bg-black object-contain" data-testid="take-video" />}
        </div>
        <div className="flex flex-col gap-2.5 p-4">
          {sending ? (
            <HandoffStatus
              state={handoff.state}
              finishing={handoff.finishing}
              onSkip={handoff.skip}
              onRetry={() => void (handoff.state.phase === "failed" ? handoff.send(handoff.state.failed) : sendTakes())}
              saveHref={current.url}
              saveName={current.file.name}
            />
          ) : (
            <>
              <button type="button" className="btn btn-primary w-full !min-h-[56px] !text-[17px]" onClick={() => void sendTakes()} data-testid="use-take">
                {kept.length ? `Use this take (+${kept.length} kept)` : "Use this take"}
              </button>
              <div className="grid grid-cols-2 gap-2.5">
                <button type="button" className="btn btn-ghost !min-h-[50px]" onClick={retake} data-testid="retake">
                  Retake
                </button>
                <button type="button" className="btn btn-ghost !min-h-[50px]" onClick={keepAndFilmAnother}>
                  Keep &amp; film another
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Camera + prompter ───────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-[100] overflow-hidden bg-black text-white" data-testid="record-mode">
      <video
        ref={(el) => {
          videoRef.current = el;
          // Coming back from the review screen: re-attach the still-running camera.
          if (el && streamRef.current && el.srcObject !== streamRef.current) {
            el.srcObject = streamRef.current;
            void el.play().catch(() => undefined);
          }
        }}
        muted
        playsInline
        autoPlay className="absolute inset-0 h-full w-full object-cover" style={{ transform: mirrored ? "scaleX(-1)" : undefined }} />

      {/* Script — top of the screen, right under the front camera */}
      <div
        className="absolute inset-x-0 top-0"
        style={{ height: "46%", paddingTop: "env(safe-area-inset-top)", background: "linear-gradient(to bottom, rgba(0,0,0,0.78), rgba(0,0,0,0.55) 75%, rgba(0,0,0,0))" }}
      >
        <PrompterScroller
          text={text}
          fontPx={fontPx}
          wpm={speedToWpm(settings.speed)}
          running={running}
          mirror={settings.mirrorText}
          onTap={() => setPaused((p) => !p)}
          handleRef={prompter}
          readingLine={0.14}
        />
      </div>

      {landscape && (
        <div className="absolute inset-x-4 top-1/2 -translate-y-1/2 rounded-2xl bg-black/75 p-4 text-center text-[15px]">Hold your phone upright for a 9:16 video.</div>
      )}

      {phase === "countdown" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-live="assertive">
          <span className="text-[120px] font-bold leading-none text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.7)]">{count > 0 ? count : ""}</span>
        </div>
      )}

      {phase === "error" && (
        <div className="absolute inset-x-4 top-1/2 flex -translate-y-1/2 flex-col gap-3 rounded-3xl border border-white/10 bg-[#121216] p-5" role="alert">
          <p className="text-[17px] font-semibold">Camera</p>
          <p className="text-[14.5px] text-white/75">{error}</p>
          <button type="button" className="btn btn-primary w-full" onClick={() => void startCamera()}>
            Try again
          </button>
          <button type="button" className="btn btn-ghost w-full" onClick={() => { stopTracks(); onUseIphoneCamera(); }}>
            Use iPhone Camera instead
          </button>
          <button type="button" className="btn btn-ghost w-full" onClick={exit}>
            Close
          </button>
        </div>
      )}

      {/* Controls */}
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-3 px-4 pt-10" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)", background: "linear-gradient(to top, rgba(0,0,0,0.75), rgba(0,0,0,0))" }}>
        {error && phase !== "error" && <p className="text-center text-[13px] text-[var(--color-rose-400)]">{error}</p>}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
            {phase === "recording" ? (
              <span className="flex items-center gap-1.5 rounded-full bg-[var(--color-rose-500)] px-2.5 py-1 font-semibold tabular-nums" data-testid="rec-timer">
                <span className="h-2 w-2 animate-pulse rounded-full bg-white" aria-hidden />
                {formatDuration(elapsed)}
              </span>
            ) : (
              label && <span className="rounded-full bg-black/50 px-2.5 py-1 text-white/80" data-testid="camera-label">{label}</span>
            )}
            {kept.length > 0 && phase !== "recording" && <span className="rounded-full bg-black/50 px-2.5 py-1 text-white/80">{kept.length} kept</span>}
          </div>
          <div className="flex shrink-0 items-center rounded-full bg-black/50">
            <IconButton label="Slower" onClick={() => patch({ speed: Math.max(SPEED_MIN, settings.speed - 1) })} disabled={settings.speed <= SPEED_MIN}>
              <span className="text-[22px] leading-none">−</span>
            </IconButton>
            <span className="min-w-[64px] text-center text-[13px] tabular-nums text-white/85">Speed {settings.speed}</span>
            <IconButton label="Faster" onClick={() => patch({ speed: Math.min(SPEED_MAX, settings.speed + 1) })} disabled={settings.speed >= SPEED_MAX}>
              <span className="text-[22px] leading-none">+</span>
            </IconButton>
          </div>
        </div>
        {phase === "ready" && settings.scrollOnlyWhileRecording && (
          <p className="text-center text-[12.5px] text-white/60">The script scrolls when you record · tap it to pause · drag to move</p>
        )}
        <div className="grid grid-cols-5 items-center">
          <IconButton label="Close" onClick={exit} disabled={phase === "recording"}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
          </IconButton>
          <IconButton label="Switch camera" onClick={() => patch({ facing: settings.facing === "user" ? "environment" : "user" }, true)} disabled={phase === "recording" || phase === "countdown"}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
              <path d="M9.5 13.5a2.5 2.5 0 0 0 4.6 1.3M14.5 12.5a2.5 2.5 0 0 0-4.6-1.3" />
            </svg>
          </IconButton>
          <div className="flex justify-center">
            <button
              type="button"
              onClick={onRecordButton}
              disabled={phase === "starting" || phase === "error"}
              aria-label={phase === "recording" ? "Stop recording" : phase === "countdown" ? "Cancel countdown" : "Start recording"}
              className="flex h-[76px] w-[76px] items-center justify-center rounded-full border-4 border-white/90 disabled:opacity-40"
              data-testid="record-button"
            >
              <span className={`block bg-[var(--color-rose-500)] transition-all ${phase === "recording" ? "h-7 w-7 rounded-md" : "h-[58px] w-[58px] rounded-full"}`} />
            </button>
          </div>
          <IconButton label="Script settings" onClick={() => setSheet(true)} disabled={phase === "recording"}>
            <span className="text-[19px] font-semibold leading-none">Aa</span>
          </IconButton>
          <IconButton label={running ? "Pause script" : "Play script"} onClick={() => setPaused((p) => !p)} disabled={phase !== "recording" && settings.scrollOnlyWhileRecording}>
            {running ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M7 5v14l12-7z" /></svg>
            )}
          </IconButton>
        </div>
      </div>

      {sheet && (
        <SettingsSheet settings={settings} caps={caps} onClose={() => setSheet(false)} patch={patch} />
      )}
    </div>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="mx-auto flex h-11 w-11 items-center justify-center rounded-full text-white active:bg-white/15 disabled:opacity-35">
      {children}
    </button>
  );
}

function SettingsSheet({ settings, caps, onClose, patch }: { settings: PrompterSettings; caps: { fourK: boolean; sixty: boolean }; onClose: () => void; patch: (p: Partial<PrompterSettings>, restart?: boolean) => void }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        className="max-h-[75%] overflow-y-auto rounded-t-3xl border-t border-white/10 bg-[#121216] px-4 pt-3"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Script settings"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/25" aria-hidden />
        <Row label="Text size">
          <Stepper value={`${settings.fontIndex + 1}`} dec={() => patch({ fontIndex: Math.max(0, settings.fontIndex - 1) })} inc={() => patch({ fontIndex: Math.min(FONT_SIZES.length - 1, settings.fontIndex + 1) })} />
        </Row>
        <Row label="Speed">
          <Stepper value={`${settings.speed}`} dec={() => patch({ speed: Math.max(SPEED_MIN, settings.speed - 1) })} inc={() => patch({ speed: Math.min(SPEED_MAX, settings.speed + 1) })} />
        </Row>
        <Toggle label="Scroll only while recording" on={settings.scrollOnlyWhileRecording} set={(v) => patch({ scrollOnlyWhileRecording: v })} />
        <Toggle label="3-2-1 countdown" on={settings.countdown} set={(v) => patch({ countdown: v })} />
        <Toggle label="Mirror text (for teleprompter glass)" on={settings.mirrorText} set={(v) => patch({ mirrorText: v })} />
        <Toggle label="Voice cleanup (noisy places)" hint="Off = your natural voice. On = phone-call style noise filtering." on={settings.voiceCleanup} set={(v) => patch({ voiceCleanup: v }, true)} />
        {(caps.fourK || settings.quality === "4k") && (
          <Row label="Quality">
            <Seg options={[["1080", "1080p"], ["4k", "4K"]]} value={settings.quality} set={(v) => patch({ quality: v as PrompterSettings["quality"] }, true)} />
          </Row>
        )}
        {(caps.sixty || settings.fps === 60) && (
          <Row label="Frame rate">
            <Seg options={[["30", "30fps"], ["60", "60fps"]]} value={String(settings.fps)} set={(v) => patch({ fps: v === "60" ? 60 : 30 }, true)} />
          </Row>
        )}
        <p className="mt-2 text-[12px] leading-snug text-white/50">
          If your screen dims during long takes: Settings › Display &amp; Brightness › Auto-Lock › Never while filming.
        </p>
        <button type="button" className="btn btn-primary mt-4 w-full" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[52px] items-center justify-between gap-3 border-b border-white/[0.07] py-1.5">
      <span className="text-[15px]">{label}</span>
      {children}
    </div>
  );
}

function Stepper({ value, dec, inc }: { value: string; dec: () => void; inc: () => void }) {
  return (
    <div className="flex items-center rounded-full bg-white/[0.07]">
      <button type="button" className="h-11 w-11 text-[22px]" onClick={dec} aria-label="Less">−</button>
      <span className="min-w-[28px] text-center tabular-nums">{value}</span>
      <button type="button" className="h-11 w-11 text-[22px]" onClick={inc} aria-label="More">+</button>
    </div>
  );
}

function Toggle({ label, hint, on, set }: { label: string; hint?: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="flex min-h-[52px] cursor-pointer items-center justify-between gap-3 border-b border-white/[0.07] py-1.5">
      <span className="min-w-0">
        <span className="block text-[15px]">{label}</span>
        {hint && <span className="block text-[12px] text-white/50">{hint}</span>}
      </span>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} className="!h-6 !w-6" />
    </label>
  );
}

function Seg({ options, value, set }: { options: [string, string][]; value: string; set: (v: string) => void }) {
  return (
    <div className="flex rounded-full bg-white/[0.07] p-1">
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => set(v)} className={`min-h-[40px] rounded-full px-3.5 text-[14px] ${value === v ? "bg-white/20 font-semibold" : "text-white/70"}`}>
          {l}
        </button>
      ))}
    </div>
  );
}
