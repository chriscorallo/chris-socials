/**
 * Storage adapter interface. Real from Phase 1 (raw upload); a local-fs implementation now,
 * a Vercel Blob implementation later — swappable by config, not by rewrite. See
 * /docs/ARCHITECTURE.md.
 */
export interface StorageAdapter {
  put(key: string, data: Buffer | Uint8Array, contentType?: string): Promise<{ url: string }>;
  get(key: string): Promise<Buffer>;
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}

export const PHASE_INTRODUCED = 1;

export { LocalFsStorageAdapter } from "./local-fs-adapter";
export type { LocalFsStorageAdapterOptions } from "./local-fs-adapter";

export * from "./ffmpeg-paths";
export * from "./probe";
export * from "./render";
export * from "./technical-qc";
export * from "./frame-extractor";
export * from "./overlay-collision";
export * from "./fonts";
export * from "./safe-zones";
export * from "./text-layout";
export * from "./overlay-layout";
export * from "./captions";
export * from "./timeline";
export * from "./font-registry";
export * from "./timeline-captions";
export * from "./font-metrics";
export * from "./timeline-layout";
export * from "./timeline-render";
export * from "./plan-to-timeline";
export * from "./platform-profiles";
export * from "./platform-variant";
export * from "./motion-contract";
export * from "./subject-track-core";
export * from "./subject-track";
export * from "./visual-footprints";
export * from "./visual-placement";
export * from "./visual-interaction";
export * from "./person-matte";
export * from "./scene-analysis";
export * from "./style-analysis";
export * from "./style-cut";
export * from "./speech-activity";
export * from "./viewer-audio";
export * from "./graphics/contract";
export * from "./graphics/presets";
