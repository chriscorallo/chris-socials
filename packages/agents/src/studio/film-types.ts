/**
 * The slice of the cinema DSL (packages/cinema src/dsl/schema.ts, `dsl: 1`) the studio's
 * deterministic crew reads. Structural on purpose: packages/agents never imports the engine —
 * a film reaches these types only AFTER the engine's own validator accepted it (FilmEnginePort
 * .validateFilm), so the shape is guaranteed by the engine, not by a copy of its schema.
 */

export type Vec3 = [number, number, number];
export type StudioAnchor = number | "start" | "end" | { word: string; occurrence?: number; edge?: "start" | "end"; offset?: number } | { fraction: number };

export interface StudioActor {
  id: string;
  kind: string;
  position?: Vec3;
  scale?: number;
  visible?: boolean;
  params?: Record<string, unknown>;
  note?: string;
}

export type StudioAction =
  | { do: "ENTER"; actor: string; at: StudioAnchor; style?: string; duration?: number }
  | { do: "EXIT"; actor: string; at: StudioAnchor; style?: string; duration?: number }
  | { do: "MOVE"; actor: string; at: StudioAnchor; to: Vec3; duration?: number }
  | { do: "TURN"; actor: string; at: StudioAnchor; to: Vec3; duration?: number }
  | { do: "SCALE"; actor: string; at: StudioAnchor; to: number; duration?: number }
  | { do: "SET"; actor: string; at: StudioAnchor; param: string; to: unknown; duration?: number }
  | { do: "FLOW"; actor: string; at: StudioAnchor; into: string; amount: number; duration?: number }
  | { do: "PULSE"; actor: string; at: StudioAnchor; strength?: number; duration?: number }
  | { do: "GLOW"; actor: string; at: StudioAnchor; to: number; duration?: number };

export interface StudioCameraPose {
  distance?: number;
  azimuth?: number;
  elevation?: number;
  position?: Vec3;
  lookAt?: string | Vec3;
}

export interface StudioShot {
  id: string;
  line?: string;
  say?: string;
  duration?: number;
  hold?: number;
  leadIn?: number;
  camera: {
    rig: string;
    target: string | Vec3;
    from: StudioCameraPose | "CONTINUE";
    to?: StudioCameraPose;
    lens: { focalLength: number; fStop?: number; focus?: string | Vec3 };
  };
  actions?: StudioAction[];
  text?: Array<{ text: string; at: StudioAnchor; until?: StudioAnchor; style: string; position?: "UPPER" | "CENTER" | "LOWER"; countFrom?: number; strikeAt?: StudioAnchor; accent?: boolean }>;
  lighting?: { preset: string; blendSeconds?: number };
  post?: Record<string, unknown>;
  transitionOut?: { type: string; duration?: number };
  purpose?: string;
}

export interface StudioScene {
  id: string;
  set: { kind: string };
  shots: StudioShot[];
}

export interface StudioFilm {
  dsl: 1;
  id: string;
  title: string;
  logline?: string;
  format: { width: number; height: number; fps: number };
  look: string;
  narration?: { engine: "KOKORO" | "CHRIS"; voice: string; speed?: number };
  cast: StudioActor[];
  scenes: StudioScene[];
}

export interface FlatShot {
  shot: StudioShot;
  sceneId: string;
  sceneIndex: number;
  index: number;
}

export function flattenShots(film: StudioFilm): FlatShot[] {
  const out: FlatShot[] = [];
  film.scenes.forEach((scene, sceneIndex) => scene.shots.forEach((shot) => out.push({ shot, sceneId: scene.id, sceneIndex, index: out.length })));
  return out;
}
