"use client";

import { useEffect, useRef, type Ref } from "react";
import { advanceProgress, progressAfterDrag, progressPerSecond, scrollOffset, wordCount } from "../../../lib/teleprompter/scroll";

export interface PrompterHandle {
  reset: () => void;
  progress: () => number;
  /** Jump to a position (0..1) — resuming a recording draft, or "back a line". */
  setProgress: (p: number) => void;
  /** Rendered text height and one line's height (px), for line-based rewinds. */
  metrics: () => { contentHeight: number; linePx: number };
}

/**
 * The scrolling text (in-app prompter). Progress-based (see lib/teleprompter/scroll.ts) and
 * animated outside React (rAF → a transform on the text) so a 60 fps scroll never re-renders
 * the camera screen. Tap toggles scrolling; a vertical drag scrubs back/forward.
 */
export function PrompterScroller({
  text,
  fontPx,
  wpm,
  running,
  mirror,
  onTap,
  onEnd,
  readingLine = 0.24,
  handleRef,
}: {
  text: string;
  fontPx: number;
  wpm: number;
  running: boolean;
  mirror: boolean;
  onTap: () => void;
  onEnd?: () => void;
  /** Reading line as a fraction of the box height (near the top = near the front lens). */
  readingLine?: number;
  handleRef?: Ref<PrompterHandle>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const progress = useRef(0);
  // Latest props for the rAF loop (which is set up once).
  const live = useRef({ running, perSecond: progressPerSecond(wordCount(text), wpm), onEnd, onTap, readingLine, fontPx });
  useEffect(() => {
    live.current = { running, perSecond: progressPerSecond(wordCount(text), wpm), onEnd, onTap, readingLine, fontPx };
  });
  const drag = useRef<{ y: number; startY: number; moved: boolean } | null>(null);
  const ended = useRef(false);

  useEffect(() => {
    const h: PrompterHandle = {
      reset: () => {
        progress.current = 0;
        ended.current = false;
      },
      progress: () => progress.current,
      setProgress: (p: number) => {
        progress.current = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
        ended.current = progress.current >= 1;
      },
      metrics: () => {
        const fp = live.current.fontPx;
        return { contentHeight: Math.max(0, (textRef.current?.offsetHeight ?? 0) - fp * 1.3), linePx: fp * 1.3 };
      },
    };
    if (typeof handleRef === "function") handleRef(h);
    else if (handleRef) (handleRef as { current: PrompterHandle | null }).current = h;
  }, [handleRef]);

  useEffect(() => {
    let raf = 0;
    let last: number | null = null;
    const tick = (t: number) => {
      const dt = last == null ? 0 : t - last;
      last = t;
      const l = live.current;
      if (l.running && !drag.current) progress.current = advanceProgress(progress.current, dt, l.perSecond);
      const box = boxRef.current;
      const el = textRef.current;
      if (box && el) {
        const contentHeight = Math.max(0, el.offsetHeight - l.fontPx * 1.3);
        const y = scrollOffset(progress.current, contentHeight, box.clientHeight * l.readingLine);
        el.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0)`;
      }
      if (progress.current >= 1 && l.running && !ended.current) {
        ended.current = true;
        l.onEnd?.();
      }
      if (progress.current < 1) ended.current = false;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={boxRef}
      className="relative h-full w-full touch-none select-none overflow-hidden"
      style={{ maskImage: "linear-gradient(to bottom, transparent 0, #000 12%, #000 78%, transparent 100%)", WebkitMaskImage: "linear-gradient(to bottom, transparent 0, #000 12%, #000 78%, transparent 100%)" }}
      onPointerDown={(e) => {
        drag.current = { y: e.clientY, startY: e.clientY, moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (Math.abs(e.clientY - d.startY) > 8) d.moved = true;
        if (d.moved && textRef.current) {
          const contentHeight = Math.max(1, textRef.current.offsetHeight - fontPx * 1.3);
          progress.current = progressAfterDrag(progress.current, e.clientY - d.y, contentHeight);
        }
        d.y = e.clientY;
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) live.current.onTap();
      }}
      onPointerCancel={() => (drag.current = null)}
      role="button"
      aria-label={running ? "Pause the script" : "Scroll the script"}
      data-testid="prompter"
    >
      {/* Reading line marker */}
      <div className="pointer-events-none absolute left-1.5 z-10 h-0 w-0 border-y-[7px] border-l-[10px] border-y-transparent border-l-[var(--color-gold-400)]" style={{ top: `calc(${readingLine * 100}% + ${fontPx * 0.65 - 7}px)` }} aria-hidden />
      <div
        ref={textRef}
        className="whitespace-pre-wrap px-6 font-semibold text-white will-change-transform"
        style={{ fontSize: fontPx, lineHeight: 1.3, textShadow: "0 1px 3px rgba(0,0,0,0.6)", scale: mirror ? "-1 1" : undefined }}
      >
        {text}
      </div>
    </div>
  );
}
