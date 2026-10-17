import { createContext, useContext, type ReactNode } from "react";
import type { MotionTemplate, MotionTheme, TimelineVisual } from "@chris/media/timeline";
import { resolveMotionStyle, resolveThemedTransition, type MotionStyle } from "../style";
import type { ConcreteTransition } from "../timing";

/**
 * Motion-theme plumbing for the composition, kept OUT of VisualsLayer.tsx on purpose (that
 * file's structure belongs to the interaction work): VisualsLayer only wraps its tree in
 * <MotionThemeProvider theme={motionTheme}> and asks `useVisualMotionStyle(visual)` for the
 * palette / feel / icon style / themed AUTO transitions. Everything else is in src/style.ts.
 */
const MotionThemeContext = createContext<MotionTheme | null>(null);

export function MotionThemeProvider({ theme, children }: { theme: MotionTheme | null | undefined; children: ReactNode }) {
  return <MotionThemeContext.Provider value={theme ?? null}>{children}</MotionThemeContext.Provider>;
}

export function useMotionTheme(): MotionTheme | null {
  return useContext(MotionThemeContext);
}

export interface VisualMotionStyle extends MotionStyle {
  enter: ConcreteTransition;
  exit: ConcreteTransition;
}

/** The resolved style of one visual under the current theme (pure underneath). */
export function useVisualMotionStyle(template: MotionTemplate, visual: Pick<TimelineVisual, "palette" | "enter" | "exit">): VisualMotionStyle {
  const ms = resolveMotionStyle(visual, useMotionTheme());
  return {
    ...ms,
    enter: resolveThemedTransition(template, "enter", visual.enter, ms.feel.language),
    exit: resolveThemedTransition(template, "exit", visual.exit, ms.feel.language),
  };
}
