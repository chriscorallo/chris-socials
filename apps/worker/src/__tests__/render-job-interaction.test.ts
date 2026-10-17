import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditTimelineSchema, FFMPEG_PATH, type EditTimelineInput, type StorageAdapter, type VisualInteraction } from "@chris/media";
import { prisma, createContentItem, createMediaAsset } from "@chris/domain";
import { prepareInteraction, prepareMotion, type MotionModule } from "../render-job";
import { ensurePersonMattes } from "../person-matte-job";

/** Motion v2 worker wiring: render-time matte fallback, emphasis, scene stats → interactions. */

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_PATH, args);
    let e = "";
    p.stderr.on("data", (c) => (e += c));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(e.slice(-800)))));
  });
}

function memoryStorage(): StorageAdapter & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    put: async (key: string, data: Buffer) => {
      files.set(key, Buffer.from(data));
      return { url: key };
    },
    get: async (key: string) => {
      const f = files.get(key);
      if (!f) throw new Error(`missing ${key}`);
      return f;
    },
    signedUrl: async () => "",
    delete: async (key: string) => void files.delete(key),
  } as StorageAdapter & { files: Map<string, Buffer> };
}

describe("prepareInteraction + person-matte job", () => {
  let dir: string;
  let source: string;
  let fakeMatte: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-interaction-"));
    source = join(dir, "src.mp4");
    fakeMatte = join(dir, "fake-matte.mp4");
    // Bright warm picture + a loud tone on 1.0–1.4 s (the "emphasised" word).
    await ffmpeg([
      "-y", "-f", "lavfi", "-i", "color=c=0xE0B070:s=360x640:r=30:d=4",
      "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=4",
      "-filter_complex", "[1:a]volume='if(between(t,1.0,1.4),0.9,0.08)':eval=frame[a]",
      "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
    ]);
    await ffmpeg(["-y", "-f", "lavfi", "-i", "color=c=white:s=180x320:r=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", fakeMatte]);
  }, 60000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function setup() {
    const storage = memoryStorage();
    const item = await createContentItem(prisma, { title: "Interaction test" }, { actorId: "t" });
    const key = `raw/${item.id}/take.mp4`;
    const { readFile } = await import("node:fs/promises");
    await storage.put(key, await readFile(source), "video/mp4");
    const asset = await createMediaAsset(prisma, { contentItemId: item.id, kind: "RAW_TAKE", storageKey: key, originalFilename: "take.mp4", mimeType: "video/mp4", sizeBytes: 1 }, { actorId: "t" });
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { width: 360, height: 640, hasAudio: true } });
    return { storage, item, asset: await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }) };
  }

  const compute = async (_src: string, out: string) => {
    await copyFile(fakeMatte, out);
    return { outPath: out, width: 180, height: 320, fps: 30, frames: 120, coverage: 1, ms: 5, model: "fake" };
  };

  const words = [
    { word: "about", start: 0.4, end: 0.8 },
    { word: "24,500", start: 1.0, end: 1.4 },
    { word: "dollars", start: 1.8, end: 2.2 },
    { word: "today", start: 2.4, end: 2.8 },
  ];

  it("computes a missing matte at render time when a graphic is behind Chris, measures emphasis + scene, feeds the motion layer", async () => {
    const { storage, asset } = await setup();
    const timeline = EditTimelineSchema.parse({
      version: 2,
      canvas: { width: 1080, height: 1920 },
      clips: [{ id: "c", mediaAssetId: asset.id, sourceStart: 0, sourceEnd: 4 }],
      captions: { enabled: false, fontId: "inter-display-bold", fontSize: 60, color: "#FFFFFF", highlightColor: "#FFD54A" },
      visuals: [
        { id: "n", template: "NUMBER_COUNTER", props: { value: 24500, prefix: "$" }, start: 0.3, end: 3.6, placement: { mode: "MANUAL", x: 0.5, y: 0.3, scale: 1 }, depth: "BEHIND_SUBJECT" },
      ],
    } satisfies EditTimelineInput);
    const warnings: string[] = [];
    const sources = { [asset.id]: source };
    const prep = await prepareInteraction(prisma, storage, timeline, [asset], sources, { [asset.id]: words }, dir, warnings, { computeMatte: compute });
    expect(warnings).toEqual([]);
    expect(prep.report.mattesComputed).toBe(1);
    expect(prep.mattes[asset.id]).toMatch(/matte-.*\.mp4$/);
    const stored = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(stored.matteStorageKey).toBe(`mattes/${asset.contentItemId}/${asset.id}.mp4`);
    expect(storage.files.has(stored.matteStorageKey!)).toBe(true);
    // Emphasis: the loud number word.
    const loudest = [...prep.input.emphasisWords!].sort((a, b) => b.score - a.score)[0]!;
    expect(loudest.word).toBe("24,500");
    // Scene: warm, bright picture.
    const s = prep.input.sceneStats!.n!;
    expect(s.r).toBeGreaterThan(s.b + 40);
    expect(s.luma).toBeGreaterThan(0.5);

    const calls: Array<{ interactions?: Record<string, VisualInteraction> | null }> = [];
    const motion: MotionModule = {
      renderVisualsLayer: async (input) => {
        calls.push(input);
        return { framesRendered: 1, segments: [], skipped: [], renderMs: 1 };
      },
      sfxFiles: () => ({}),
    };
    await prepareMotion(prisma, storage, timeline, sources, dir, warnings, { load: async () => motion }, prep.input);
    const ix = calls[0]!.interactions!.n!;
    expect(ix.hitAtFrame).toBe(Math.round(1.04 * 30) - Math.round(0.3 * 30));
    expect(ix.look.gain.r).toBeGreaterThan(1);

    // ensurePersonMattes skips takes that already have one.
    const again = await ensurePersonMattes(prisma, storage, { contentItemId: asset.contentItemId }, { actorId: "t" }, { compute });
    expect(again.map((r) => r.status)).toEqual(["SKIPPED"]);
  }, 60000);

  it("matte failure → warning, render continues (graphic renders in front)", async () => {
    const { storage, asset } = await setup();
    const timeline = EditTimelineSchema.parse({
      version: 2,
      clips: [{ id: "c", mediaAssetId: asset.id, sourceStart: 0, sourceEnd: 4 }],
      captions: { enabled: false, fontId: "inter-display-bold", fontSize: 60, color: "#FFFFFF", highlightColor: "#FFD54A" },
      visuals: [{ id: "k", template: "KINETIC_TEXT", props: { text: "Debt free" }, start: 0.3, end: 3, placement: { mode: "MANUAL", x: 0.5, y: 0.3, scale: 1 }, depth: "BEHIND_SUBJECT" }],
    } satisfies EditTimelineInput);
    const warnings: string[] = [];
    const prep = await prepareInteraction(prisma, storage, timeline, [asset], { [asset.id]: source }, {}, dir, warnings, {
      computeMatte: async () => {
        throw new Error("model offline");
      },
    });
    expect(prep.mattes).toEqual({});
    expect(warnings.join("\n")).toMatch(/Person matte .* unavailable \(model offline\)/);
  }, 60000);
});
