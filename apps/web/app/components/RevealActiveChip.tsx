"use client";

import { useEffect } from "react";

/** In a horizontally scrolling chip row (e.g. Content's stage tabs), make sure the current
 * chip is on screen on phones — "Done" sits off the right edge of a 375px screen otherwise.
 * Scrolls only the row itself, never the page. */
export function RevealActiveChip({ containerId }: { containerId: string }) {
  useEffect(() => {
    const row = document.getElementById(containerId);
    const chip = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !chip) return;
    const overflowRight = chip.offsetLeft + chip.offsetWidth - (row.scrollLeft + row.clientWidth);
    const overflowLeft = row.scrollLeft - chip.offsetLeft;
    if (overflowRight > 0 || overflowLeft > 0) {
      row.scrollLeft = Math.max(0, chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2);
    }
  }, [containerId]);
  return null;
}
