import { FONT_DEFAULT_INDEX, FONT_SIZES, SPEED_DEFAULT, SPEED_MAX, SPEED_MIN } from "./scroll";
import type { Facing, Quality } from "./recording";
import type { SavedPrompterEdit } from "./script-source";

/**
 * Prompter preferences — a per-phone convenience (localStorage), never persisted server-side.
 * Every read/write is wrapped: private mode / blocked storage just means defaults.
 */
export interface PrompterSettings {
  fontIndex: number;
  speed: number;
  /** Flip the TEXT horizontally (for a real teleprompter glass/beam-splitter rig). */
  mirrorText: boolean;
  /** In-app recording: the text only moves while a take is recording. */
  scrollOnlyWhileRecording: boolean;
  countdown: boolean;
  /** Echo cancel / noise suppression / auto gain — off by default for a natural voice. */
  voiceCleanup: boolean;
  facing: Facing;
  quality: Quality;
  fps: 30 | 60;
  /** Floating script (PiP): text size step and the delay before it starts scrolling. */
  pipFontIndex: number;
  pipDelaySec: 0 | 5 | 10;
}

export const PIP_FONT_SIZES = [56, 68, 80, 96, 112] as const;

export const DEFAULT_SETTINGS: PrompterSettings = {
  fontIndex: FONT_DEFAULT_INDEX,
  speed: SPEED_DEFAULT,
  mirrorText: false,
  scrollOnlyWhileRecording: true,
  countdown: true,
  voiceCleanup: false,
  facing: "user",
  quality: "1080",
  fps: 30,
  pipFontIndex: 2,
  pipDelaySec: 10,
};

const KEY = "tp:settings:v1";
const editKey = (id: string) => `tp:edit:${id}`;

/** Merges whatever was stored with the defaults, dropping anything out of range. */
export function sanitizeSettings(raw: unknown): PrompterSettings {
  const s = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return s;
  const r = raw as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
  s.fontIndex = int(r.fontIndex, 0, FONT_SIZES.length - 1) ?? s.fontIndex;
  s.speed = int(r.speed, SPEED_MIN, SPEED_MAX) ?? s.speed;
  s.pipFontIndex = int(r.pipFontIndex, 0, PIP_FONT_SIZES.length - 1) ?? s.pipFontIndex;
  for (const k of ["mirrorText", "scrollOnlyWhileRecording", "countdown", "voiceCleanup"] as const) {
    if (typeof r[k] === "boolean") s[k] = r[k] as boolean;
  }
  if (r.facing === "user" || r.facing === "environment") s.facing = r.facing;
  if (r.quality === "1080" || r.quality === "4k") s.quality = r.quality;
  if (r.fps === 30 || r.fps === 60) s.fps = r.fps;
  if (r.pipDelaySec === 0 || r.pipDelaySec === 5 || r.pipDelaySec === 10) s.pipDelaySec = r.pipDelaySec;
  return s;
}

export function loadSettings(): PrompterSettings {
  try {
    return sanitizeSettings(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: PrompterSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage unavailable — settings just won't stick
  }
}

export function loadEdit(id: string): SavedPrompterEdit | null {
  try {
    const v = JSON.parse(localStorage.getItem(editKey(id)) ?? "null");
    return v && typeof v.base === "string" && typeof v.text === "string" ? v : null;
  } catch {
    return null;
  }
}

export function saveEdit(id: string, edit: SavedPrompterEdit | null): void {
  try {
    if (edit) localStorage.setItem(editKey(id), JSON.stringify(edit));
    else localStorage.removeItem(editKey(id));
  } catch {
    // ignore
  }
}
