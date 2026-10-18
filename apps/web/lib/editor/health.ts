/**
 * Editor health recorder (docs/decisions-pending/editor-rebuild.md) — runs inside the editor on
 * Chris's phone and measures what the preview actually does there: open → first frame →
 * interactive, frames presented vs expected while playing (dropped frames), main-thread stalls
 * (rAF gaps — works in Safari, which has no Long Tasks API), long tasks where supported, video
 * element events, decoder events, scrub latency, JS errors, memory where available, the device
 * and the size of the edit. Compact reports go to /api/editor-health (signed-in only).
 *
 * Privacy: timings, counters, short event names and device facts only — never media, titles,
 * captions or transcript text. Error messages are truncated and stripped of URLs.
 *
 * The class is pure (clock injected) so the aggregation is unit-tested; `installHealth` wires
 * it to the browser.
 */

export type HealthValue = string | number | boolean | null;
export interface HealthEvent {
  /** ms since the editor opened */
  t: number;
  type: string;
  data?: Record<string, HealthValue>;
}

export interface HealthReport {
  v: 1;
  kind: "session" | "glitch";
  sessionId: string;
  contentItemId: string | null;
  engine: string | null;
  engineInfo: Record<string, HealthValue>;
  device: Record<string, HealthValue>;
  edit: Record<string, HealthValue>;
  marks: Record<string, number>;
  totals: {
    openS: number;
    playS: number;
    presented: number;
    expected: number;
    dropped: number;
    droppedPct: number;
    stalls100: number;
    stalls250: number;
    stalls1000: number;
    maxStallMs: number;
    longTasks: number;
    longTaskMs: number;
    errors: number;
    videoWaiting: number;
    videoErrors: number;
    lateFrames: number;
    scrubN: number;
    scrubP50: number | null;
    scrubP95: number | null;
  };
  fps: number[];
  memMB: number | null;
  errors: string[];
  events: HealthEvent[];
  note?: string;
}

export const HEALTH_EVENT_CAP = 600;
export const HEALTH_GLITCH_WINDOW_MS = 20_000;
/** Proxy frame rate — what "expected frames" counts against. */
export const HEALTH_TARGET_FPS = 30;

export function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * q))]!);
}

/** Error text without URLs/paths (they could carry storage keys) and capped. */
export function scrubErrorText(msg: string): string {
  return msg.replace(/https?:\/\/\S+/g, "<url>").replace(/\/api\/media\/\S+/g, "<media>").slice(0, 200);
}

export class EditorHealth {
  readonly sessionId: string;
  readonly contentItemId: string | null;
  engine: string | null = null;
  engineInfo: Record<string, HealthValue> = {};
  device: Record<string, HealthValue> = {};
  edit: Record<string, HealthValue> = {};
  marks: Record<string, number> = {};
  private events: HealthEvent[] = [];
  private errorsList: string[] = [];
  private now: () => number;
  private t0: number;
  private playingSince: number | null = null;
  private playMs = 0;
  private presented = 0;
  private presentedThisSecond = 0;
  private secondStart = 0;
  private fpsSamples: number[] = [];
  private stalls = { s100: 0, s250: 0, s1000: 0, max: 0 };
  private long = { n: 0, ms: 0 };
  private video = { waiting: 0, errors: 0 };
  private late = 0;
  private scrub: number[] = [];
  memMB: number | null = null;

  constructor(opts: { sessionId: string; contentItemId: string | null; now?: () => number }) {
    this.sessionId = opts.sessionId;
    this.contentItemId = opts.contentItemId;
    this.now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    // Real clock: performance.now() already counts from the page's navigation start, so marks are
    // "since Chris opened the editor" (incl. server time + hydration). Injected clocks: from now.
    this.t0 = opts.now ? this.now() : typeof performance !== "undefined" ? 0 : this.now();
  }

  /** ms since open */
  elapsed(): number {
    return Math.round(this.now() - this.t0);
  }

  /** First occurrence wins (open → first frame etc.). `at` = absolute clock value. */
  mark(name: string, at?: number) {
    if (this.marks[name] !== undefined) return;
    this.marks[name] = Math.round((at ?? this.now()) - this.t0);
    this.event("mark", { name });
  }

