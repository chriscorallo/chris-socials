"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PrompterScroller, type PrompterHandle } from "./PrompterScroller";
import { FONT_SIZES, SPEED_MAX, SPEED_MIN, formatDuration, speedToWpm } from "../../../lib/teleprompter/scroll";
import {
  AUDIO_BITRATE,
  baseMime,
  cameraConstraints,
  pickRecorderMime,
  settingsLabel,
  supportsQuality,
  videoBitrateFor,
} from "../../../lib/teleprompter/recording";
import {
  newSegmentKey,
  nextSegmentIndex,
  rewindProgress,
  resumeProgress,
  segmentBar,
  segmentFileName,
  segmentsFromDraft,
  totalSeconds,
  uploadSegmentWithRetry,
  uploadSummary,
  wantsCountdown,
  type LocalSegment,
} from "../../../lib/teleprompter/segments";
import { uploadRawTake } from "../../../lib/upload-client";
import type { PrompterSettings } from "../../../lib/teleprompter/settings";
import type { HandoffTarget } from "../../../lib/teleprompter/handoff";
import type { PrompterDraft } from "../../../lib/teleprompter/data";
import { deleteDraftSegment, finishRecordingDraft, getRecordingDraft, saveRecordingDraft, startRecordingDraft } from "./actions";
import { FinishingCard, useOpenEditor } from "../../upload/OpenEditor";

type Phase = "starting" | "ready" | "countdown" | "recording" | "error";
type Overlay = null | { kind: "preview" } | { kind: "finishing" | "saving"; error: string | null };
type Session = { contentItemId: string; recordingSessionId: string };

/**
 * Mode 1 — "Record here", TikTok-style: the big button records a PART; tap again to pause (the
 * part is done). Record the next part whenever you're ready — now, or hours/days later
 * ("Continue filming": the parts are a server-side DRAFT of the video). Each part is its own
 * MediaRecorder file (robust on iPhone — no MediaRecorder.pause()), uploaded in the background
 * the moment it's recorded (retries; idempotent by part key), so a dead phone or a closed tab
 * loses at most the part being recorded. The script remembers where it paused.
 * "Finish" turns the parts into the video: captions → starter edit of ALL parts in order →
 * style cut → the editor. See docs/decisions-pending/segmented-recording-drafts.md.
 */
