/**
 * @chris/motion — the motion-graphics engine (Node entry). Renders `EditTimeline.visuals` with
 * Remotion (React + three.js) to alpha clips that packages/media's renderTimeline composites,
 * and ships the procedural SFX kit. Browser preview: `@chris/motion/player`. Pure helpers:
 * `@chris/motion/pure`. Decisions: docs/decisions-pending/motion-engine.md.
 */
export * from "./timing";
export * from "./samples";
export * from "./style";
export { renderVisualsLayer, renderVisualBake, getMotionBundle, findLocalHeadlessShell, type RenderVisualsLayerInput, type RenderVisualsLayerResult, type RenderVisualBakeInput } from "./render";
export { resolveSfxDir, sfxFiles, sfxFileName, resolveRemotionEntry } from "./assets";
