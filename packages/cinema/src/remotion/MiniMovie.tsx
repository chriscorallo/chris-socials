import { ThreeCanvas } from "@remotion/three";
import { useEffect, useMemo, useState } from "react";
import { AbsoluteFill, cancelRender, continueRender, delayRender, getRemotionEnvironment, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";
import type { Film } from "../dsl/schema";
import { compileFilm, evaluateFrame } from "../evaluate";
import { LOOK_DEFS } from "../looks";
import { resolveFilm, type LineClip } from "../timing";
import { FONT_FILES, Overlay } from "./overlay";
import { World, type Tier } from "./world/World";

export interface MiniMovieProps extends Record<string, unknown> {
  film: Film;
  /** Narration clips per shot id (measured timing). null = estimated timing (storyboard). */
  clips: Record<string, LineClip> | null;
  tier: Tier;
  /** Base URL for fonts in the browser player; null = staticFile("fonts/…") in a render. */
  fontBaseUrl?: string | null;
}

const loaded = new Map<string, Promise<void>>();
function useFonts(base: string | null | undefined): boolean {
  const [ready, setReady] = useState(false);
  const [handle] = useState(() => delayRender("cinema fonts", { timeoutInMilliseconds: 60000 }));
  useEffect(() => {
    Promise.all(
      FONT_FILES.map((f) => {
        const url = base ? `${base.replace(/\/$/, "")}/${f.file}` : staticFile(`fonts/${f.file}`);
        const key = `${f.family}|${url}`;
        let p = loaded.get(key);
        if (!p) {
          const face = new FontFace(f.family, `url("${url}") format("truetype")`, { weight: String(f.weight) });
          // Canvas textures (cards, labels) ask for "Inter"/"Inter Display" by name.
          const alias = f.file.startsWith("Inter-") ? new FontFace("Inter", `url("${url}")`, { weight: "600" }) : f.file === "InterDisplay-ExtraBold.ttf" ? new FontFace("Inter Display", `url("${url}")`, { weight: "800" }) : null;
          p = Promise.all([face.load(), alias?.load()]).then(([a, b]) => {
            document.fonts.add(a);
            if (b) document.fonts.add(b);
          });
          loaded.set(key, p);
        }
        return p;
      }),
    )
      .catch((err) => {
        if (getRemotionEnvironment().isRendering) cancelRender(err);
      })
      .finally(() => {
        setReady(true);
        continueRender(handle);
      });
  }, [base, handle]);
  return ready;
}

export function MiniMovie({ film, clips, tier, fontBaseUrl }: MiniMovieProps) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const fontsReady = useFonts(fontBaseUrl);
  const cf = useMemo(() => compileFilm(resolveFilm(film, clips)), [film, clips]);
  const state = evaluateFrame(cf, frame);
  const look = LOOK_DEFS[film.look];
  if (!fontsReady) return <AbsoluteFill style={{ background: look.background }} />;
  const draftBlur = tier === "DRAFT" && state.overlay.blur > 0.02 ? `blur(${state.overlay.blur * 20 * (width / 1080)}px)` : undefined;
  return (
    <AbsoluteFill style={{ background: look.background }}>
      <AbsoluteFill style={{ filter: draftBlur }}>
        <ThreeCanvas
          width={width}
          height={height}
          gl={{ antialias: false, preserveDrawingBuffer: true, powerPreference: "high-performance", stencil: false }}
          camera={{ fov: 40, near: 0.05, far: 300, position: [0, 2, 8] }}
          shadows
          onCreated={({ gl }) => {
            gl.outputColorSpace = THREE.SRGBColorSpace;
            gl.toneMapping = THREE.NoToneMapping;
          }}
        >
          <World state={state} look={look} seed={cf.seed} tier={tier} />
        </ThreeCanvas>
      </AbsoluteFill>
      <AbsoluteFill style={{ opacity: 1 - state.overlay.black }}>
        <Overlay state={state} look={look} width={width} height={height} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
