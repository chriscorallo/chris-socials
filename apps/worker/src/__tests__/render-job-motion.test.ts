import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditTimelineSchema, FFMPEG_PATH, type EditTimelineInput, type StorageAdapter } from "@chris/media";
import type { PrismaClient } from "@chris/domain";
import { prepareMotion, type MotionModule } from "../render-job";

/** prepareMotion with a fake motion module / db / storage: wiring + graceful degradation. */

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_PATH, args);
    let e = "";
    p.stderr.on("data", (c) => (e += c));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(e.slice(-800)))));
  });
}

describe("prepareMotion", () => {
  let dir: string;
  let source: string;
  const assets: Record<string, { id: string; kind: string; storageKey: string; originalFilename: string }> = {
    M: { id: "M", kind: "MUSIC", storageKey: "music/m.wav", originalFilename: "bed.wav" },
    R: { id: "R", kind: "RAW_TAKE", storageKey: "raw/r.mp4", originalFilename: "r.mp4" },
  };
  const db = { mediaAsset: { findUnique: async ({ where }: { where: { id: string } }) => assets[where.id] ?? null } } as unknown as PrismaClient;
  const storage: StorageAdapter = {
    put: async () => ({ url: "" }),
    get: async (key: string) => Buffer.from(`bytes-of-${key}`),
    signedUrl: async () => "",
    delete: async () => undefined,
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-prepare-motion-"));
    source = join(dir, "src.mp4");
    await ffmpeg(["-y", "-f", "lavfi", "-i", "color=c=gray:s=320x568:r=60:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
  }, 30000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const tl = (extra: Partial<EditTimelineInput> = {}) =>
    EditTimelineSchema.parse({
      version: 2,
      clips: [{ id: "c", mediaAssetId: "A", sourceStart: 0, sourceEnd: 3 }],
      captions: { enabled: false, fontId: "inter-display-bold", fontSize: 60, color: "#FFFFFF", highlightColor: "#FFD54A" },
      ...extra,
    });
  const visual = { id: "v1", template: "STAT_CARD", props: { value: "7%", label: "Return" }, start: 0.5, end: 2.5, placement: {} };

  function fakeMotion(calls: unknown[]): MotionModule {
    return {
      renderVisualsLayer: async (input) => {
        calls.push(input);
        return { framesRendered: 120, segments: [{ path: join(dir, "x.mov"), start: 0.5, end: 2.5, id: "v1" }], skipped: [], renderMs: 5 };
      },
      sfxFiles: () => ({ WHOOSH: "/kit/whoosh.wav" }),
    };
  }

  it("does nothing (and never loads the engine) without visuals, SFX or music", async () => {
    let loaded = false;
    const warnings: string[] = [];
    const r = await prepareMotion(db, storage, tl(), { A: source }, dir, warnings, { load: async () => ((loaded = true), fakeMotion([])) });
    expect(loaded).toBe(false);
    expect(r).toEqual({ visualsLayer: null, musicPath: null, sfxFiles: null, framesRendered: 0, renderMs: 0 });
    expect(warnings).toEqual([]);
  });

  it("renders the visuals layer at the renderer's fps and passes SFX + music through", async () => {
    const calls: Array<{ fps: number; durationSeconds: number }> = [];
    const warnings: string[] = [];
    const r = await prepareMotion(
      db, storage,
      tl({ visuals: [visual] as EditTimelineInput["visuals"], audio: { music: { musicAssetId: "M" } } as EditTimelineInput["audio"] }),
      { A: source }, dir, warnings, { load: async () => fakeMotion(calls) },
    );
    expect(warnings).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fps).toBe(60); // 60 fps source -> 60 fps master (chooseOutputFps)
    expect(calls[0]!.durationSeconds).toBe(3);
    expect(r.visualsLayer?.segments).toHaveLength(1);
    expect(r.framesRendered).toBe(120);
    expect(r.sfxFiles).toEqual({ WHOOSH: "/kit/whoosh.wav" });
    expect(r.musicPath).toMatch(/music\.wav$/);
    expect((await readFile(r.musicPath!)).toString()).toBe("bytes-of-music/m.wav");
  });

  it("degrades gracefully: engine failure, flag off, wrong music kind", async () => {
    const w1: string[] = [];
    const r1 = await prepareMotion(db, storage, tl({ visuals: [visual] as EditTimelineInput["visuals"] }), { A: source }, dir, w1, {
      load: async () => {
        throw new Error("no chrome here");
      },
    });
    expect(r1.visualsLayer).toBeNull();
    expect(w1.join("\n")).toMatch(/Motion engine unavailable \(no chrome here\)/);

    const w2: string[] = [];
    const calls: unknown[] = [];
    const r2 = await prepareMotion(db, storage, tl({ visuals: [visual] as EditTimelineInput["visuals"] }), { A: source }, dir, w2, { load: async () => fakeMotion(calls), visualsEnabled: false });
    expect(calls).toHaveLength(0);
    expect(r2.sfxFiles).not.toBeNull(); // entrance SFX still play
    expect(w2.join("\n")).toMatch(/visuals disabled by flag/);

    const w3: string[] = [];
    const r3 = await prepareMotion(db, storage, tl({ audio: { music: { musicAssetId: "R" } } as EditTimelineInput["audio"] }), { A: source }, dir, w3, {});
    expect(r3.musicPath).toBeNull();
    expect(w3.join("\n")).toMatch(/RAW_TAKE, not MUSIC/);
  });
});
