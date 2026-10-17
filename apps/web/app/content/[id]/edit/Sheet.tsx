"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { resolveSheetSnap, rubberBand, type SheetSnap } from "../../../../lib/editor/touch-math";
import { Icon } from "./icons";

/**
 * iOS-style bottom sheet for the touch shell: drag handle, two snap points (half / full),
 * swipe down (or flick) to dismiss. The sheet is always full height and only TRANSLATED —
 * dragging and snapping animate `transform` only. At "half" the body gets bottom padding equal
 * to the hidden part so every control can still be scrolled into view.
 *
 * In landscape on a phone it becomes a right-hand side panel (no drag; close button).
 */
export function Sheet({
  title,
  onClose,
  children,
  initial = "half",
  side = false,
  onSnapChange,
  headerRight,
  label,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  initial?: Exclude<SheetSnap, "closed">;
  side?: boolean;
  /** Height (px) the sheet covers once settled — the shell keeps the preview above it. */
  onSnapChange?: (visibleHeight: number) => void;
  headerRight?: ReactNode;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [snap, setSnap] = useState<Exclude<SheetSnap, "closed">>(initial);
  const [metrics, setMetrics] = useState({ full: 0, half: 0 });
  const [closing, setClosing] = useState(false);
  const drag = useRef<{ y0: number; base: number; lastY: number; lastT: number; v: number; id: number } | null>(null);

  // Snap heights from the sheet's own (full) height.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const full = el.offsetHeight;
      const vh = window.innerHeight;
      const half = Math.round(Math.min(full, Math.max(260, Math.min(440, vh * 0.44))));
      setMetrics((m) => (m.full === full && m.half === half ? m : { full, half }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = side ? metrics.full : snap === "full" ? metrics.full : metrics.half;
  const offset = metrics.full - visible;

  useEffect(() => {
    if (!metrics.full) return;
    onSnapChange?.(closing ? 0 : visible);
  }, [visible, closing, metrics.full, onSnapChange]);

  const setTransform = (y: number, animate: boolean) => {
    const el = ref.current;
    if (!el) return;
    el.classList.toggle("ed-sheet-anim", animate);
    el.style.transform = `translate3d(0, ${y}px, 0)`;
  };

  // Settle position whenever the snap or size changes.
  useLayoutEffect(() => {
    if (!metrics.full || side || drag.current || closing) return;
    setTransform(offset, true);
  }, [offset, metrics.full, side, closing]);

  const close = useCallback(() => {
    if (closing) return;
    setClosing(true);
    if (side || !ref.current) {
      onClose();
      return;
    }
    setTransform(metrics.full + 24, true);
    const done = () => onClose();
    const el = ref.current;
    let fired = false;
    const once = () => {
      if (fired) return;
      fired = true;
      done();
    };
    el.addEventListener("transitionend", once, { once: true });
    setTimeout(once, 320);
  }, [closing, side, metrics.full, onClose]);

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (side || (e.pointerType === "mouse" && e.button !== 0)) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y0: e.clientY, base: offset, lastY: e.clientY, lastT: performance.now(), v: 0, id: e.pointerId };
    setTransform(offset, false);
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    d.v = 0.8 * ((e.clientY - d.lastY) / dt) + 0.2 * d.v;
    d.lastY = e.clientY;
    d.lastT = now;
    let y = d.base + (e.clientY - d.y0);
    if (y < 0) y = -rubberBand(-y);
    setTransform(y, false);
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const y = d.base + (e.clientY - d.y0);
    if (Math.abs(e.clientY - d.y0) < 4) {
      // a tap on the handle toggles half/full
      setSnap((s) => (s === "half" ? "full" : "half"));
      setTransform(snap === "half" ? 0 : metrics.full - metrics.half, true);
      return;
    }
    const next = resolveSheetSnap({ height: metrics.full - y, velocity: d.v, half: metrics.half, full: metrics.full });
    if (next === "closed") return close();
    setSnap(next);
    setTransform(next === "full" ? 0 : metrics.full - metrics.half, true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div
      ref={ref}
      className={`ed-sheet ${side ? "ed-sheet-side" : ""} ${metrics.full ? "" : "ed-sheet-measuring"}`}
      role="dialog"
      aria-label={label}
      style={side ? undefined : { transform: `translate3d(0, ${metrics.full ? offset : 2000}px, 0)` }}
    >
      <div className="ed-sheet-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {!side && <div className="ed-sheet-grabber" aria-hidden />}
        <div className="ed-sheet-titlebar">
          <h2 className="ed-sheet-title">{title}</h2>
          <div className="flex items-center gap-1">
            {headerRight}
            <button type="button" className="ed-sheet-done" onClick={close} aria-label="Close">
              {side ? <Icon name="close" size={18} /> : "Done"}
            </button>
          </div>
        </div>
      </div>
      <div className="ed-sheet-body" style={{ paddingBottom: side ? undefined : `calc(${offset}px + 24px + env(safe-area-inset-bottom))` }}>
        {children}
      </div>
    </div>
  );
}