  event(type: string, data?: Record<string, HealthValue>) {
    this.events.push({ t: this.elapsed(), type, ...(data ? { data } : {}) });
    if (this.events.length > HEALTH_EVENT_CAP) this.events.splice(0, this.events.length - HEALTH_EVENT_CAP);
    if (type === "video" && data?.ev === "waiting") this.video.waiting++;
    if (type === "video" && data?.ev === "error") this.video.errors++;
  }

  setPlaying(on: boolean) {
    const t = this.now();
    if (on && this.playingSince === null) {
      this.playingSince = t;
      this.secondStart = t;
      this.presentedThisSecond = 0;
      this.mark("firstPlay");
      this.event("play");
    } else if (!on && this.playingSince !== null) {
      this.playMs += t - this.playingSince;
      this.playingSince = null;
      this.event("pause");
    }
  }

  /** A new picture reached the screen while playing. */
  framePresented() {
    if (this.playingSince === null) return;
    this.presented++;
    this.presentedThisSecond++;
    const t = this.now();
    if (t - this.secondStart >= 1000) {
      this.fpsSamples.push(Math.round((this.presentedThisSecond * 1000) / (t - this.secondStart)));
      if (this.fpsSamples.length > 180) this.fpsSamples.shift();
      this.secondStart = t;
      this.presentedThisSecond = 0;
    }
  }

  /** The frame the clock wanted wasn't decoded in time (compositor). */
  lateFrame() {
    this.late++;
  }

  /** A gap between animation frames (main thread blocked or tab hidden). */
  rafGap(ms: number) {
    if (ms < 100) return;
    this.stalls.s100++;
    if (ms >= 250) this.stalls.s250++;
    if (ms >= 1000) this.stalls.s1000++;
    this.stalls.max = Math.max(this.stalls.max, Math.round(ms));
    this.event("stall", { ms: Math.round(ms) });
  }

  longTask(ms: number) {
    this.long.n++;
    this.long.ms += ms;
  }

  error(msg: string) {
    const m = scrubErrorText(msg);
    this.errorsList.push(m);
    if (this.errorsList.length > 20) this.errorsList.shift();
    this.event("error", { msg: m.slice(0, 80) });
  }

  scrubLatency(ms: number) {
    this.scrub.push(ms);
    if (this.scrub.length > 400) this.scrub.shift();
  }

  report(kind: "session" | "glitch", note?: string): HealthReport {
    const nowT = this.now();
    const playMs = this.playMs + (this.playingSince !== null ? nowT - this.playingSince : 0);
    const expected = Math.round((playMs / 1000) * HEALTH_TARGET_FPS);
    const dropped = Math.max(0, expected - this.presented);
    const since = kind === "glitch" ? this.elapsed() - HEALTH_GLITCH_WINDOW_MS : -Infinity;
    const events = this.events.filter((e) => e.t >= since).slice(kind === "glitch" ? -300 : -120);
    return {
      v: 1,
      kind,
      sessionId: this.sessionId,
      contentItemId: this.contentItemId,
      engine: this.engine,
      engineInfo: this.engineInfo,
      device: this.device,
      edit: this.edit,
      marks: { ...this.marks },
      totals: {
        openS: Math.round(this.elapsed() / 1000),
        playS: Math.round(playMs / 100) / 10,
        presented: this.presented,
        expected,
        dropped,
        droppedPct: expected ? Math.round((dropped / expected) * 1000) / 10 : 0,
        stalls100: this.stalls.s100,
        stalls250: this.stalls.s250,
        stalls1000: this.stalls.s1000,
        maxStallMs: this.stalls.max,
        longTasks: this.long.n,
        longTaskMs: Math.round(this.long.ms),
        errors: this.errorsList.length,
        videoWaiting: this.video.waiting,
        videoErrors: this.video.errors,
        lateFrames: this.late,
        scrubN: this.scrub.length,
        scrubP50: percentile(this.scrub, 0.5),
        scrubP95: percentile(this.scrub, 0.95),
      },
      fps: [...this.fpsSamples].slice(-120),
      memMB: this.memMB,
      errors: [...this.errorsList].slice(-10),
      events,
      ...(note ? { note: note.slice(0, 300) } : {}),
    };
  }
}