export function RecordMode({
  text,
  fingerprint,
  settings,
  setSettings,
  target,
  draft,
  mode,
  onExit,
  onUseIphoneCamera,
  onDraftChange,
}: {
  text: string;
  /** textFingerprint(text) — ties the saved script position to this exact text. */
  fingerprint: string;
  settings: PrompterSettings;
  setSettings: (s: PrompterSettings) => void;
  target: HandoffTarget;
  /** The video's open recording draft (Continue filming), or null. */
  draft: PrompterDraft | null;
  mode: "blob" | "local";
  onExit: () => void;
  onUseIphoneCamera: () => void;
  onDraftChange: (d: PrompterDraft | null) => void;
}) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const partStartRef = useRef(0);
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
  const [sheet, setSheet] = useState(false);
  const [landscape, setLandscape] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [canRewind, setCanRewind] = useState(false);
  const { finishing, openEditor, skip } = useOpenEditor();

  // Parts: state for rendering, a ref for the background uploader.
  const [segments, setSegmentsState] = useState<LocalSegment[]>(() => segmentsFromDraft(draft));
  const segsRef = useRef<LocalSegment[]>(segments);
  const setSegments = useCallback((fn: (s: LocalSegment[]) => LocalSegment[]) => {
    segsRef.current = fn(segsRef.current);
    setSegmentsState(segsRef.current);
  }, []);
  const partsThisVisit = useRef(0);
  const nextIndexRef = useRef(0);
  const [visitParts, setVisitParts] = useState(0);
  const sessionRef = useRef<Session | null>(draft ? { contentItemId: draft.contentItemId, recordingSessionId: draft.recordingSessionId } : null);
  const sessionPromise = useRef<Promise<Session | { error: string }> | null>(null);
  const pumping = useRef(false);
  const deleting = useRef(new Set<string>());

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  });

  // ── Draft session + background uploads ────────────────────────────────────────────────
  const ensureSession = useCallback(async (): Promise<Session | { error: string }> => {
    if (sessionRef.current) return sessionRef.current;
    if (!sessionPromise.current) {
      sessionPromise.current = startRecordingDraft(target, fingerprint).then((r) => {
        if ("error" in r) {
          sessionPromise.current = null;
          return r;
        }
        sessionRef.current = { contentItemId: r.contentItemId, recordingSessionId: r.recordingSessionId };
        // A brand-new video now exists: make a reload / "back" land on its draft.
        if (target.kind === "new") {
          try {
            window.history.replaceState(null, "", `/film/teleprompter?id=${r.contentItemId}`);
          } catch {
            // ignore
          }
        }
        return sessionRef.current;
      });
    }
    return sessionPromise.current;
  }, [target, fingerprint]);

  const patchSeg = useCallback(
    (key: string, patch: Partial<LocalSegment>) => setSegments((all) => all.map((s) => (s.key === key ? { ...s, ...patch } : s))),
    [setSegments],
  );

  /** After a part lands: take the server's view (real durations + playable URLs) and drop the
   * uploaded files from memory. */
  const syncFromServer = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    const server = await getRecordingDraft(s.contentItemId).catch(() => null);
    if (!server) return;
    onDraftChange(server);
    setSegments((all) =>
      all.map((seg) => {
        const remote = server.segments.find((r) => r.key === seg.key);
        if (!remote || seg.status !== "uploaded") return seg;
        if (seg.localUrl) URL.revokeObjectURL(seg.localUrl);
        return { ...seg, file: null, localUrl: null, remoteUrl: remote.url, seconds: remote.seconds || seg.seconds };
      }),
    );
  }, [onDraftChange, setSegments]);

  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      for (;;) {
        const seg = segsRef.current.find((s) => s.status === "queued" && s.file);
        if (!seg) break;
        const sess = await ensureSession();
        if ("error" in sess) {
          patchSeg(seg.key, { status: "failed", error: sess.error });
          break;
        }
        const result = await uploadSegmentWithRetry(
          {
            upload: (s, onProgress) =>
              uploadRawTake(sess.contentItemId, s.file!, mode, (p) => onProgress(p), {
                recordingSessionId: sess.recordingSessionId,
                segmentKey: s.key,
                segmentIndex: s.index,
                segmentSeconds: Math.round(s.seconds * 1000) / 1000,
                scriptStart: Math.round(s.scriptStart * 10000) / 10000,
                scriptEnd: Math.round(s.scriptEnd * 10000) / 10000,
              }).then(() => undefined),
          },
          seg,
          (patch) => patchSeg(seg.key, patch),
        );
        if (deleting.current.has(seg.key)) {
          // "Delete last part" while it was uploading: remove it now that it landed.
          deleting.current.delete(seg.key);
          await deleteDraftSegment(sess.contentItemId, sess.recordingSessionId, seg.key).catch(() => undefined);
        }
        if (result === "uploaded") await syncFromServer();
      }
    } finally {
      pumping.current = false;
    }
  }, [ensureSession, mode, patchSeg, syncFromServer]);

  const pending = segments.some((s) => s.status === "queued" || s.status === "uploading");

  // Leaving while a part is still uploading would lose it — ask first.
  useEffect(() => {
    if (!pending) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [pending]);

  // Revoke any remaining object URLs on unmount.
  useEffect(() => {
    return () => {
      for (const s of segsRef.current) if (s.localUrl) URL.revokeObjectURL(s.localUrl);
    };
  }, []);

  // ── Camera ────────────────────────────────────────────────────────────────────────────
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

  // Camera on mount; off on unmount.
  useEffect(() => {
    void startCamera();
    return () => {
      const rec = recRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [startCamera]);

  // A resumed draft: the script picks up where the last part stopped.
  useEffect(() => {
    const p = resumeProgress(draft, fingerprint);
    if (p > 0) {
      prompter.current?.setProgress(p);
      setCanRewind(true);
    }
    // Only on mount — later draft refreshes must not move the script under Chris.
  }, []);

  // Keep the screen awake while this screen is open (Wake Lock: iOS 16.4+); re-acquire after
  // returning to the app.
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
        // Leaving the app mid-part: finish the part cleanly (it's uploaded like any other).
        if (phaseRef.current === "recording") stopRecording();
        if (phaseRef.current === "countdown") setPhase("ready");
      } else {
        void acquire();
        const live = streamRef.current?.getVideoTracks().some((t) => t.readyState === "live");
        if (!live && (phaseRef.current === "ready" || phaseRef.current === "starting")) void startCamera();
        // Uploads interrupted in the background get another go.
        setSegments((all) => all.map((s) => (s.status === "failed" && s.file && !/refused|404|409/.test(s.error ?? "") ? { ...s, status: "queued" } : s)));
        void pump();
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release().catch(() => undefined);
    };
  }, [setPhase, startCamera, stopRecording, setSegments, pump]);

  // Full-screen: the page underneath must not scroll/bounce.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const check = () => setLandscape(window.innerWidth > window.innerHeight && window.matchMedia("(pointer: coarse)").matches);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Recording timer (this part).
  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => setElapsed((performance.now() - startedAtRef.current) / 1000), 200);
    return () => clearInterval(t);
  }, [phase]);

  const finalizePart = useCallback(
    (type: string) => {
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      recRef.current = null;
      const seconds = (performance.now() - startedAtRef.current) / 1000;
      const scriptEnd = prompter.current?.progress() ?? 0;
      setCanRewind(scriptEnd > 0);
      setPhase(streamRef.current ? "ready" : "starting");
      if (blob.size === 0 || seconds < 0.3) {
        setError(blob.size === 0 ? "That part came out empty. Try again." : null);
        return;
      }
      // Never reuse the index of a part deleted in this visit (the server also refuses reuse).
      const index = Math.max(nextSegmentIndex(segsRef.current), nextIndexRef.current);
      nextIndexRef.current = index + 1;
      const file = new File([blob], segmentFileName(index, type, new Date()), { type: baseMime(type) });
      partsThisVisit.current += 1;
      setVisitParts(partsThisVisit.current);
      setSegments((all) => [
        ...all,
        {
          key: newSegmentKey(),
          index,
          seconds,
          scriptStart: partStartRef.current,
          scriptEnd,
          file,
          localUrl: URL.createObjectURL(file),
          remoteUrl: null,
          status: "queued",
          percent: 0,
          attempt: 0,
          error: null,
        },
      ]);
      void pump();
    },
    [pump, setPhase, setSegments],
  );

  const beginRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    if (typeof MediaRecorder === "undefined") {
      setError("This browser can't record video. Use “iPhone Camera” instead.");
      setPhase("error");
      return;
    }
    const mime = pickRecorderMime((t) => MediaRecorder.isTypeSupported(t));
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
    rec.onstop = () => finalizePart(rec.mimeType || mime || "video/mp4");
    rec.onerror = () => {
      if (rec.state !== "inactive") rec.stop();
    };
    recRef.current = rec;
    // 1 s slices: if the phone interrupts the part, everything up to the last second is kept.
    rec.start(1000);
    startedAtRef.current = performance.now();
    partStartRef.current = prompter.current?.progress() ?? 0;
    setElapsed(0);
    setPaused(false);
    setPhase("recording");
  }, [finalizePart, setPhase]);

  // 3-2-1 countdown (first part of this visit only), then record. Tapping again cancels.
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
    if (wantsCountdown(settings.countdown, partsThisVisit.current)) {
      setCount(3);
      setPhase("countdown");
    } else beginRecording();
  }

  function patch(next: Partial<PrompterSettings>, restart = false) {
    setSettings({ ...settings, ...next });
    settingsRef.current = { ...settings, ...next };
    if (restart && phase !== "recording" && phase !== "countdown") void startCamera();
  }

  function backALine() {
    const h = prompter.current;
    if (!h) return;
    const { contentHeight, linePx } = h.metrics();
    const p = rewindProgress(h.progress(), 1, linePx, contentHeight);
    h.setProgress(p);
    setCanRewind(p > 0);
  }

  async function deleteLast() {
    const last = segments[segments.length - 1];
    if (!last) return;
    const n = segments.length;
    if (!window.confirm(`Delete part ${n} (${formatDuration(last.seconds)})? It can't be brought back.`)) return;
    setSegments((all) => all.filter((s) => s.key !== last.key));
    if (last.localUrl) URL.revokeObjectURL(last.localUrl);
    // The script goes back to where that part started.
    prompter.current?.setProgress(last.scriptStart);
    setCanRewind(last.scriptStart > 0);
    const sess = sessionRef.current;
    if (!sess) return;
    if (last.status === "uploading") {
      deleting.current.add(last.key); // removed as soon as its upload lands
      return;
    }
    const r = await deleteDraftSegment(sess.contentItemId, sess.recordingSessionId, last.key);
    if ("error" in r) setError(r.error);
    else void syncFromServer();
  }

  function retryFailed() {
    setSegments((all) => all.map((s) => (s.status === "failed" && s.file ? { ...s, status: "queued", error: null } : s)));
    void pump();
  }

  /** Waits until every part is uploaded; false when one failed. */
  async function waitForUploads(): Promise<boolean> {
    void pump();
    for (;;) {
      const segs = segsRef.current;
      if (segs.some((s) => s.status === "failed")) return false;
      if (!segs.some((s) => s.status === "queued" || s.status === "uploading") && !pumping.current) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async function saveDraftAndLeave() {
    setOverlay({ kind: "saving", error: null });
    if (!(await waitForUploads())) return setOverlay({ kind: "saving", error: "A part didn't upload. Check your connection and try again — it's still on this phone." });
    const sess = sessionRef.current;
    if (sess) {
      const r = await saveRecordingDraft(sess.contentItemId, sess.recordingSessionId, prompter.current?.progress() ?? 0, fingerprint);
      if ("error" in r) return setOverlay({ kind: "saving", error: r.error });
      stopTracks();
      router.push(`/content/${sess.contentItemId}?draftSaved=1`);
      return;
    }
    stopTracks();
    onExit();
  }

  async function finish() {
    setOverlay({ kind: "finishing", error: null });
    if (!(await waitForUploads())) return setOverlay({ kind: "finishing", error: "A part didn't upload. Check your connection and try again — it's still on this phone." });
    const sess = sessionRef.current;
    if (!sess) return setOverlay(null);
    const r = await finishRecordingDraft(sess.contentItemId, sess.recordingSessionId, prompter.current?.progress() ?? null);
    if ("error" in r) return setOverlay({ kind: "finishing", error: r.error });
    stopTracks(); // free the camera (and memory) while the editor gets ready
    onDraftChange(null);
    await openEditor(sess.contentItemId);
  }

  function exit() {
    const busy = segsRef.current.filter((s) => s.status !== "uploaded").length;
    if (busy > 0 && !window.confirm(`${busy === 1 ? "A part is" : `${busy} parts are`} still saving. Leave anyway? ${busy === 1 ? "It" : "They"} may be lost.`)) return;
    const sess = sessionRef.current;
    if (sess && segsRef.current.length > 0) void saveRecordingDraft(sess.contentItemId, sess.recordingSessionId, prompter.current?.progress() ?? 0, fingerprint);
    stopTracks();
    onExit();
  }

  const fontPx = FONT_SIZES[settings.fontIndex] ?? 36;
  const running = phase === "recording" ? !paused : !settings.scrollOnlyWhileRecording && !paused && phase === "ready";
  const mirrored = settings.facing === "user";
  const recording = phase === "recording";
  const bar = segmentBar(segments, recording ? elapsed : null);
  const total = totalSeconds(segments);
  const status = uploadSummary(segments);
  const hasParts = segments.length > 0;
  const resumed = hasParts && visitParts === 0;

  return (
    <div className="fixed inset-0 z-[100] overflow-hidden bg-black text-white" data-testid="record-mode">
      <video
        ref={(el) => {
          videoRef.current = el;
          if (el && streamRef.current && el.srcObject !== streamRef.current) {
            el.srcObject = streamRef.current;
            void el.play().catch(() => undefined);
          }
        }}
        muted
        playsInline
        autoPlay
        className="absolute inset-0 h-full w-full object-cover"
        style={{ transform: mirrored ? "scaleX(-1)" : undefined }}
      />

      {/* Script — top of the screen, right under the front camera; the parts bar above it. */}
      <div
        className="absolute inset-x-0 top-0 flex flex-col"
        style={{ height: "48%", paddingTop: "env(safe-area-inset-top)", background: "linear-gradient(to bottom, rgba(0,0,0,0.8), rgba(0,0,0,0.55) 75%, rgba(0,0,0,0))" }}
      >
        <SegmentBar bar={bar} recording={recording} total={total + (recording ? elapsed : 0)} parts={segments.length + (recording ? 1 : 0)} />
        <div className="relative min-h-0 flex-1">
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
          {!recording && phase !== "countdown" && canRewind && (
            <button
              type="button"
              onClick={backALine}
              className="absolute bottom-1 left-3 flex min-h-[44px] items-center gap-1.5 rounded-full bg-black/60 px-3.5 text-[13.5px] font-medium text-white/90 active:bg-white/15"
              data-testid="back-a-line"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v5h5" />
              </svg>
              Back a line
            </button>
          )}
        </div>
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
          {!hasParts && (
            <button type="button" className="btn btn-ghost w-full" onClick={() => { stopTracks(); onUseIphoneCamera(); }}>
              Use iPhone Camera instead
            </button>
          )}
          <button type="button" className="btn btn-ghost w-full" onClick={exit}>
            Close
          </button>
        </div>
      )}

      {/* Controls */}
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2.5 px-4 pt-10" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 14px)", background: "linear-gradient(to top, rgba(0,0,0,0.8), rgba(0,0,0,0))" }}>
        {error && phase !== "error" && <p className="text-center text-[13px] text-[var(--color-rose-400)]">{error}</p>}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
            {recording ? (
              <span className="flex items-center gap-1.5 rounded-full bg-[var(--color-rose-500)] px-2.5 py-1 font-semibold tabular-nums" data-testid="rec-timer">
                <span className="h-2 w-2 animate-pulse rounded-full bg-white" aria-hidden />
                Part {segments.length + 1} · {formatDuration(elapsed)}
              </span>
            ) : status.label ? (
              <UploadChip label={status.label} tone={status.tone} onRetry={status.tone === "bad" ? retryFailed : undefined} />
            ) : (
              label && <span className="rounded-full bg-black/50 px-2.5 py-1 text-white/80" data-testid="camera-label">{label}</span>
            )}
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

        {phase === "ready" && !hasParts && (
          <p className="text-center text-[12.5px] text-white/60">Tap record to film a part · tap again to pause · film the rest whenever you&apos;re ready</p>
        )}
        {phase === "ready" && resumed && (
          <p className="text-center text-[12.5px] text-white/70" data-testid="resume-hint">
            Continuing your draft — tap record to film part {segments.length + 1}.
          </p>
        )}

        {hasParts && !recording && phase !== "countdown" && (
          <div className="grid grid-cols-4 gap-2" data-testid="part-actions">
            <PillButton onClick={() => void deleteLast()} testId="delete-last" label="Delete last part">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 5H9l-6 7 6 7h12z" />
                <path d="m13 9.5 5 5M18 9.5l-5 5" />
              </svg>
              Delete
            </PillButton>
            <PillButton onClick={() => setOverlay({ kind: "preview" })} testId="preview-parts" label="Preview all parts">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M7 5v14l12-7z" />
              </svg>
              Preview
            </PillButton>
            <PillButton onClick={() => void saveDraftAndLeave()} testId="save-draft" label="Save as draft and finish later">
              Save draft
            </PillButton>
            <PillButton onClick={() => void finish()} testId="finish" label="Finish — make the video" primary>
              Finish
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m5 12 5 5L20 7" />
              </svg>
            </PillButton>
          </div>
        )}

        <div className="grid grid-cols-5 items-center">
          <IconButton label="Close" onClick={exit} disabled={recording}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
          </IconButton>
          <IconButton label="Switch camera" onClick={() => patch({ facing: settings.facing === "user" ? "environment" : "user" }, true)} disabled={recording || phase === "countdown"}>
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
              aria-label={recording ? "Pause — end this part" : phase === "countdown" ? "Cancel countdown" : hasParts ? `Record part ${segments.length + 1}` : "Start recording"}
              className="flex h-[76px] w-[76px] items-center justify-center rounded-full border-4 border-white/90 disabled:opacity-40"
              data-testid="record-button"
            >
              {recording ? (
                <span className="flex h-[58px] w-[58px] items-center justify-center gap-[7px] rounded-full bg-[var(--color-rose-500)]">
                  <span className="h-6 w-[7px] rounded-sm bg-white" />
                  <span className="h-6 w-[7px] rounded-sm bg-white" />
                </span>
              ) : (
                <span className="block h-[58px] w-[58px] rounded-full bg-[var(--color-rose-500)]" />
              )}
            </button>
          </div>
          <IconButton label="Script settings" onClick={() => setSheet(true)} disabled={recording}>
            <span className="text-[19px] font-semibold leading-none">Aa</span>
          </IconButton>
          <IconButton label={running ? "Pause script" : "Play script"} onClick={() => setPaused((p) => !p)} disabled={!recording && settings.scrollOnlyWhileRecording}>
            {running ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M7 5v14l12-7z" /></svg>
            )}
          </IconButton>
        </div>
      </div>

      {sheet && <SettingsSheet settings={settings} caps={caps} onClose={() => setSheet(false)} patch={patch} />}

      {overlay?.kind === "preview" && <SequencePreview segments={segments} onClose={() => setOverlay(null)} />}

      {(overlay?.kind === "finishing" || overlay?.kind === "saving") && (
        <div className="absolute inset-0 z-20 flex flex-col justify-end bg-black/70 p-4" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)" }} data-testid="finish-overlay">
          <div className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-[#121216] p-5">
            {finishing ? (
              <FinishingCard finishing={finishing} onSkip={skip} />
            ) : overlay.error ? (
              <>
                <p className="text-[16px] font-semibold">Not yet</p>
                <p className="text-[14px] text-white/75">{overlay.error}</p>
                <button type="button" className="btn btn-primary w-full" onClick={() => { retryFailed(); void (overlay.kind === "finishing" ? finish() : saveDraftAndLeave()); }}>
                  Try again
                </button>
                <button type="button" className="btn btn-ghost w-full" onClick={() => setOverlay(null)}>
                  Back to the camera
                </button>
              </>
            ) : (
              <div className="flex items-center gap-3" aria-live="polite">
                <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-[var(--color-gold-400)] border-t-transparent" aria-hidden />
                <div className="min-w-0">
                  <p className="text-[16px] font-semibold">{overlay.kind === "saving" ? "Saving your draft…" : `Putting your ${segments.length === 1 ? "part" : `${segments.length} parts`} together…`}</p>
                  <p className="text-[13px] text-white/60">{status.tone === "busy" && status.label ? status.label : "Keep this screen open for a moment."}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** TikTok-style parts bar: one block per part (saved = white, saving = pulsing, failed = red),
 * the part being recorded in red, the total on the right. */
function SegmentBar({ bar, recording, total, parts }: { bar: ReturnType<typeof segmentBar>; recording: boolean; total: number; parts: number }) {
  return (
    <div className="px-3 pt-2" data-testid="segment-bar">
      <div className="flex h-[6px] w-full gap-[3px] overflow-hidden rounded-full bg-white/20" role="progressbar" aria-label={`${parts} ${parts === 1 ? "part" : "parts"}, ${formatDuration(total)} recorded`}>
        {bar.parts.map((p) => (
          <span
            key={p.key}
            className={`h-full shrink-0 rounded-[2px] ${p.status === "failed" ? "bg-[var(--color-rose-400)]" : p.status === "uploaded" ? "bg-white" : "animate-pulse bg-white/70"}`}
            style={{ width: `${(p.frac * 100).toFixed(2)}%`, minWidth: 4 }}
            data-testid="segment"
          />
        ))}
        {recording && <span className="h-full shrink-0 rounded-[2px] bg-[var(--color-rose-500)]" style={{ width: `${(bar.currentFrac * 100).toFixed(2)}%`, minWidth: 4 }} />}
      </div>
      <div className="mt-1 flex h-4 items-center justify-between text-[11.5px] tabular-nums text-white/70">
        <span>{parts > 0 ? `${parts} ${parts === 1 ? "part" : "parts"}` : ""}</span>
        <span>{parts > 0 ? formatDuration(total) : ""}</span>
      </div>
    </div>
  );
}

function UploadChip({ label, tone, onRetry }: { label: string; tone: "ok" | "busy" | "bad"; onRetry?: () => void }) {
  const cls = `flex min-h-[28px] items-center gap-1.5 rounded-full px-2.5 py-1 ${tone === "bad" ? "bg-[var(--color-rose-500)]/90" : "bg-black/55 text-white/85"}`;
  const icon =
    tone === "ok" ? (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--color-emerald-400)]" aria-hidden>
        <path d="m5 12 5 5L20 7" />
      </svg>
    ) : tone === "busy" ? (
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/80 border-t-transparent" aria-hidden />
    ) : null;
  if (onRetry) {
    return (
      <button type="button" onClick={onRetry} className={`${cls} min-h-[44px]`} data-testid="upload-status">
        {label}
      </button>
    );
  }
  return (
    <span className={cls} aria-live="polite" data-testid="upload-status">
      {icon}
      {label}
    </span>
  );
}

/** "Preview": every part back-to-back, as it will be joined. */
function SequencePreview({ segments, onClose }: { segments: LocalSegment[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  const ref = useRef<HTMLVideoElement>(null);
  const src = segments[i]?.localUrl ?? segments[i]?.remoteUrl ?? null;
  useEffect(() => {
    const v = ref.current;
    if (v && src) void v.play().catch(() => undefined);
  }, [src]);
  const done = i >= segments.length;
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-black" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }} data-testid="sequence-preview">
      <div className="flex min-h-[52px] items-center justify-between px-3">
        <p className="pl-1 text-[15px] font-semibold">{done ? "That's everything so far" : `Part ${i + 1} of ${segments.length}`}</p>
        <button type="button" onClick={onClose} className="btn btn-ghost !min-h-[44px] !px-4">
          Done
        </button>
      </div>
      <div className="flex gap-1 px-4 pb-2">
        {segments.map((s, k) => (
          <span key={s.key} className={`h-1 flex-1 rounded-full ${k < i ? "bg-white" : k === i ? "bg-[var(--color-gold-400)]" : "bg-white/25"}`} />
        ))}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center px-3">
        {done ? (
          <button type="button" className="btn btn-primary !min-h-[52px] !px-6" onClick={() => setI(0)}>
            Play again
          </button>
        ) : src ? (
          <video key={src} ref={ref} src={src} playsInline controls autoPlay onEnded={() => setI((n) => n + 1)} className="max-h-full w-full rounded-2xl bg-black object-contain" data-testid="preview-video" />
        ) : (
          <p className="text-[14px] text-white/70">This part is still saving…</p>
        )}
      </div>
    </div>
  );
}

function PillButton({ onClick, children, testId, label, primary }: { onClick: () => void; children: React.ReactNode; testId: string; label: string; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      data-testid={testId}
      className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-full px-2 text-[13.5px] font-semibold ${
        primary ? "bg-[var(--color-gold-400)] text-black active:opacity-80" : "bg-black/55 text-white active:bg-white/15"
      }`}
    >
      {children}
    </button>
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
        <Toggle label="3-2-1 countdown" hint="Before your first part each time you open the camera." on={settings.countdown} set={(v) => patch({ countdown: v })} />
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
