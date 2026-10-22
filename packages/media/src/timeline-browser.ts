/**
 * Browser-safe entry point for the finishing editor (`@chris/media/timeline`): the Timeline
 * schema/math, the font registry, and caption chunking — nothing here imports Node, ffmpeg or
 * the filesystem. The server renderer imports the same modules via `@chris/media`.
 */
export * from "./timeline";
export * from "./font-registry";
export * from "./caption-chunking";
export * from "./timeline-captions";
export * from "./font-metrics";
export * from "./timeline-layout";
export * from "./platform-profiles";
export * from "./platform-ui";
export * from "./motion-contract";
export * from "./subject-track-core";
export * from "./visual-footprints";
export * from "./visual-placement";
export * from "./visual-interaction";
export * from "./style-cut";
export * from "./full-edit";
export * from "./screen";
export * from "./preview-plan";
export * from "./graphic-bake";
export * from "./graphics/contract";
export * from "./graphics/presets";
export * from "./graphics/quick-entry";
export * from "./graphics/search";
export * from "./graphics/suggest";
export * from "./director";