// ---------------------------------------------------------------------------------------
// Browser wiring
// ---------------------------------------------------------------------------------------

export function newSessionId(): string {
  const r = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return r.slice(0, 36);
}

export function deviceFacts(): Record<string, HealthValue> {
  if (typeof window === "undefined") return {};
  const nav = navigator as Navigator & { deviceMemory?: number; standalone?: boolean };
  const webgl2 = typeof (window as unknown as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext === "function";
  return {
    ua: nav.userAgent.slice(0, 200),
    dpr: window.devicePixelRatio || 1,
    screen: `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    cores: nav.hardwareConcurrency ?? null,
    memGB: nav.deviceMemory ?? null,
    standalone: !!nav.standalone || window.matchMedia?.("(display-mode: standalone)").matches || false,
    webcodecs: typeof (window as unknown as { VideoDecoder?: unknown }).VideoDecoder === "function",
    audioDecoder: typeof (window as unknown as { AudioDecoder?: unknown }).AudioDecoder === "function",
    webgl2,
  };
}

/** POSTs a report; `beacon` for page-hide (survives the tab closing). Never throws. */
export function sendHealthReport(r: HealthReport, beacon = false) {
  try {
    const body = JSON.stringify(r);
    if (body.length > 46_000) return;
    if (beacon && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon("/api/editor-health", new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch("/api/editor-health", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => undefined);
  } catch {
    /* telemetry must never break the editor */
  }
}

/**
 * Wires the recorder to the page: rAF-gap monitor, long tasks, JS errors, memory, and
 * checkpoints (30 s after the first play, every 2 min while open, and when the page hides).
 * Returns the detach.
 */
export function installHealth(h: EditorHealth): () => void {
  if (typeof window === "undefined") return () => undefined;
  h.device = deviceFacts();
  (window as unknown as { __edHealth?: unknown }).__edHealth = { marks: h.marks, snapshot: () => h.report("session"), health: h };
  let raf = 0;
  let last = 0;
  let hidden = document.visibilityState === "hidden";
  const loop = (ts: number) => {
    if (last && !hidden) h.rafGap(ts - last);
    last = ts;
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  const onErr = (e: ErrorEvent) => h.error(e.message || "error");
  const onRej = (e: PromiseRejectionEvent) => h.error(`unhandled: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`);
  window.addEventListener("error", onErr);
  window.addEventListener("unhandledrejection", onRej);
  let po: PerformanceObserver | null = null;
  try {
    po = new PerformanceObserver((l) => l.getEntries().forEach((e) => h.longTask(e.duration)));
    po.observe({ type: "longtask", buffered: true });
  } catch {
    po = null; // Safari: no Long Tasks API — the rAF gaps cover it
  }
  const mem = () => {
    const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    if (m) h.memMB = Math.round(m.usedJSHeapSize / 1048576);
  };
  let firstPlaySent = false;
  const tick = window.setInterval(() => {
    mem();
    if (!firstPlaySent && h.marks.firstPlay !== undefined && h.elapsed() - h.marks.firstPlay > 30_000) {
      firstPlaySent = true;
      sendHealthReport(h.report("session"));
    }
  }, 5_000);
  const periodic = window.setInterval(() => sendHealthReport(h.report("session")), 120_000);
  const onVis = () => {
    hidden = document.visibilityState === "hidden";
    last = 0;
    if (hidden) sendHealthReport(h.report("session"), true);
  };
  const onHide = () => sendHealthReport(h.report("session"), true);
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("pagehide", onHide);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("error", onErr);
    window.removeEventListener("unhandledrejection", onRej);
    po?.disconnect();
    window.clearInterval(tick);
    window.clearInterval(periodic);
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("pagehide", onHide);
    sendHealthReport(h.report("session"), true);
  };
}
