/**
 * @chris/cinema — mini-movies: a Story/Scene DSL rendered as cinematic procedural 3D by
 * Remotion + three.js, with local Kokoro narration (or Chris's own recording), a generated score
 * and a −14 LUFS mix. Interface: packages/cinema/README.md. Decisions:
 * docs/decisions-pending/studio-engine.md.
 */
export * from "./pure";
export {
  renderFilm,
  prepareFilm,
  renderFilmFrames,
  assembleFilm,
  tierEncoding,
  getCinemaBundle,
  scorePlanFor,
  rendererGl,
  ChrisNarrationMissingError,
  FilmAssemblyError,
  type RenderFilmOptions,
  type RenderFilmReport,
  type PreparedFilm,
} from "./render";
export { renderStoryboard, keyframesForShot, type StoryboardResult, type StoryboardShot, type StoryboardStill } from "./storyboard";
export { narrateFilm, defaultTranscriber, type NarratedLine, type WordTranscriber } from "./narration/narrate";
export { narrationFromRecording, alignRecordingWords, MIN_MATCHED_RATIO, type RecordingAlignmentReport, type AlignedShot } from "./narration/recording";
export { synthesizeLine, loadKokoro, KOKORO_MODEL_ID } from "./narration/kokoro";
export { matchLineToCatalog, embedTexts, warmCatalogMatcher, CATALOG_EMBEDDING_MODEL, type CatalogMatch } from "./catalog-match";
export { renderScore, encodeStereoWav, duckEnvelope, progression, type ScorePlan } from "./audio/score";
export { mixFilm, voiceBusArgs, premixArgs, TARGET_LUFS } from "./audio/mix";
export { measureLoudness, probeMedia } from "./audio/ffmpeg";
export { cinemaSfxFiles } from "./audio/sfx";
