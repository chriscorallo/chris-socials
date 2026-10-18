/**
 * @chris/cinema — mini-movies: a Story/Scene DSL rendered as cinematic procedural 3D by
 * Remotion + three.js, with local Kokoro narration, a generated score and a −14 LUFS mix.
 * Decision record: docs/decisions-pending/mini-movies.md.
 */
export * from "./pure";
export { renderFilm, getCinemaBundle, scorePlanFor, rendererGl, type RenderFilmOptions, type RenderFilmReport } from "./render";
export { narrateFilm } from "./narration/narrate";
export { synthesizeLine, loadKokoro, KOKORO_MODEL_ID } from "./narration/kokoro";
export { renderScore, encodeStereoWav, duckEnvelope, progression, type ScorePlan } from "./audio/score";
export { mixFilm, voiceBusArgs, premixArgs, TARGET_LUFS } from "./audio/mix";
export { measureLoudness } from "./audio/ffmpeg";
export { cinemaSfxFiles } from "./audio/sfx";
