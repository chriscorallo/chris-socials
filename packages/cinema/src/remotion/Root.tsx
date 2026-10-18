import { Composition, type CalculateMetadataFunction } from "remotion";
import { resolveFilm } from "../timing";
import { PROOF_FILM } from "../films/the-raise";
import { MiniMovie, type MiniMovieProps } from "./MiniMovie";

export const CINEMA_COMPOSITION_ID = "MiniMovie";

/** Output size per tier: DRAFT renders at half resolution (storyboards, fast iteration). */
export function tierScale(tier: MiniMovieProps["tier"]): number {
  return tier === "DRAFT" ? 0.5 : 1;
}

const metadata: CalculateMetadataFunction<MiniMovieProps> = ({ props }) => {
  const rf = resolveFilm(props.film, props.clips);
  const s = tierScale(props.tier);
  return {
    fps: props.film.format.fps,
    durationInFrames: rf.totalFrames,
    width: Math.round((props.film.format.width * s) / 2) * 2,
    height: Math.round((props.film.format.height * s) / 2) * 2,
  };
};

export function CinemaRoot() {
  return (
    <Composition
      id={CINEMA_COMPOSITION_ID}
      component={MiniMovie}
      defaultProps={{ film: PROOF_FILM, clips: null, tier: "DRAFT", fontBaseUrl: null } satisfies MiniMovieProps}
      calculateMetadata={metadata}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={300}
    />
  );
}
