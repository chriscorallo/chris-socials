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
export * from "./motion-contract";
