"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { snapMinutes } from "../../lib/calendar-views";

/**
 * Pointer-based drag-to-reschedule shared by the Week/Day time grid and the Month grid.
 *
 * - Mouse/pen: the drag starts after a 4px move (a plain click still opens the sheet).
 * - Touch: long-press (350ms, finger still) picks the event up — so a normal swipe still
 *   scrolls the calendar — then a non-passive touchmove listener (registered at touchstart,
 *   before iOS decides to scroll) keeps the page from scrolling while you move it.
 *
 * Drop targets are any element with `data-drop-ymd`; a time-grid column also carries
 * `data-drop-grid` + `data-hour-px` so the pointer's Y becomes a time (snapped to 15 min).
 * A month cell keeps the event's original time.
 */

export interface DragPayload {
  id: string;
  contentItemId: string;
  platforms: string[];
  ymd: string;
  startMin: number;
  title: string;
  /** Minutes between the event's start and where it was grabbed (time grid only). */
  grabOffsetMin: number;
}

export interface DragState {
  payload: DragPayload;
  x: number;
  y: number;
  target: { ymd: string; minutes: number; grid: boolean } | null;
}

export function useEventDrag(onDrop: (p: DragPayload, ymd: string, minutes: number) => void) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const suppressClick = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);
  useEffect(() => () => cleanup.current?.(), []);

  const start = useCallback((e: React.PointerEvent, payload: DragPayload) => {
    if (e.button !== 0) return;
    cleanup.current?.();
    const touch = e.pointerType === "touch";
    const sx = e.clientX;
    const sy = e.clientY;
    let active = false;
    let current: DragState | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const targetAt = (x: number, y: number): DragState["target"] => {
      const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-drop-ymd]");
      if (!el) return null;
      const ymd = el.dataset.dropYmd!;
      if (el.dataset.dropGrid !== undefined) {
        const hourPx = Number(el.dataset.hourPx) || 48;
        const rect = el.getBoundingClientRect();
        const minutes = snapMinutes(((y - rect.top) / hourPx) * 60 - payload.grabOffsetMin);
        return { ymd, minutes, grid: true };
      }
      return { ymd, minutes: payload.startMin, grid: false };
    };

    const activate = (x: number, y: number) => {
      active = true;
      suppressClick.current = true;
      if (touch && "vibrate" in navigator) navigator.vibrate?.(8);
      current = { payload, x, y, target: targetAt(x, y) };
      setDrag(current);
    };

    const move = (ev: PointerEvent) => {
      if (!active) {
        const dist = Math.hypot(ev.clientX - sx, ev.clientY - sy);
        if (touch) {
          if (dist > 8 && timer) {
            clearTimeout(timer);
            timer = null;
            finish();
          }
          return;
        }
        if (dist < 4) return;
        activate(ev.clientX, ev.clientY);
        return;
      }
      current = { payload, x: ev.clientX, y: ev.clientY, target: targetAt(ev.clientX, ev.clientY) };
      setDrag(current);
    };

    const touchMove = (ev: TouchEvent) => {
      if (active) ev.preventDefault();
    };

    const up = () => {
      const result = active ? current : null;
      finish();
      if (result?.target) {
        const t = result.target;
        if (t.ymd !== payload.ymd || t.minutes !== payload.startMin) onDropRef.current(payload, t.ymd, t.minutes);
      }
      // Swallow the click that follows a drag so it doesn't also open the sheet.
      setTimeout(() => (suppressClick.current = false), 80);
    };

    const finish = () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("touchmove", touchMove);
      cleanup.current = null;
      setDrag(null);
    };
    const cancel = () => {
      finish();
      setTimeout(() => (suppressClick.current = false), 80);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("touchmove", touchMove, { passive: false });
    cleanup.current = finish;
    if (touch) timer = setTimeout(() => activate(sx, sy), 350);
  }, []);

  /** Wrap an onClick so it's ignored right after a drag. */
  const guardClick = useCallback((fn: () => void) => () => {
    if (suppressClick.current) return;
    fn();
  }, []);

  return { drag, start, guardClick };
}
